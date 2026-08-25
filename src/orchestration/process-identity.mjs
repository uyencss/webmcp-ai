import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const execFileAsyncBound = (file, args, timeoutMs) => new Promise((resolvePromise, rejectPromise) => {
  const child = execFile(file, args, { shell: false, timeout: timeoutMs }, (error, stdout, stderr) => {
    // Deterministically release every stdio pipe: a settled-but-unreferenced
    // probe child must never leave an open handle that pins the owner loop.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try { stream?.destroy(); } catch { /* already gone */ }
    }
    if (error) rejectPromise(error);
    else resolvePromise({ stdout, stderr });
  });
});

function execBounded(file, args, timeoutMs = 2000) {
  return execFileAsyncBound(file, args, timeoutMs);
}

async function darwinProbes(pid) {
  const { stdout } = await execBounded('ps', ['-o', 'lstart=', '-o', 'pgid=', '-p', String(pid)]);
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const startIdentity = lines.length > 0 ? `darwin:${lines[0]}` : null;
  // lstart and pgid share one output line; the group id is the trailing int.
  const pgidCandidate = [...lines].reverse().find((line) => /^\d+$/.test(line))
    ?? lines.map((line) => line.match(/(\d+)$/)?.[1]).find(Boolean);
  return {
    startIdentity,
    processGroupId: pgidCandidate ? Number.parseInt(pgidCandidate, 10) : null,
  };
}

async function linuxProbes(pid) {
  const statPath = `/proc/${pid}/stat`;
  if (!existsSync(statPath)) return { startIdentity: null, processGroupId: null };
  const stat = readFileSync(statPath, 'utf8');
  const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // afterComm[1] is pgrp (field 5); afterComm[19] is starttime (field 22).
  const pgrp = Number.parseInt(afterComm[2], 10);
  const starttime = Number.parseInt(afterComm[19], 10);
  return {
    startIdentity: Number.isFinite(starttime) ? `linux:${starttime}` : null,
    processGroupId: Number.isFinite(pgrp) ? pgrp : null,
  };
}

async function win32Probes(pid) {
  // Bounded CIM query fixture for Windows; remains fixture-only until a
  // Windows canary receipt exists.
  const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object CreationDate,ProcessId | ConvertTo-Json -Compress)`;
  const { stdout } = await execBounded('powershell.exe', ['-NoProfile', '-Command', script], 5000);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { startIdentity: null, processGroupId: null };
  }
  const created = parsed?.CreationDate ? `win32:${JSON.stringify(parsed.CreationDate)}` : null;
  return { startIdentity: created, processGroupId: parsed?.ProcessId ?? null };
}

/** Platform-specific identity probes; every launch uses argv arrays only. */
export function createPlatformIdentityDeps(platform = process.platform) {
  const probes = platform === 'darwin'
    ? darwinProbes
    : platform === 'linux'
      ? linuxProbes
      : win32Probes;
  return {
    platform,
    async getStartIdentity(targetPid) {
      try {
        return (await probes(targetPid)).startIdentity;
      } catch {
        return null;
      }
    },
    async getProcessGroupId(targetPid) {
      try {
        return (await probes(targetPid)).processGroupId;
      } catch {
        return null;
      }
    },
    getRuntimeNonce: () => null,
  };
}

/**
 * Assemble a proven process identity. Any indeterminate component yields null:
 * unprovable identity never authorizes signalling or stale-lock removal.
 */
export async function readProcessIdentity(pid, deps = {}) {
  const startIdentity = deps.getStartIdentity ? await deps.getStartIdentity(pid) : null;
  const processGroupId = deps.getProcessGroupId ? await deps.getProcessGroupId(pid) : null;
  const runtimeNonce = deps.getRuntimeNonce ? await deps.getRuntimeNonce(pid) : null;
  if (!startIdentity || !Number.isFinite(processGroupId) || !runtimeNonce) {
    return null;
  }
  return { pid, startIdentity, processGroupId, runtimeNonce };
}

/**
 * Prove whether a POSIX process group is EMPTY via a signal-0 probe against
 * the negated group id (`kill(-pgid, 0)`). This is the ONLY proof strong
 * enough to authorize a "the group is gone" disposition: a group LEADER
 * that exited honestly (or was itself the only signalled member) proves
 * NOTHING about grandchildren that ignored the same signal and are still
 * parented inside the group. A ladder that stops escalating merely because
 * the leader's own `exit` event fired is exactly the bug this probe closes.
 *
 * Return values:
 *   'empty'       - ESRCH: no process anywhere shares this group id. The
 *                   group is PROVEN EMPTY; this is the only value that may
 *                   authorize an exit-proven, group-level disposition.
 *   'alive'       - either the kernel found at least one live member (no
 *                   throw), or the probe threw EPERM. EPERM means the group
 *                   EXISTS but signalling was refused — that is NOT
 *                   evidence of absence, so it is folded into 'alive' and
 *                   must be treated exactly like "still alive": escalate
 *                   or park for retry, never settle.
 *   'unsupported' - there is no POSIX process-group primitive to probe:
 *                   win32 (no process groups; no Job Object wired up yet
 *                   in this runtime), or no valid group id was ever
 *                   recorded. Callers must fall back to pid-only proof and
 *                   must NEVER read 'unsupported' as evidence of emptiness.
 */
export function proveProcessGroupEmpty(groupId, platform = process.platform) {
  if (platform === 'win32') return 'unsupported';
  if (!Number.isInteger(groupId) || groupId <= 1) return 'unsupported';
  try {
    process.kill(-groupId, 0);
    return 'alive';
  } catch (error) {
    if (error && error.code === 'ESRCH') return 'empty';
    // EPERM or any other unexpected errno: never proof of absence.
    return 'alive';
  }
}

/**
 * Cheap liveness probe for a bare pid (signal 0). Used to detect whether a
 * NUMERIC pid our records point at is currently occupied by ANY process —
 * ours or, after enough real time has passed, an unrelated one that the OS
 * happened to recycle it onto.
 */
export function isPidLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bounded-retry wrapper around proveProcessGroupEmpty: a group that was
 * just SIGKILLed can show 'alive' for a few milliseconds purely because the
 * kernel has not reaped it yet, not because anything survived. This polls
 * a SHORT, FIXED budget before giving up — it never trades away the
 * fail-closed contract: if the deadline is reached and the group still
 * reads 'alive' (or the probe is 'unsupported'), that exact value is
 * returned, unchanged, and the caller must still treat it as unproven.
 */
export async function awaitProcessGroupEmpty(groupId, platform = process.platform, options = {}) {
  const timeoutMs = options.timeoutMs ?? 500;
  const intervalMs = options.intervalMs ?? 30;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const proof = proveProcessGroupEmpty(groupId, platform);
    if (proof !== 'alive') return proof;
    if (Date.now() >= deadline) return proof;
    await new Promise((resolveTick) => setTimeout(resolveTick, intervalMs));
  }
}
