import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function execBounded(file, args, timeoutMs = 2000) {
  return execFileAsync(file, args, { shell: false, timeout: timeoutMs });
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
