import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { buildSafeChildEnv } from './capabilities.mjs';
import { AiCliError } from './errors.mjs';
import { classifyProviderExit, runProcess } from './process-runner.mjs';

// Declared trusted registry of remote Claude hosts. This is code, not request
// data: a caller can only ever select among these ids (see selectClaudeHost);
// nothing in a request body can add or widen an entry. R1 scope is registry +
// selection + a bounded read-only probe only; a worker/run/fingerprint
// protocol is out of scope until a later round extends this module.
const CLAUDE_REMOTE_HOSTS = Object.freeze({
  m1: Object.freeze({
    id: 'm1',
    sshHost: 'mac-pro14',
    binary: '/Users/ttcenter/.local/bin/claude',
    worker: '/Users/ttcenter/.webmcp-ai/claude-remote-worker.mjs',
    workspaceRoot: '/Users/ttcenter/Desktop/VIBE_CODE',
    nodeBin: 'node',
  }),
});

// Operator env overrides per declared field. An override replaces the
// declared value for that field only; it can never introduce a host id that
// is not already declared above.
const HOST_ENV_OVERRIDES = Object.freeze({
  sshHost: 'WEBMCP_AI_CLAUDE_SSH_ALIAS',
  binary: 'WEBMCP_AI_CLAUDE_REMOTE_BIN',
  worker: 'WEBMCP_AI_CLAUDE_REMOTE_WORKER',
  workspaceRoot: 'WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE',
  nodeBin: 'WEBMCP_AI_CLAUDE_REMOTE_NODE',
});

const SSH_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Every validation failure is bounded to the field name only. The value that
// failed validation (an operator env override, or a mis-declared registry
// entry) must never reach an error message or details payload: it could be
// host/user-shaped and is not safe to echo back to a caller or log sink.
function invalidConfig(field) {
  return new AiCliError('CLAUDE_REMOTE_CONFIG_INVALID', 'Claude remote host configuration is invalid', {
    exitCode: 2,
    details: { field },
  });
}

function validateSshHost(value, field) {
  if (typeof value !== 'string' || !SSH_HOST_PATTERN.test(value)) {
    throw invalidConfig(field);
  }
  return value;
}

// ssh joins the post-host argv into a remote shell command, so an override
// path containing shell metacharacters (`; $() | && ...`) would be
// interpreted remotely rather than treated as an opaque path segment. Reject
// whitespace, the standard shell metacharacter set, and control characters
// outright; only a plain absolute path (letters/digits/`/._-` and similar
// unambiguous punctuation) is accepted.
const UNSAFE_PATH_CHARS = /[\s`;$&|<>"'\\*?!~#(){}[\]\u0000-\u001f\u007f]/;

function validateAbsolutePath(value, field) {
  if (typeof value !== 'string' || !value) throw invalidConfig(field);
  if (value.includes('\0')) throw invalidConfig(field);
  if (UNSAFE_PATH_CHARS.test(value)) throw invalidConfig(field);
  if (!value.startsWith('/')) throw invalidConfig(field);
  const segments = value.split('/').filter(Boolean);
  if (segments.includes('..')) throw invalidConfig(field);
  return value;
}

function validateNodeBin(value, field) {
  if (typeof value !== 'string' || !value) throw invalidConfig(field);
  if (value.includes('\0')) throw invalidConfig(field);
  if (UNSAFE_PATH_CHARS.test(value)) throw invalidConfig(field);
  if (value.startsWith('/')) {
    const segments = value.split('/').filter(Boolean);
    if (segments.includes('..')) throw invalidConfig(field);
    return value;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw invalidConfig(field);
  }
  return value;
}

/** Every declared registry entry, shallow-copied (no live references out). */
export function listClaudeRemoteHosts() {
  return Object.values(CLAUDE_REMOTE_HOSTS).map((host) => ({ ...host }));
}

/**
 * Merge the declared host entry with operator env overrides and validate
 * strictly. Fails closed with typed CLAUDE_REMOTE_CONFIG_INVALID; the
 * message/details never carry the raw invalid value.
 */
export function resolveClaudeRemoteHost(id, env = process.env) {
  const declared = CLAUDE_REMOTE_HOSTS[String(id || '')];
  if (!declared) throw invalidConfig('hostId');
  const safeEnv = env || {};
  const sshHost = safeEnv[HOST_ENV_OVERRIDES.sshHost] ?? declared.sshHost;
  const binary = safeEnv[HOST_ENV_OVERRIDES.binary] ?? declared.binary;
  const worker = safeEnv[HOST_ENV_OVERRIDES.worker] ?? declared.worker;
  const workspaceRoot = safeEnv[HOST_ENV_OVERRIDES.workspaceRoot] ?? declared.workspaceRoot;
  const nodeBin = safeEnv[HOST_ENV_OVERRIDES.nodeBin] ?? declared.nodeBin;
  return {
    id: declared.id,
    sshHost: validateSshHost(sshHost, 'sshHost'),
    binary: validateAbsolutePath(binary, 'binary'),
    worker: validateAbsolutePath(worker, 'worker'),
    workspaceRoot: validateAbsolutePath(workspaceRoot, 'workspaceRoot'),
    nodeBin: validateNodeBin(nodeBin, 'nodeBin'),
  };
}

/**
 * Resolve which Claude host a request should use. Unset/empty/'local' means
 * local (today's default, unchanged); a declared host id selects that host;
 * anything else fails closed. This is the only place a request-shaped value
 * (WEBMCP_AI_CLAUDE_HOST) can influence host selection, and it can only ever
 * select an id already present in the code-declared registry.
 */
export function selectClaudeHost(env = process.env) {
  const raw = env?.WEBMCP_AI_CLAUDE_HOST;
  const trimmed = raw == null ? '' : String(raw).trim();
  if (!trimmed || trimmed.toLowerCase() === 'local') return 'local';
  if (Object.prototype.hasOwnProperty.call(CLAUDE_REMOTE_HOSTS, trimmed)) return trimmed;
  throw invalidConfig('WEBMCP_AI_CLAUDE_HOST');
}

/** Test/operator seam: override the ssh binary itself. Defaults to 'ssh'. */
export function resolveSshBin(env = process.env) {
  return (env && env.WEBMCP_AI_SSH_BIN) || 'ssh';
}

/**
 * Argv-only ssh option set (never a shell string): batch mode (no
 * interactive prompt), strict host key checking (fail closed on an unknown
 * or changed host key rather than silently trusting it), a bounded connect
 * timeout, and keepalive so a half-open connection is detected instead of
 * hanging for the full process timeout.
 */
export function buildSshArgs(sshHost, { connectTimeoutSeconds = 6 } = {}) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `ConnectTimeout=${connectTimeoutSeconds}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    sshHost,
  ];
}

function buildSshChildEnv(env) {
  return {
    ...buildSafeChildEnv(env, {}),
    ...(env && env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: env.SSH_AUTH_SOCK } : {}),
  };
}

const SSH_ERROR_REASONS = Object.freeze({
  CLI_NOT_INSTALLED: 'ssh-not-installed',
  PROVIDER_TIMEOUT: 'timeout',
  PROVIDER_OUTPUT_LIMIT: 'output-limit',
  PROVIDER_SPAWN_ERROR: 'spawn-failed',
  PROVIDER_ABORTED: 'aborted',
  PROVIDER_EXIT_ERROR: 'exit-error',
});

// Every ssh/transport failure (missing binary, non-zero exit, timeout, host
// key mismatch, DNS failure, connection refused, ...) collapses to one typed
// error with a bounded reason code. Raw ssh stderr, absolute paths, and
// host/user strings must never reach `details` or `message`.
function mapSshError(error, hostId) {
  const reason = SSH_ERROR_REASONS[error?.code] || 'unreachable';
  return new AiCliError('CLAUDE_REMOTE_UNREACHABLE', 'Remote Claude host is unreachable', {
    exitCode: 2,
    retryable: true,
    details: { host: hostId, reason },
  });
}

/**
 * Bounded read-only probe: `<ssh> ... <binary> --version` then
 * `<ssh> ... <binary> --help`, each capped at 256 KiB output. No worker
 * protocol, no run, no fingerprint — R1 scope only. Every failure mode maps
 * to typed CLAUDE_REMOTE_UNREACHABLE; this function never falls back to a
 * local binary.
 */
export async function probeRemoteClaude({ hostId, env = process.env, timeoutMs = 8000 }) {
  const host = resolveClaudeRemoteHost(hostId, env);
  const sshBin = resolveSshBin(env);
  const sshArgs = buildSshArgs(host.sshHost);
  const sshEnv = buildSshChildEnv(env);
  const perCallTimeoutMs = Math.max(1000, Math.floor(timeoutMs / 2));

  let versionResult;
  try {
    versionResult = await runProcess(sshBin, [...sshArgs, host.binary, '--version'], {
      env: sshEnv, timeoutMs: perCallTimeoutMs, maxOutputBytes: 256 * 1024,
    });
  } catch (error) {
    throw mapSshError(error, hostId);
  }

  let helpResult;
  try {
    helpResult = await runProcess(sshBin, [...sshArgs, host.binary, '--help'], {
      env: sshEnv, timeoutMs: perCallTimeoutMs, maxOutputBytes: 256 * 1024,
    });
  } catch (error) {
    throw mapSshError(error, hostId);
  }

  return {
    available: true,
    version: `${versionResult.stdout}\n${versionResult.stderr}`.trim(),
    helpText: `${helpResult.stdout}\n${helpResult.stderr}`,
  };
}

export function extractSemverToken(text) {
  const match = String(text ?? '').match(/(?:(?<=\bv)|\b)\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match ? match[0] : null;
}

// Self-contained (never imports from providers/install.mjs, which imports
// this module) mirror of the local-install pin matcher: exact semver-token
// equality only, never a substring match.
function remoteVersionMatchesPin(output, pin) {
  if (!pin || typeof pin !== 'string') return false;
  const tokens = String(output ?? '').match(/(?:(?<=\bv)|\b)\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g) ?? [];
  const cleanPin = pin.startsWith('v') ? pin.slice(1) : pin;
  return tokens.includes(pin) || tokens.includes(cleanPin);
}

/**
 * Non-throwing variant of probeRemoteClaude for the install manifest: never
 * rejects (a probe or config failure resolves to state 'unreachable' so a
 * `providers install --plan --host m1` never crashes), and `match` requires
 * the probed version to equal `pin`. `timeoutMs`, when provided, is forwarded
 * verbatim to probeRemoteClaude (which still fails closed on any transport
 * error, including timeout, into typed CLAUDE_REMOTE_UNREACHABLE caught
 * below); omitting it keeps probeRemoteClaude's own default (8000ms).
 */
export async function readRemoteClaudeState({
  hostId, env = process.env, pin, timeoutMs,
} = {}) {
  let probe;
  try {
    probe = await probeRemoteClaude({ hostId, env, timeoutMs });
  } catch (error) {
    if (error?.code === 'CLAUDE_REMOTE_UNREACHABLE' || error?.code === 'CLAUDE_REMOTE_CONFIG_INVALID') {
      return { state: 'unreachable', installedVersion: null, transport: 'ssh' };
    }
    throw error;
  }
  const installedVersion = extractSemverToken(probe.version);
  if (!installedVersion) {
    return { state: 'missing', installedVersion: null, transport: 'ssh' };
  }
  if (remoteVersionMatchesPin(probe.version, pin)) {
    return { state: 'match', installedVersion, transport: 'ssh' };
  }
  return { state: 'drift', installedVersion, transport: 'ssh' };
}

const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024; // 1 MiB

function validateMappingPair(pair, field) {
  if (typeof pair !== 'string' || !pair) throw invalidConfig(field);
  const eqIdx = pair.indexOf('=');
  if (eqIdx <= 0 || eqIdx >= pair.length - 1) throw invalidConfig(field);
  const local = pair.slice(0, eqIdx);
  const remote = pair.slice(eqIdx + 1);
  validateAbsolutePath(local, field);
  validateAbsolutePath(remote, field);
  return { local, remote };
}

/**
 * Longest-prefix match over declared mapping pairs.
 * Default: /Users/ttcenter/Desktop/VIBE_CODE -> /Users/uyenuyen/Desktop/VIBE_CODE
 * Operator override: WEBMCP_AI_CLAUDE_REMOTE_MAP = local=remote
 */
export function mapWorkspaceToRemote({ hostId, env = process.env, localWorkspace }) {
  if (localWorkspace === null || localWorkspace === undefined) return null;
  if (typeof localWorkspace !== 'string' || !localWorkspace) {
    throw new AiCliError('CLAUDE_REMOTE_WORKSPACE_UNMAPPED', 'Local workspace cannot be mapped to remote host', {
      exitCode: 2,
      details: { host: hostId },
    });
  }

  const pairs = [];
  const override = env?.WEBMCP_AI_CLAUDE_REMOTE_MAP;
  if (override !== undefined && override !== null && override !== '') {
    pairs.push(validateMappingPair(override, 'WEBMCP_AI_CLAUDE_REMOTE_MAP'));
  }
  pairs.push({
    local: '/Users/ttcenter/Desktop/VIBE_CODE',
    remote: '/Users/uyenuyen/Desktop/VIBE_CODE',
  });

  // Longest prefix match
  pairs.sort((a, b) => b.local.length - a.local.length);

  for (const { local, remote } of pairs) {
    if (localWorkspace === local) return remote;
    const prefix = local.endsWith('/') ? local : `${local}/`;
    if (localWorkspace.startsWith(prefix)) {
      const rel = localWorkspace.slice(prefix.length);
      return remote.endsWith('/') ? `${remote}${rel}` : `${remote}/${rel}`;
    }
  }

  throw new AiCliError('CLAUDE_REMOTE_WORKSPACE_UNMAPPED', 'Local workspace cannot be mapped to remote host', {
    exitCode: 2,
    details: { host: hostId },
  });
}

/**
 * Local implementation of the exact worker fingerprint algorithm:
 * git rev-parse HEAD, git rev-parse HEAD^{tree}, sha256 of git status -z,
 * sha256 of git diff HEAD, and sha256 over sorted path\0size\0fileHash\0
 * for untracked files (via git hash-object --no-filters; files > 1 MiB -> null).
 */
export function computeWorkspaceFingerprint(dir) {
  if (typeof dir !== 'string' || !dir || !isAbsolute(dir)) {
    throw new AiCliError('INVALID_INPUT', 'dir must be an absolute path', { exitCode: 2 });
  }
  let cwd;
  try {
    cwd = realpathSync(dir);
  } catch {
    cwd = dir;
  }

  const isGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });

  if (isGit.status !== 0) {
    return {
      head: null,
      tree: null,
      statusDigest: null,
      diffDigest: null,
      untrackedCount: 0,
      untrackedDigest: null,
      nonGit: true,
    };
  }

  const headProbe = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 10_000 });
  const head = headProbe.status === 0 ? headProbe.stdout.trim() : null;

  const treeProbe = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd, encoding: 'utf8', timeout: 10_000 });
  const tree = treeProbe.status === 0 ? treeProbe.stdout.trim() : null;

  const statusProbe = spawnSync('git', ['status', '--porcelain=v1', '-z'], { cwd, timeout: 10_000 });
  const statusDigest = statusProbe.status === 0
    ? createHash('sha256').update(statusProbe.stdout || Buffer.alloc(0)).digest('hex')
    : null;

  const diffProbe = spawnSync('git', ['diff', 'HEAD'], { cwd, timeout: 15_000 });
  const diffDigest = diffProbe.status === 0
    ? createHash('sha256').update(diffProbe.stdout || Buffer.alloc(0)).digest('hex')
    : null;

  const untrackedProbe = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, timeout: 15_000 });
  let untrackedCount = 0;
  let untrackedDigest = null;

  if (untrackedProbe.status === 0) {
    const raw = untrackedProbe.stdout || Buffer.alloc(0);
    const files = raw.toString('utf8').split('\0').filter(Boolean).sort();
    untrackedCount = files.length;

    let hasLargeFile = false;
    for (const file of files) {
      try {
        const s = statSync(join(cwd, file));
        if (s.size > MAX_UNTRACKED_FILE_BYTES) {
          hasLargeFile = true;
          break;
        }
      } catch {
        hasLargeFile = true;
        break;
      }
    }

    if (hasLargeFile) {
      untrackedDigest = null;
    } else if (files.length === 0) {
      untrackedDigest = createHash('sha256').update('').digest('hex');
    } else {
      const hash = createHash('sha256');
      for (const file of files) {
        const s = statSync(join(cwd, file));
        const hashRes = spawnSync('git', ['hash-object', '--no-filters', '--', file], { cwd, encoding: 'utf8', timeout: 5000 });
        const fileHash = hashRes.status === 0 ? hashRes.stdout.trim() : '';
        hash.update(`${file}\0${s.size}\0${fileHash}\0`);
      }
      untrackedDigest = hash.digest('hex');
    }
  }

  return {
    head,
    tree,
    statusDigest,
    diffDigest,
    untrackedCount,
    untrackedDigest,
    nonGit: false,
  };
}

/**
 * Request the remote worker to compute a fingerprint of remoteDir via SSH.
 */
export async function runRemoteFingerprint({
  hostId,
  env = process.env,
  remoteDir,
  cwd,
  timeoutMs = 30_000,
}) {
  const host = resolveClaudeRemoteHost(hostId, env);
  const sshBin = resolveSshBin(env);
  const sshArgs = buildSshArgs(host.sshHost);
  const sshEnv = buildSshChildEnv(env);
  const targetDir = remoteDir || cwd;

  const payload = JSON.stringify({
    schema: 'webmcp-ai-claude-remote-request/1',
    mode: 'fingerprint',
    cwd: targetDir,
    workspaceRoot: host.workspaceRoot,
  });

  let rawResult;
  try {
    rawResult = await runProcess(
      sshBin,
      [...sshArgs, host.nodeBin, host.worker, '--mode', 'fingerprint'],
      {
        stdin: payload,
        env: sshEnv,
        timeoutMs,
        maxOutputBytes: 256 * 1024,
      },
    );
  } catch (error) {
    if (error?.code === 'PROVIDER_ABORTED') throw error;
    throw mapSshError(error, hostId);
  }

  try {
    const line = rawResult.stdout.trim().split(/\r?\n/).find((l) => l.startsWith('{'));
    return JSON.parse(line || rawResult.stdout.trim());
  } catch {
    throw new AiCliError('CLAUDE_REMOTE_WORKER_ERROR', 'Remote Claude worker fingerprint returned invalid output', {
      exitCode: 2,
      details: { host: hostId },
    });
  }
}

/**
 * Verify that local and remote workspaces are bitwise/git identical before model run.
 * Fails closed on mismatch or nonGit for review/implement.
 */
export async function verifyRemoteWorkspace({ hostId, env = process.env, localDir, remoteDir }) {
  const local = computeWorkspaceFingerprint(localDir);
  const remote = await runRemoteFingerprint({ hostId, env, remoteDir });

  if (local.nonGit || remote.nonGit) {
    throw new AiCliError('CLAUDE_REMOTE_WORKSPACE_MISMATCH', 'Workspace verification failed: not a Git repository', {
      exitCode: 2,
      details: {
        host: hostId,
        reason: 'non-git',
        localNonGit: Boolean(local.nonGit),
        remoteNonGit: Boolean(remote.nonGit),
      },
    });
  }

  // Fail closed when a fingerprint input cannot be computed on either
  // side: untrackedDigest is null when an untracked file exceeds 1 MiB or
  // stat fails, and any digest is null when its git probe fails. Without
  // this, null==null would compare equal and pass as a "match".
  const FINGERPRINT_FIELDS = ['head', 'tree', 'statusDigest', 'diffDigest', 'untrackedDigest'];
  const localNull = FINGERPRINT_FIELDS.filter((field) => local[field] == null);
  const remoteNull = FINGERPRINT_FIELDS.filter((field) => remote[field] == null);
  if (localNull.length > 0 || remoteNull.length > 0) {
    throw new AiCliError('CLAUDE_REMOTE_WORKSPACE_MISMATCH', 'Workspace verification failed: fingerprint input could not be computed', {
      exitCode: 2,
      details: {
        host: hostId,
        reason: 'unverifiable-fingerprint',
        localNull,
        remoteNull,
      },
    });
  }

  const matches = local.head === remote.head
    && local.tree === remote.tree
    && local.statusDigest === remote.statusDigest
    && local.diffDigest === remote.diffDigest
    && local.untrackedCount === remote.untrackedCount
    && local.untrackedDigest === remote.untrackedDigest;

  if (!matches) {
    throw new AiCliError('CLAUDE_REMOTE_WORKSPACE_MISMATCH', 'Remote workspace does not match local workspace', {
      exitCode: 2,
      details: {
        host: hostId,
        local: {
          head: local.head ? local.head.slice(0, 8) : null,
          tree: local.tree ? local.tree.slice(0, 8) : null,
          statusDigest: local.statusDigest ? local.statusDigest.slice(0, 8) : null,
          diffDigest: local.diffDigest ? local.diffDigest.slice(0, 8) : null,
          untrackedCount: local.untrackedCount,
          untrackedDigest: local.untrackedDigest ? local.untrackedDigest.slice(0, 8) : null,
        },
        remote: {
          head: remote.head ? remote.head.slice(0, 8) : null,
          tree: remote.tree ? remote.tree.slice(0, 8) : null,
          statusDigest: remote.statusDigest ? remote.statusDigest.slice(0, 8) : null,
          diffDigest: remote.diffDigest ? remote.diffDigest.slice(0, 8) : null,
          untrackedCount: remote.untrackedCount,
          untrackedDigest: remote.untrackedDigest ? remote.untrackedDigest.slice(0, 8) : null,
        },
      },
    });
  }

  return {
    ok: true,
    digest: local.tree || local.head || local.statusDigest,
  };
}

/**
 * Spawn the remote Claude worker over SSH in run mode.
 */
export async function runRemoteClaude({
  hostId,
  env = process.env,
  args,
  prompt,
  cwd,
  timeoutMs = 600_000,
  maxOutputBytes = 32 * 1024 * 1024,
  signal,
}) {
  const host = resolveClaudeRemoteHost(hostId, env);
  const sshBin = resolveSshBin(env);
  const sshArgs = buildSshArgs(host.sshHost);
  const sshEnv = buildSshChildEnv(env);

  const payload = JSON.stringify({
    schema: 'webmcp-ai-claude-remote-request/1',
    mode: 'run',
    args,
    prompt: typeof prompt === 'string' ? prompt : '',
    cwd,
    workspaceRoot: host.workspaceRoot,
    timeoutMs,
    maxOutputBytes,
    env: {},
  });

  const outerTimeoutMs = timeoutMs + 30_000;
  let rawResult;
  try {
    rawResult = await runProcess(
      sshBin,
      [...sshArgs, host.nodeBin, host.worker, '--mode', 'run', '--claude-bin', host.binary],
      {
        stdin: payload,
        env: sshEnv,
        timeoutMs: outerTimeoutMs,
        maxOutputBytes: maxOutputBytes + 1024 * 1024,
        signal,
      },
    );
  } catch (error) {
    if (error?.code === 'PROVIDER_ABORTED') throw error;
    if (error?.details?.exitCode === 64) {
      throw new AiCliError('CLAUDE_REMOTE_WORKER_ERROR', 'Remote Claude worker rejected request', {
        exitCode: 2,
        details: { host: hostId, exitCode: 64 },
      });
    }
    throw mapSshError(error, hostId);
  }

  let workerResponse;
  try {
    const line = rawResult.stdout.trim().split(/\r?\n/).find((l) => l.includes('webmcp-ai-claude-remote-response/1'));
    workerResponse = JSON.parse(line || rawResult.stdout.trim());
  } catch {
    throw new AiCliError('CLAUDE_REMOTE_WORKER_ERROR', 'Remote Claude worker response was malformed or missing', {
      exitCode: 2,
      details: { host: hostId },
    });
  }

  if (workerResponse.schema !== 'webmcp-ai-claude-remote-response/1' || workerResponse.mode !== 'run') {
    throw new AiCliError('CLAUDE_REMOTE_WORKER_ERROR', 'Remote Claude worker response schema invalid', {
      exitCode: 2,
      details: { host: hostId },
    });
  }

  if (workerResponse.timedOut) {
    throw new AiCliError('PROVIDER_TIMEOUT', `Remote Claude exceeded the ${timeoutMs}ms timeout`, {
      retryable: true,
      details: { transport: 'ssh', host: hostId, timeoutMs },
    });
  }

  // A truncated run is not a successful generate even at exit 0: the
  // worker capped stdout/stderr at maxOutputBytes and the tail is lost.
  // Mirror the local runner's PROVIDER_OUTPUT_LIMIT (process-runner.mjs).
  if (workerResponse.truncated?.stdout || workerResponse.truncated?.stderr) {
    const stdoutTruncated = Boolean(workerResponse.truncated?.stdout);
    const stderrTruncated = Boolean(workerResponse.truncated?.stderr);
    const streams = [stdoutTruncated && 'stdout', stderrTruncated && 'stderr'].filter(Boolean).join(' and ');
    throw new AiCliError('PROVIDER_OUTPUT_LIMIT', `Remote Claude output exceeded the limit (truncated ${streams})`, {
      details: { transport: 'ssh', host: hostId, stdout: stdoutTruncated, stderr: stderrTruncated },
    });
  }

  if (workerResponse.exitCode !== 0) {
    throw classifyProviderExit({
      stdout: workerResponse.stdout,
      stderr: workerResponse.stderr,
      exitCode: workerResponse.exitCode,
      exitSignal: workerResponse.signal,
    });
  }

  return {
    stdout: workerResponse.stdout,
    stderr: workerResponse.stderr,
    exitCode: 0,
  };
}

/**
 * Probe the remote worker via --mode selftest over SSH.
 */
export async function probeRemoteWorker({ hostId, env = process.env, timeoutMs = 8000 }) {
  const host = resolveClaudeRemoteHost(hostId, env);
  const sshBin = resolveSshBin(env);
  const sshArgs = buildSshArgs(host.sshHost);
  const sshEnv = buildSshChildEnv(env);

  let rawResult;
  try {
    rawResult = await runProcess(
      sshBin,
      [...sshArgs, host.nodeBin, host.worker, '--mode', 'selftest', '--claude-bin', host.binary],
      {
        env: sshEnv,
        timeoutMs,
        maxOutputBytes: 64 * 1024,
      },
    );
  } catch (error) {
    if (error?.code === 'PROVIDER_ABORTED') throw error;
    throw mapSshError(error, hostId);
  }

  try {
    const line = rawResult.stdout.trim().split(/\r?\n/).find((l) => l.startsWith('{'));
    return JSON.parse(line || rawResult.stdout.trim());
  } catch {
    throw new AiCliError('CLAUDE_REMOTE_WORKER_ERROR', 'Remote Claude worker selftest returned invalid response', {
      exitCode: 2,
      details: { host: hostId },
    });
  }
}
