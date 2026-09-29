import { buildSafeChildEnv } from './capabilities.mjs';
import { AiCliError } from './errors.mjs';
import { runProcess } from './process-runner.mjs';

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
  return {
    id: declared.id,
    sshHost: validateSshHost(sshHost, 'sshHost'),
    binary: validateAbsolutePath(binary, 'binary'),
    worker: validateAbsolutePath(worker, 'worker'),
    workspaceRoot: validateAbsolutePath(workspaceRoot, 'workspaceRoot'),
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

function extractSemverToken(text) {
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
 * the probed version to equal `pin`.
 */
export async function readRemoteClaudeState({ hostId, env = process.env, pin } = {}) {
  let probe;
  try {
    probe = await probeRemoteClaude({ hostId, env });
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
