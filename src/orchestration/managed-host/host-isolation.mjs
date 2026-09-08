import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  readSync,
  unlinkSync,
} from 'node:fs';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AiCliError } from '../../errors.mjs';
import { PERMISSION_REQUIRED } from '../constants.mjs';
import { canonicalizeExistingPrefix } from '../verifier.mjs';

export const HOST_ISOLATION_SCHEMA = 'webmcp-managed-host-isolation/1';
export const HOST_ISOLATION_MODE = 'darwin-seatbelt-broker';
export const HOST_ISOLATION_PRIMITIVE = 'darwin-seatbelt-sandbox-exec';
// The packaged topology carries only this closed identifier. The executable
// implementation is resolved from this module's coordinator-owned table and
// is never accepted from JSON, a task packet or an IPC frame.
export const HOST_ISOLATION_BROKER_IMPLEMENTATION = 'coordinator-owned-webmcp-v1';
export const HOST_ISOLATION_PRIMITIVE_UNAVAILABLE = 'HOST_ISOLATION_PRIMITIVE_UNAVAILABLE';
export const HOST_ISOLATION_BROKER_REQUIRED = 'HOST_ISOLATION_BROKER_REQUIRED';
export const HOST_ISOLATION_LIFECYCLE_UNTRUSTED = 'HOST_ISOLATION_LIFECYCLE_UNTRUSTED';
export const HOST_ISOLATION_UNSAFE_WORKSPACE = 'HOST_ISOLATION_UNSAFE_WORKSPACE';
export const HOST_ISOLATION_BOUNDARY_MISMATCH = 'HOST_ISOLATION_BOUNDARY_MISMATCH';
export const HOST_ISOLATION_AUTHORITY_BYPASS = 'HOST_ISOLATION_AUTHORITY_BYPASS';
export const HOST_ISOLATION_DISPATCHER_REQUIRED = 'HOST_ISOLATION_DISPATCHER_REQUIRED';
export const HOST_ISOLATION_DISPATCHER_UNTRUSTED = 'HOST_ISOLATION_DISPATCHER_UNTRUSTED';
export const HOST_ISOLATION_BROKER_PROTOCOL = 'webmcp-managed-broker/1';
export const COORDINATOR_DISPATCHER_SCHEMA = 'webmcp-coordinator-dispatcher/1';
export const COORDINATOR_DISPATCHER_IMPLEMENTATION = 'coordinator-owned-webmcp-v1';
// This symbol is a process-local trust marker. It is intentionally never
// serialized into a task, trusted JSON descriptor, IPC frame or child env.
export const COORDINATOR_DISPATCHER_MARKER = Symbol.for('webmcp.coordinator-dispatcher.marker/1');
export const COORDINATOR_DISPATCH_REQUEST_SCHEMA = 'webmcp-coordinator-dispatch-request/1';
export const COORDINATOR_DISPATCH_TOOLS = Object.freeze([
  'webmcp.invokeTool',
  'webmcp.listTools',
]);
export const BROKER_PROTOCOL_ERROR = 'BROKER_PROTOCOL_ERROR';
export const UNLISTED_MCP_TOOL_DENIED = 'UNLISTED_MCP_TOOL_DENIED';
export const BROKER_FD = 3;
export const DARWIN_SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';
export const LINUX_BWRAP_PATH = '/usr/bin/bwrap';
export const LINUX_UNSHARE_PATH = '/usr/bin/unshare';
export const LINUX_SYSTEMD_RUN_PATH = '/usr/bin/systemd-run';
export const HOST_ISOLATION_LINUX_PRIMITIVE_BWRAP = 'linux-bubblewrap-bwrap';
export const HOST_ISOLATION_LINUX_PRIMITIVE_UNSHARE = 'linux-namespaces-unshare';
export const HOST_ISOLATION_LINUX_PRIMITIVE_SYSTEMD = 'linux-systemd-isolation';
export const HOST_ISOLATION_LAUNCH_BOUNDARY_LINUX = 'linux-namespace-mount-boundary-v1';

// Node's child_process.spawn accepts only a pathname for cwd, so Node cannot
// make a whole directory tree atomic with the spawn syscall. On Darwin the
// launch boundary is instead enforced by the Seatbelt kernel profile: the
// child receives a closed literal read set captured before launch, not a
// workspace-wide subpath permission. A name inserted after that capture is
// not readable by the child, even though the ordinary spawn call follows it.
export const HOST_ISOLATION_LAUNCH_BOUNDARY = 'seatbelt-file-literal-snapshot-v1';

// The G2 launch proof covers the real owned-process adapter, not an arbitrary
// object that happens to expose a similarly named spawn method. The adapter
// marker lives in the factory module and is never serialized into a task or
// binding; this module only consumes the factory-owned predicate.
const TRUSTED_MEDIATED_TOOL_BROKER = Symbol('webmcp.trusted-mediated-tool-broker');
const WORKSPACE_READ_SET_SNAPSHOTS = new Map();
const MAX_WORKSPACE_READ_SET_SNAPSHOTS = 256;

const MAX_BROKER_FRAME_BYTES = 64 * 1024;
const MAX_BROKER_REQUESTS = 64;
const MAX_BROKER_RESPONSE_BYTES = 64 * 1024;
const MAX_BROKER_STRING_BYTES = 16 * 1024;
const MAX_BROKER_NESTING = 32;
const MAX_BROKER_NODES = 4096;
const BROKER_REQUEST_ID = /^[A-Za-z0-9_-]{1,96}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ENV_KEYS = new Set([
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  'NODE_NO_WARNINGS',
  'TZ',
]);
const AUTHORITY_KEY = /(?:permit|claim|private.?key|token|credential|secret|password|api.?key|cookie|capability|authorization|auth)/i;
const AUTHORITY_VALUE = /(?:bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{15,}|-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----)/i;
const PATH_INPUT_KEY = /(?:path|file|directory|cwd|root|source|location|workspace|artifact|document|attachment)/i;
const WRITE_INPUT_KEY = /(?:write|output|destination|target)/i;
const SHELL_INPUT_KEY = /(?:shell|command|cmd|exec|executable|argv|argument)/i;
const BROWSER_INPUT_KEY = /(?:browser|page|tab|navigate|navigation|selector|devtools|puppeteer|playwright|url|uri)/i;
const NETWORK_INPUT_KEY = /(?:url|uri|endpoint|host|origin|network|socket|port|domain|proxy|remote)/i;
const NETWORK_URL = /^(?:https?|wss?|ftp|data|javascript):/i;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const NETWORK_LITERAL = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(?::\d{1,5})?(?:[/?#].*)?$/i;
const NETWORK_HOST = /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d{1,5})?(?:[/?#].*)?$/i;
const PATH_SEPARATOR = /[\\/]/;
const SHELL_FRAGMENT = /(?:^|\s)(?:(?:\/usr)?\/bin\/)?(?:sh|bash|zsh|fish|dash|cmd|powershell|pwsh|node|python\d*|perl)(?:\s|$)|[;&|`$<>]/i;
const COORDINATOR_BROKER_TOOLS = Object.freeze({
  [HOST_ISOLATION_BROKER_IMPLEMENTATION]: Object.freeze([
    'webmcp.echo',
    ...COORDINATOR_DISPATCH_TOOLS,
  ]),
});

function fail(code, message, details = undefined) {
  throw new AiCliError(code, message, { exitCode: 2, ...(details === undefined ? {} : { details }) });
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreezeJson(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item, seen);
  } else {
    for (const item of Object.values(value)) deepFreezeJson(item, seen);
  }
  seen.delete(value);
  return Object.freeze(value);
}

export function assertCoordinatorDispatcher(dispatcher) {
  if (dispatcher === undefined || dispatcher === null) return null;
  const marker = typeof dispatcher === 'function'
    ? dispatcher[COORDINATOR_DISPATCHER_MARKER]
    : null;
  const markerDescriptor = typeof dispatcher === 'function'
    ? Object.getOwnPropertyDescriptor(dispatcher, COORDINATOR_DISPATCHER_MARKER)
    : null;
  if (
    typeof dispatcher !== 'function'
    || !Object.isFrozen(dispatcher)
    || !Object.isFrozen(marker)
    || !markerDescriptor
    || markerDescriptor.enumerable
    || markerDescriptor.writable
    || markerDescriptor.configurable
    || markerDescriptor.value !== marker
    || marker?.schema !== COORDINATOR_DISPATCHER_SCHEMA
    || marker?.implementation !== COORDINATOR_DISPATCHER_IMPLEMENTATION
    || marker?.dispatch !== dispatcher
    || marker?.owner !== 'coordinator'
  ) {
    fail(HOST_ISOLATION_DISPATCHER_UNTRUSTED,
      'managed browser dispatch requires a frozen coordinator-owned dispatcher callback');
  }
  return dispatcher;
}

export function isTrustedMediatedToolBroker(broker) {
  const marker = broker?.[TRUSTED_MEDIATED_TOOL_BROKER];
  return Object.isFrozen(broker)
    && Object.isFrozen(marker)
    && marker?.implementation === broker.implementation
    && marker?.allowedTools === broker.allowedTools
    && marker?.socket === broker.socket
    && marker?.close === broker.close
    && broker.schema === HOST_ISOLATION_SCHEMA
    && broker.mode === HOST_ISOLATION_MODE
    && broker.brokerFd === BROKER_FD
    && broker.implementation === HOST_ISOLATION_BROKER_IMPLEMENTATION
    && typeof broker.socket?.on === 'function'
    && typeof broker.close === 'function';
}

function boundedString(value, label, maxBytes = MAX_BROKER_STRING_BYTES) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) {
    fail('ORCHESTRATION_INVALID_INPUT', `${label} must be a bounded non-empty string`);
  }
  if (value.includes('\0') || /[\u0001-\u001f\u007f]/.test(value)) {
    fail('ORCHESTRATION_INVALID_INPUT', `${label} contains unsupported control characters`);
  }
  return value;
}

function absolutePath(value, label) {
  const raw = boundedString(value, label, 4096);
  if (!isAbsolute(raw)) fail('ORCHESTRATION_INVALID_INPUT', `${label} must be absolute`);
  return resolve(raw);
}

function sbplLiteral(value, label) {
  const raw = boundedString(value, label, 4096);
  return `"${raw.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function pathAncestors(pathValue) {
  const result = [];
  let cursor = pathValue;
  while (true) {
    result.push(cursor);
    if (cursor === '/') break;
    cursor = dirname(cursor);
  }
  return result;
}

function isWithin(candidate, root) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function canonicalPath(value, label, { requireDirectory = false } = {}) {
  const raw = absolutePath(value, label);
  let canonical;
  try {
    canonical = canonicalizeExistingPrefix(raw);
  } catch (error) {
    fail('ORCHESTRATION_INVALID_INPUT', `${label} cannot be canonicalized`, { cause: error?.code ?? 'ERROR' });
  }
  if (requireDirectory) {
    try {
      if (!lstatSync(raw).isDirectory()) fail('ORCHESTRATION_INVALID_INPUT', `${label} must be a directory`);
    } catch (error) {
      if (error instanceof AiCliError) throw error;
      fail('ORCHESTRATION_INVALID_INPUT', `${label} must be an existing directory`);
    }
  }
  return canonical;
}

function assertPosixMode(pathValue, expectedMode, label) {
  if (process.platform === 'win32') return;
  try {
    chmodSync(pathValue, expectedMode);
    const actual = lstatSync(pathValue).mode & 0o777;
    if (actual !== expectedMode) fail('POLICY_DENIED', `${label} permissions could not be enforced`);
  } catch (error) {
    if (error instanceof AiCliError) throw error;
    fail('POLICY_DENIED', `${label} permissions could not be enforced`);
  }
}

function workspaceReadSetEntry(pathValue, stats) {
  return Object.freeze({ path: pathValue, dev: stats.dev, ino: stats.ino });
}

function collectWorkspaceReadSnapshot(workspace) {
  const readEntries = new Map();
  let workspaceStats;
  try {
    workspaceStats = lstatSync(workspace);
  } catch {
    fail(HOST_ISOLATION_UNSAFE_WORKSPACE, 'isolated workspace changed during safety inspection');
  }
  readEntries.set(workspace, workspaceReadSetEntry(workspace, workspaceStats));
  const pending = [workspace];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      fail(HOST_ISOLATION_UNSAFE_WORKSPACE, 'isolated workspace changed during safety inspection');
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      let stats;
      try {
        stats = lstatSync(child);
      } catch {
        fail(HOST_ISOLATION_UNSAFE_WORKSPACE, 'isolated workspace changed during safety inspection');
      }
      // Hardlink aliases can make an apparently in-scope path address an
      // outside inode. Refuse them before the child exists. Symlinks are not
      // followed here; the Seatbelt vnode boundary must deny their access.
      if (stats.isFile() && stats.nlink > 1) {
        fail(HOST_ISOLATION_UNSAFE_WORKSPACE, 'isolated workspace contains a pre-existing hardlink');
      }
      if (stats.isFile()) {
        readEntries.set(child, workspaceReadSetEntry(child, stats));
      } else if (stats.isDirectory() && !stats.isSymbolicLink()) {
        readEntries.set(child, workspaceReadSetEntry(child, stats));
        pending.push(child);
      }
    }
  }
  return Object.freeze([...readEntries.values()].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  )));
}

function collectWorkspaceReadPaths(workspace) {
  return Object.freeze(collectWorkspaceReadSnapshot(workspace).map(({ path }) => path));
}

function assertWorkspaceTree(workspace) {
  collectWorkspaceReadPaths(workspace);
}

function normalizeScope(task) {
  if (!isPlainObject(task)) fail('ORCHESTRATION_INVALID_INPUT', 'managed broker task scope is required');
  const workspace = canonicalPath(task.workspace, 'task workspace');
  try {
    if (lstatSync(task.workspace).isSymbolicLink()) {
      fail(HOST_ISOLATION_UNSAFE_WORKSPACE, 'managed broker workspace must not be a symlink');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') fail(HOST_ISOLATION_UNSAFE_WORKSPACE, 'managed broker workspace changed during scope validation');
  }
  const readRootValues = task.allowedReadRoots ?? [];
  const writeRootValues = task.allowedWriteRoots ?? [];
  const protectedPathValues = task.protectedPaths ?? [];
  if (!Array.isArray(readRootValues) || !Array.isArray(writeRootValues) || !Array.isArray(protectedPathValues)) {
    fail('ORCHESTRATION_INVALID_INPUT', 'managed broker read/write/protected paths must be arrays');
  }
  const readRoots = readRootValues.map((value, index) => canonicalPath(value, `allowedReadRoots[${index}]`));
  const writeRoots = writeRootValues.map((value, index) => canonicalPath(value, `allowedWriteRoots[${index}]`));
  const protectedPaths = protectedPathValues.map((value, index) => canonicalPath(value, `protectedPaths[${index}]`));
  for (const root of writeRoots) {
    if (!isWithin(root, workspace)) {
      fail(HOST_ISOLATION_BOUNDARY_MISMATCH, 'managed broker write root is outside the task workspace');
    }
  }
  for (const protectedPath of protectedPaths) {
    for (const writeRoot of writeRoots) {
      if (isWithin(protectedPath, writeRoot) || isWithin(writeRoot, protectedPath)) {
        fail(HOST_ISOLATION_BOUNDARY_MISMATCH, 'managed broker protected path overlaps a write root');
      }
    }
  }
  return Object.freeze({
    workspace,
    allowedReadRoots: Object.freeze([...new Set(readRoots)].sort()),
    allowedWriteRoots: Object.freeze([...new Set(writeRoots)].sort()),
    protectedPaths: Object.freeze([...new Set(protectedPaths)].sort()),
  });
}

function normalizeTools(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    fail(HOST_ISOLATION_BROKER_REQUIRED, 'trusted mediated broker requires a non-empty tool allow-list');
  }
  const tools = [...new Set(value.map((tool, index) => {
    const normalized = boundedString(tool, `broker.allowedTools[${index}]`, 256);
    if (!TOOL_NAME.test(normalized)) fail('ORCHESTRATION_INVALID_INPUT', `broker tool name ${normalized} is invalid`);
    return normalized;
  }))].sort();
  if (tools.length === 0) fail(HOST_ISOLATION_BROKER_REQUIRED, 'trusted mediated broker tool allow-list is empty');
  return Object.freeze(tools);
}

function normalizeBrokerDescriptor(value) {
  if (!isPlainObject(value)) {
    fail(HOST_ISOLATION_BROKER_REQUIRED, 'hostIsolation broker must be a coordinator-owned JSON descriptor');
  }
  const unknown = Object.keys(value).filter((key) => !['implementation', 'allowedTools'].includes(key));
  if (unknown.length > 0) {
    fail('ORCHESTRATION_INVALID_INPUT', `hostIsolation broker has unknown field(s): ${unknown.join(', ')}`);
  }
  if (!Object.hasOwn(value, 'implementation')) {
    fail(HOST_ISOLATION_BROKER_REQUIRED, 'hostIsolation broker must name a coordinator-owned implementation');
  }
  const implementation = boundedString(value.implementation, 'broker.implementation', 128);
  if (!Object.hasOwn(COORDINATOR_BROKER_TOOLS, implementation)) {
    fail(HOST_ISOLATION_BROKER_REQUIRED, `hostIsolation broker implementation ${implementation} is not coordinator-owned`);
  }
  const allowedTools = normalizeTools(value.allowedTools);
  const implementationTools = COORDINATOR_BROKER_TOOLS[implementation];
  if (allowedTools.some((tool) => !implementationTools.includes(tool))) {
    fail(HOST_ISOLATION_BROKER_REQUIRED, `hostIsolation broker implementation ${implementation} does not provide every allowed tool`);
  }
  return Object.freeze({ implementation, allowedTools });
}

export function normalizeHostIsolationConfig(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) fail('ORCHESTRATION_INVALID_INPUT', 'hostIsolation must be an object');
  const unknown = Object.keys(value).filter((key) => !['mode', 'broker'].includes(key));
  if (unknown.length > 0) fail('ORCHESTRATION_INVALID_INPUT', `hostIsolation has unknown field(s): ${unknown.join(', ')}`);
  if (value.mode !== HOST_ISOLATION_MODE) {
    fail('ORCHESTRATION_INVALID_INPUT', `hostIsolation.mode must be ${HOST_ISOLATION_MODE}`);
  }
  const normalized = { mode: HOST_ISOLATION_MODE };
  if (value.broker !== undefined && value.broker !== null) {
    normalized.broker = normalizeBrokerDescriptor(value.broker);
  }
  return Object.freeze(normalized);
}

export function assertTrustedMediatedBroker(hostIsolation) {
  if (hostIsolation?.mode !== HOST_ISOLATION_MODE || !hostIsolation?.broker) {
    fail(HOST_ISOLATION_BROKER_REQUIRED, 'managed host isolation requires a trusted mediated WebMCP broker');
  }
  return normalizeBrokerDescriptor(hostIsolation.broker);
}

export function isHostIsolationRequested(config) {
  return config?.hostIsolation !== undefined && config?.hostIsolation !== null;
}

function isExecutablePath(candidate) {
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) return false;
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function probeHostIsolation({
  platform = process.platform,
  sandboxExecPath = DARWIN_SANDBOX_EXEC_PATH,
  bwrapPath = LINUX_BWRAP_PATH,
  unsharePath = LINUX_UNSHARE_PATH,
  systemdRunPath = LINUX_SYSTEMD_RUN_PATH,
} = {}) {
  if (platform === 'darwin') {
    const executable = typeof sandboxExecPath === 'string' && isAbsolute(sandboxExecPath) ? sandboxExecPath : null;
    const available = executable !== null && isExecutablePath(executable);
    return Object.freeze({
      available,
      platform,
      executable: available ? executable : null,
      primitive: available ? HOST_ISOLATION_PRIMITIVE : null,
    });
  }
  if (platform === 'linux') {
    // Preference order on MiniPC (Ubuntu 24.04): bubblewrap first for mount
    // isolation, then unshare namespaces/seccomp, then a systemd slice
    // fallback. All three are coordinator-owned executables resolved here —
    // never from JSON, task packets, or IPC.
    if (isExecutablePath(bwrapPath)) {
      return Object.freeze({
        available: true, platform, executable: bwrapPath, primitive: HOST_ISOLATION_LINUX_PRIMITIVE_BWRAP,
      });
    }
    if (isExecutablePath(unsharePath)) {
      return Object.freeze({
        available: true, platform, executable: unsharePath, primitive: HOST_ISOLATION_LINUX_PRIMITIVE_UNSHARE,
      });
    }
    if (isExecutablePath(systemdRunPath)) {
      return Object.freeze({
        available: true, platform, executable: systemdRunPath, primitive: HOST_ISOLATION_LINUX_PRIMITIVE_SYSTEMD,
      });
    }
    return Object.freeze({ available: false, platform, executable: null, primitive: null });
  }
  return Object.freeze({ available: false, platform, executable: null, primitive: null });
}

export function assertHostIsolationPrimitive({
  platform = process.platform,
  sandboxExecPath = DARWIN_SANDBOX_EXEC_PATH,
  bwrapPath = LINUX_BWRAP_PATH,
  unsharePath = LINUX_UNSHARE_PATH,
  systemdRunPath = LINUX_SYSTEMD_RUN_PATH,
} = {}) {
  const observed = probeHostIsolation({ platform, sandboxExecPath, bwrapPath, unsharePath, systemdRunPath });
  if (!observed.available) {
    fail(HOST_ISOLATION_PRIMITIVE_UNAVAILABLE,
      'managed host isolation requires a coordinator-owned primitive (Darwin sandbox-exec, or Linux bwrap/unshare/systemd-run)', {
        schema: HOST_ISOLATION_SCHEMA,
        requiredMode: HOST_ISOLATION_MODE,
        missingPrimitive: platform === 'linux'
          ? HOST_ISOLATION_LINUX_PRIMITIVE_BWRAP
          : HOST_ISOLATION_PRIMITIVE,
      });
  }
  return observed;
}

function assertExecutable(command) {
  const executable = canonicalPath(command, 'owned process command');
  try {
    const stats = lstatSync(executable);
    if (!stats.isFile()) fail('ORCHESTRATION_INVALID_INPUT', 'owned process command must be a regular file');
    accessSync(executable, fsConstants.X_OK);
  } catch (error) {
    if (error instanceof AiCliError) throw error;
    fail(HOST_ISOLATION_PRIMITIVE_UNAVAILABLE, 'owned process executable is not executable');
  }
  return executable;
}

function assertNativeExecutable(executable) {
  // A script entrypoint invokes an interpreter outside the exact exec
  // allow-list. Requiring a native executable keeps the launch seam closed.
  let fd = null;
  try {
    fd = openSync(executable, 'r');
    const headerBuffer = Buffer.alloc(2);
    readSync(fd, headerBuffer, 0, 2, 0);
    if (headerBuffer.toString('ascii') === '#!') {
      fail(HOST_ISOLATION_PRIMITIVE_UNAVAILABLE, 'managed host isolation refuses script entrypoints');
    }
  } catch (error) {
    if (error instanceof AiCliError) throw error;
    fail('ORCHESTRATION_INVALID_INPUT', 'owned process command could not be inspected');
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* the descriptor was already closed */ }
    }
  }
}

function safeChildEnv(workspace, baseEnv) {
  const normalizedWorkspace = canonicalPath(workspace, 'managed host workspace', { requireDirectory: true });
  if (!isPlainObject(baseEnv)) fail('ORCHESTRATION_INVALID_INPUT', 'owned process environment must be an object');
  const env = { HOME: normalizedWorkspace, TMPDIR: normalizedWorkspace };
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!SAFE_ENV_KEYS.has(key)) continue;
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 256 || /[\u0000-\u001f\u007f]/.test(value)) continue;
    if (AUTHORITY_KEY.test(key) || AUTHORITY_VALUE.test(value)) continue;
    env[key] = value;
  }
  return Object.freeze(env);
}

export function buildIsolatedChildEnv({ workspace, baseEnv = {} } = {}) {
  return safeChildEnv(workspace, baseEnv);
}

function validateLaunchRoots({ workspace, cwd, allowedReadRoots = [], allowedWriteRoots = [], protectedPaths = [] }) {
  const canonicalWorkspace = canonicalPath(workspace, 'workspace', { requireDirectory: true });
  try {
    if (lstatSync(workspace).isSymbolicLink()) fail(HOST_ISOLATION_UNSAFE_WORKSPACE, 'workspace itself must not be a symlink');
  } catch (error) {
    if (error instanceof AiCliError) throw error;
    fail(HOST_ISOLATION_UNSAFE_WORKSPACE, 'workspace disappeared during launch validation');
  }
  const canonicalCwd = canonicalPath(cwd ?? workspace, 'cwd', { requireDirectory: true });
  if (!isWithin(canonicalCwd, canonicalWorkspace)) {
    fail(HOST_ISOLATION_BOUNDARY_MISMATCH, 'managed host cwd must stay inside the task workspace');
  }
  const readRoots = allowedReadRoots.map((value, index) => canonicalPath(value, `allowedReadRoots[${index}]`));
  const writeRoots = allowedWriteRoots.map((value, index) => canonicalPath(value, `allowedWriteRoots[${index}]`));
  for (const root of writeRoots) {
    if (!isWithin(root, canonicalWorkspace)) {
      fail(HOST_ISOLATION_BOUNDARY_MISMATCH, 'managed host write root must stay inside the task workspace');
    }
  }
  const canonicalProtected = protectedPaths.map((value, index) => canonicalPath(value, `protectedPaths[${index}]`));
  const workspaceReadSnapshot = collectWorkspaceReadSnapshot(canonicalWorkspace);
  const workspaceReadPaths = Object.freeze(workspaceReadSnapshot.map(({ path }) => path));
  return Object.freeze({
    workspace: canonicalWorkspace,
    cwd: canonicalCwd,
    allowedReadRoots: Object.freeze([...new Set(readRoots)].sort()),
    allowedWriteRoots: Object.freeze([...new Set(writeRoots)].sort()),
    protectedPaths: Object.freeze([...new Set(canonicalProtected)].sort()),
    workspaceReadPaths,
    workspaceReadSnapshot,
  });
}

/**
 * Re-prove a workspace after the supervisor has bound the launcher's cwd to
 * its directory inode. Node's spawn API accepts a pathname for cwd, which is
 * vulnerable to a path swap between inspection and spawn. The coordinator
 * therefore changes cwd synchronously, checks the kernel-bound cwd identity,
 * and captures that bound directory's read set before the launch-boundary
 * hook and the single spawn call.
 */
export function assertBoundWorkspaceSafe(workspace) {
  const expected = absolutePath(workspace, 'bound workspace');
  let bound;
  try {
    bound = realpathSync('.');
  } catch {
    fail(HOST_ISOLATION_UNSAFE_WORKSPACE, 'bound workspace disappeared during launch');
  }
  if (bound !== expected) {
    fail(HOST_ISOLATION_UNSAFE_WORKSPACE, 'workspace path changed before the bound launch');
  }
  assertWorkspaceTree(bound);
  return bound;
}

/**
 * Re-prove the directory inode and the identities of every path captured in
 * the Seatbelt read-set after the launch-boundary hook. New paths are left to
 * the immutable literal profile, while a replacement of an allow-listed path
 * fails closed before spawn.
 */
export function assertBoundWorkspaceIdentity(workspace, expectedReadSetDigest = null) {
  const expected = absolutePath(workspace, 'bound workspace');
  let bound;
  try {
    bound = realpathSync('.');
  } catch {
    fail(HOST_ISOLATION_UNSAFE_WORKSPACE, 'bound workspace disappeared during launch');
  }
  if (bound !== expected) {
    fail(HOST_ISOLATION_UNSAFE_WORKSPACE, 'workspace path changed before the bound launch');
  }
  if (expectedReadSetDigest !== null) {
    const snapshot = WORKSPACE_READ_SET_SNAPSHOTS.get(expectedReadSetDigest);
    if (!snapshot || snapshot.workspace !== expected) {
      fail(HOST_ISOLATION_UNSAFE_WORKSPACE, 'managed workspace read-set proof is unavailable');
    }
    try {
      for (const entry of snapshot.entries) {
        let stats;
        try {
          stats = lstatSync(entry.path);
        } catch {
          fail(HOST_ISOLATION_UNSAFE_WORKSPACE, 'managed workspace read-set changed before the bound launch');
        }
        if (stats.dev !== entry.dev || stats.ino !== entry.ino) {
          fail(HOST_ISOLATION_UNSAFE_WORKSPACE, 'managed workspace read-set changed before the bound launch');
        }
      }
    } finally {
      WORKSPACE_READ_SET_SNAPSHOTS.delete(expectedReadSetDigest);
    }
  }
  return bound;
}

function buildSeatbeltProfile({ executable, roots }) {
  const metadataPaths = [...new Set([
    ...pathAncestors(roots.workspace),
    ...pathAncestors(roots.cwd),
    ...pathAncestors(executable),
    ...roots.allowedReadRoots.flatMap(pathAncestors),
    ...roots.allowedWriteRoots.flatMap(pathAncestors),
  ])].map((path) => `(literal ${sbplLiteral(path, 'sandbox metadata path')})`).join(' ');
  // A workspace-wide `subpath` read rule is not safe at this boundary: a
  // hardlink alias created after the user-space scan would inherit it. The
  // literal set is immutable once handed to sandbox-exec, so the kernel
  // rejects a late-created alias instead of relying on another user-space
  // scan racing the ordinary spawn call.
  const workspaceReadLiterals = roots.workspaceReadPaths
    .map((path) => `(literal ${sbplLiteral(path, 'workspace read path')})`)
    .join(' ');
  const disjointReadRoots = roots.allowedReadRoots
    .filter((path) => !isWithin(path, roots.workspace) && !isWithin(roots.workspace, path));
  const runtimeReads = [
    '(subpath "/System")',
    '(subpath "/usr/lib")',
    '(subpath "/usr/share/zoneinfo")',
    '(literal "/dev/null")',
    '(literal "/dev/random")',
    '(literal "/dev/urandom")',
    '(literal "/dev/zero")',
    `(literal ${sbplLiteral(executable, 'executable')})`,
    workspaceReadLiterals,
    ...disjointReadRoots.map((path) => `(subpath ${sbplLiteral(path, 'read root')})`),
  ].join(' ');
  const executableReads = [
    '(subpath "/System/Library/Frameworks")',
    '(subpath "/System/Library/PrivateFrameworks")',
    '(subpath "/usr/lib")',
    `(literal ${sbplLiteral(executable, 'executable')})`,
  ].join(' ');
  const lines = [
    '(version 1)',
    '(import "system.sb")',
    '(deny default)',
    '(deny file-read*)',
    '(deny file-write*)',
    '(deny file-link)',
    '(deny process-exec)',
    '(deny network*)',
    '(deny mach-lookup)',
    `(allow file-read-metadata ${metadataPaths})`,
    `(allow file-read* file-test-existence ${runtimeReads})`,
    `(allow file-map-executable ${executableReads})`,
    ...roots.allowedWriteRoots.map((path) => `(allow file-write-create file-test-existence (subpath ${sbplLiteral(path, 'write root')}))`),
    ...roots.workspaceReadPaths
      .filter((path) => roots.allowedWriteRoots.some((root) => isWithin(path, root)))
      .map((path) => `(allow file-write-data file-write-mode (literal ${sbplLiteral(path, 'existing writable path')}))`),
    '(allow process-fork)',
    `(allow process-exec (literal ${sbplLiteral(executable, 'executable')}))`,
    ...roots.protectedPaths.flatMap((path) => [
      `(deny file-read* (subpath ${sbplLiteral(path, 'protected path')}))`,
      `(deny file-write* (subpath ${sbplLiteral(path, 'protected path')}))`,
    ]),
  ];
  return `${lines.join(' ')} `;
}

function workspaceReadSetDigest(snapshot) {
  const serialized = snapshot
    .map(({ path, dev, ino }) => `${path}\0${String(dev)}\0${String(ino)}`)
    .join('\0');
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

function rememberWorkspaceReadSet(workspace, snapshot, digest) {
  if (!WORKSPACE_READ_SET_SNAPSHOTS.has(digest) && WORKSPACE_READ_SET_SNAPSHOTS.size >= MAX_WORKSPACE_READ_SET_SNAPSHOTS) {
    const oldest = WORKSPACE_READ_SET_SNAPSHOTS.keys().next().value;
    if (oldest !== undefined) WORKSPACE_READ_SET_SNAPSHOTS.delete(oldest);
  }
  WORKSPACE_READ_SET_SNAPSHOTS.set(digest, Object.freeze({ workspace, entries: snapshot }));
}

function buildLinuxSandboxArgs({ primitive, executable, args, roots }) {
  if (primitive.primitive === HOST_ISOLATION_LINUX_PRIMITIVE_BWRAP) {
    const sandboxArgs = [
      '--die-with-parent',
      '--unshare-all',
      '--clearenv',
      '--setenv', 'HOME', roots.workspace,
      '--setenv', 'TMPDIR', roots.workspace,
      '--ro-bind', '/usr', '/usr',
      '--bind', roots.workspace, roots.workspace,
      ...roots.allowedWriteRoots.flatMap((root) => (root === roots.workspace ? [] : ['--bind', root, root])),
      ...roots.allowedReadRoots
        .filter((root) => !isWithin(root, roots.workspace) && !isWithin(roots.workspace, root))
        .flatMap((root) => ['--ro-bind', root, root]),
      '--chdir', roots.cwd,
      '--', executable, ...args,
    ];
    return Object.freeze(sandboxArgs);
  }
  if (primitive.primitive === HOST_ISOLATION_LINUX_PRIMITIVE_UNSHARE) {
    return Object.freeze(['--mount', '--uts', '--ipc', '--net', '--pid', '--fork', '--mount-proc', '--', executable, ...args]);
  }
  return Object.freeze(['--scope', '--slice=webmcp-isolated.slice', '--', executable, ...args]);
}

export function buildSeatbeltLaunchSpec({
  command,
  args = [],
  cwd,
  workspace,
  allowedReadRoots = [],
  allowedWriteRoots = [],
  protectedPaths = [],
  baseEnv = {},
  sandboxExecPath = DARWIN_SANDBOX_EXEC_PATH,
  bwrapPath = LINUX_BWRAP_PATH,
  unsharePath = LINUX_UNSHARE_PATH,
  systemdRunPath = LINUX_SYSTEMD_RUN_PATH,
  platform = process.platform,
} = {}) {
  const primitive = assertHostIsolationPrimitive({ platform, sandboxExecPath, bwrapPath, unsharePath, systemdRunPath });
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    fail('ORCHESTRATION_INVALID_INPUT', 'managed host argv must be an array of strings');
  }
  const executable = assertExecutable(command);
  assertNativeExecutable(executable);
  const roots = validateLaunchRoots({ workspace, cwd, allowedReadRoots, allowedWriteRoots, protectedPaths });
  const env = safeChildEnv(roots.workspace, baseEnv);
  const readSetDigest = workspaceReadSetDigest(roots.workspaceReadSnapshot);
  rememberWorkspaceReadSet(roots.workspace, roots.workspaceReadSnapshot, readSetDigest);
  if (primitive.primitive !== HOST_ISOLATION_PRIMITIVE) {
    const linuxArgs = buildLinuxSandboxArgs({ primitive, executable, args, roots });
    return Object.freeze({
      command: primitive.executable,
      args: linuxArgs,
      cwd: roots.cwd,
      env,
      proof: Object.freeze({
        schema: HOST_ISOLATION_SCHEMA,
        mode: HOST_ISOLATION_MODE,
        primitive: primitive.primitive,
        brokerFd: BROKER_FD,
        cwdBinding: 'kernel-inherited-directory-cwd',
        launchBoundary: HOST_ISOLATION_LAUNCH_BOUNDARY_LINUX,
        workspace: roots.workspace,
        allowedWriteRoots: roots.allowedWriteRoots,
        workspaceReadSetDigest: readSetDigest,
      }),
    });
  }
  const profile = buildSeatbeltProfile({ executable, roots });
  return Object.freeze({
    command: primitive.executable,
    args: Object.freeze(['-p', profile, executable, ...args]),
    cwd: roots.cwd,
    env,
    proof: Object.freeze({
      schema: HOST_ISOLATION_SCHEMA,
      mode: HOST_ISOLATION_MODE,
      primitive: HOST_ISOLATION_PRIMITIVE,
      brokerFd: BROKER_FD,
      cwdBinding: 'kernel-inherited-directory-cwd',
      launchBoundary: HOST_ISOLATION_LAUNCH_BOUNDARY,
      workspace: roots.workspace,
      allowedWriteRoots: roots.allowedWriteRoots,
      workspaceReadSetDigest: readSetDigest,
    }),
  });
}

function scanAuthority(value, pathValue = 'value', seen = new Set(), depth = 0, state = { count: 0 }) {
  if (depth > MAX_BROKER_NESTING || ++state.count > MAX_BROKER_NODES) {
    fail(BROKER_PROTOCOL_ERROR, 'mediated broker payload exceeds the structural bound');
  }
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_BROKER_STRING_BYTES || AUTHORITY_VALUE.test(value)) {
      fail(BROKER_PROTOCOL_ERROR, `mediated broker payload contains prohibited material at ${pathValue}`);
    }
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      fail(BROKER_PROTOCOL_ERROR, `mediated broker payload contains a non-finite number at ${pathValue}`);
    }
    return;
  }
  if (typeof value !== 'object' || !isPlainObject(value) && !Array.isArray(value)) {
    fail(BROKER_PROTOCOL_ERROR, `mediated broker payload is not JSON data at ${pathValue}`);
  }
  if (seen.has(value)) fail(BROKER_PROTOCOL_ERROR, 'mediated broker payload is cyclic');
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanAuthority(entry, `${pathValue}[${index}]`, seen, depth + 1, state));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (AUTHORITY_KEY.test(key)) fail(BROKER_PROTOCOL_ERROR, `mediated broker payload contains prohibited key ${key}`);
      scanAuthority(entry, `${pathValue}.${key}`, seen, depth + 1, state);
    }
  }
  seen.delete(value);
}

function isNetworkLike(value) {
  return NETWORK_URL.test(value)
    || URI_SCHEME.test(value)
    || NETWORK_LITERAL.test(value)
    || NETWORK_HOST.test(value)
    || /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):\d{1,5}(?:[/?#].*)?$/i.test(value)
    || /(?:^|\s)(?:https?|wss?|ftp):\/\//i.test(value);
}

function fileUrlPath(value, label) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'file:' || parsed.hostname) {
      fail(HOST_ISOLATION_BOUNDARY_MISMATCH, `${label} must not address a network host`);
    }
    return fileURLToPath(parsed);
  } catch (error) {
    if (error instanceof AiCliError) throw error;
    fail(HOST_ISOLATION_BOUNDARY_MISMATCH, `${label} is not a valid local file URL`);
  }
}

function canonicalInputPath(value, label, scope, write) {
  const candidate = canonicalPath(value, label);
  const roots = write ? scope.allowedWriteRoots : [scope.workspace, ...scope.allowedReadRoots];
  if (!roots.some((root) => isWithin(candidate, root))) {
    fail(HOST_ISOLATION_BOUNDARY_MISMATCH, `${label} is outside the mediated workspace boundary`);
  }
  if (scope.protectedPaths.some((protectedPath) => isWithin(candidate, protectedPath) || isWithin(protectedPath, candidate))) {
    fail(HOST_ISOLATION_BOUNDARY_MISMATCH, `${label} overlaps a protected path`);
  }
  return candidate;
}

function validateBrokerString(value, scope, pathValue, context) {
  if (Buffer.byteLength(value, 'utf8') > MAX_BROKER_STRING_BYTES) {
    fail(BROKER_PROTOCOL_ERROR, `${pathValue} exceeds the mediated string bound`);
  }
  if (context.shellIntent || SHELL_FRAGMENT.test(value)) {
    fail(BROKER_PROTOCOL_ERROR, `${pathValue} contains shell-like input`);
  }
  if (context.browserIntent || /^javascript:/i.test(value)) {
    fail(BROKER_PROTOCOL_ERROR, `${pathValue} contains browser-like input`);
  }
  if (/^file:/i.test(value)) {
    const localPath = fileUrlPath(value, pathValue);
    canonicalInputPath(localPath, pathValue, scope, context.writeIntent);
    return;
  }
  if (context.networkIntent || isNetworkLike(value)) {
    fail(HOST_ISOLATION_BOUNDARY_MISMATCH, `${pathValue} addresses an undeclared network boundary`);
  }
  const pathLike = context.pathIntent || context.writeIntent || isAbsolute(value) || PATH_SEPARATOR.test(value);
  if (!pathLike) return;
  if (!isAbsolute(value)) {
    fail(HOST_ISOLATION_BOUNDARY_MISMATCH, `${pathValue} must be an absolute path within the mediated boundary`);
  }
  canonicalInputPath(value, pathValue, scope, context.writeIntent);
}

function validateBrokerInput(
  value,
  scope,
  pathValue = 'input',
  context = { pathIntent: false, writeIntent: false, shellIntent: false, browserIntent: false },
  seen = new Set(),
  depth = 0,
  state = { count: 0 },
) {
  if (depth > MAX_BROKER_NESTING || ++state.count > MAX_BROKER_NODES) {
    fail(BROKER_PROTOCOL_ERROR, 'mediated broker input exceeds the structural bound');
  }
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    validateBrokerString(value, scope, pathValue, context);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (context.networkIntent) {
      fail(HOST_ISOLATION_BOUNDARY_MISMATCH, `${pathValue} addresses an undeclared network boundary`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      fail(BROKER_PROTOCOL_ERROR, `${pathValue} must contain JSON data`);
    }
    return;
  }
  if (typeof value !== 'object' || (!isPlainObject(value) && !Array.isArray(value))) {
    fail(BROKER_PROTOCOL_ERROR, `${pathValue} must contain JSON data`);
  }
  if (seen.has(value)) fail(BROKER_PROTOCOL_ERROR, 'mediated broker input is cyclic');
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateBrokerInput(
      entry,
      scope,
      `${pathValue}[${index}]`,
      context,
      seen,
      depth + 1,
      state,
    ));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      const keyPath = `${pathValue}.${key}`;
      const pathIntent = context.pathIntent || PATH_INPUT_KEY.test(key);
      const writeIntent = context.writeIntent || WRITE_INPUT_KEY.test(key);
      validateBrokerInput(
        entry,
        scope,
        keyPath,
        {
          pathIntent,
          writeIntent,
          shellIntent: context.shellIntent || SHELL_INPUT_KEY.test(key),
          browserIntent: context.browserIntent || BROWSER_INPUT_KEY.test(key),
          networkIntent: context.networkIntent || NETWORK_INPUT_KEY.test(key),
        },
        seen,
        depth + 1,
        state,
      );
    }
  }
  seen.delete(value);
}

function protocolResponse(requestId, payload) {
  return { protocol: HOST_ISOLATION_BROKER_PROTOCOL, requestId, ...payload };
}

function errorResponse(requestId, code, message) {
  return protocolResponse(requestId ?? null, { ok: false, error: { code, message } });
}

function safeResponse(requestId, value, scope) {
  scanAuthority(value, 'broker.result');
  validateBrokerInput(value, scope, 'broker.result');
  const response = protocolResponse(requestId, { ok: true, result: value ?? null });
  const encoded = JSON.stringify(response);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BROKER_RESPONSE_BYTES) {
    return errorResponse(requestId, BROKER_PROTOCOL_ERROR, 'mediated broker response exceeds the frame bound');
  }
  return response;
}

function validateBrokerRequest(raw, scope) {
  if (!isPlainObject(raw)) fail(BROKER_PROTOCOL_ERROR, 'mediated broker request must be an object');
  const unknown = Object.keys(raw).filter((key) => !['protocol', 'requestId', 'tool', 'input'].includes(key));
  if (unknown.length > 0) fail(BROKER_PROTOCOL_ERROR, 'mediated broker request contains an unknown field');
  if (raw.protocol !== HOST_ISOLATION_BROKER_PROTOCOL) fail(BROKER_PROTOCOL_ERROR, 'mediated broker protocol mismatch');
  if (typeof raw.requestId !== 'string' || !BROKER_REQUEST_ID.test(raw.requestId)) fail(BROKER_PROTOCOL_ERROR, 'mediated broker requestId is invalid');
  if (AUTHORITY_VALUE.test(raw.requestId)) fail(BROKER_PROTOCOL_ERROR, 'mediated broker requestId contains prohibited material');
  if (typeof raw.tool !== 'string' || !TOOL_NAME.test(raw.tool)) fail(BROKER_PROTOCOL_ERROR, 'mediated broker tool is invalid');
  const input = raw.input === undefined ? {} : raw.input;
  if (!isPlainObject(input)) fail(BROKER_PROTOCOL_ERROR, 'mediated broker input must be an object');
  scanAuthority(input, 'broker.input');
  validateBrokerInput(input, scope);
  return Object.freeze({ requestId: raw.requestId, tool: raw.tool, input });
}

const COORDINATOR_TOOL_FIELDS = Object.freeze({
  'webmcp.listTools': Object.freeze(new Set(['tabId'])),
  'webmcp.invokeTool': Object.freeze(new Set(['toolName', 'input', 'frame', 'tabId'])),
});
const WEBMCP_PAGE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

function validateCoordinatorToolInput(tool, input, scope) {
  const fields = COORDINATOR_TOOL_FIELDS[tool];
  if (!fields) fail(UNLISTED_MCP_TOOL_DENIED, `coordinator dispatcher does not implement ${tool}`);
  const unknown = Object.keys(input).filter((key) => !fields.has(key));
  if (unknown.length > 0) {
    fail(BROKER_PROTOCOL_ERROR, `coordinator dispatcher input has unknown field(s): ${unknown.sort().join(', ')}`);
  }
  if (input.tabId !== undefined && (!Number.isInteger(input.tabId) || input.tabId < 0 || input.tabId > 2 ** 31 - 1)) {
    fail(BROKER_PROTOCOL_ERROR, 'coordinator dispatcher tabId must be a bounded integer');
  }
  if (tool === 'webmcp.invokeTool') {
    if (typeof input.toolName !== 'string' || !WEBMCP_PAGE_TOOL_NAME.test(input.toolName)) {
      fail(BROKER_PROTOCOL_ERROR, 'webmcp.invokeTool requires a bounded page toolName');
    }
    if (input.input !== undefined && !isPlainObject(input.input)) {
      fail(BROKER_PROTOCOL_ERROR, 'webmcp.invokeTool input must be an object');
    }
    if (input.frame !== undefined && (typeof input.frame !== 'string' || input.frame.length > 256)) {
      fail(BROKER_PROTOCOL_ERROR, 'webmcp.invokeTool frame must be a bounded string');
    }
  }
  validateBrokerInput(input, scope, 'broker.input');
}

/**
 * Closed coordinator-owned broker implementation table. A trusted JSON file
 * selects only an identifier; it cannot select a module, source string,
 * callback, executable or other code-bearing authority.
 */
function resolveBrokerImplementation(implementation, dispatcher = null) {
  if (implementation !== HOST_ISOLATION_BROKER_IMPLEMENTATION) {
    fail(HOST_ISOLATION_BROKER_REQUIRED, `unknown coordinator-owned broker implementation ${String(implementation)}`);
  }
  return async ({ tool, input, scope }) => {
    if (COORDINATOR_DISPATCH_TOOLS.includes(tool)) {
      if (typeof dispatcher !== 'function') {
        fail(HOST_ISOLATION_DISPATCHER_REQUIRED,
          'mediated WebMCP browser dispatch requires a coordinator-owned runtime callback');
      }
      validateCoordinatorToolInput(tool, input, scope);
      const request = deepFreezeJson({
        schema: COORDINATOR_DISPATCH_REQUEST_SCHEMA,
        tool,
        input: deepFreezeJson(input),
        dispatchId: scope.dispatchId,
        taskId: scope.taskId,
        fenceEpoch: scope.fenceEpoch,
      });
      try {
        return await dispatcher(request);
      } catch {
        // The callback is coordinator-owned code, but its errors must not cross
        // the worker boundary: permit, profile, gateway and implementation
        // details remain outside the model-visible broker protocol.
        fail(BROKER_PROTOCOL_ERROR, 'coordinator dispatcher rejected the mediated request');
      }
    }
    if (tool !== 'webmcp.echo') {
      fail(UNLISTED_MCP_TOOL_DENIED, `coordinator-owned broker does not implement ${tool}`);
    }
    // `permission: "required"` is the broker's typed, non-secret signal for
    // an operation that needs an explicit coordinator decision. It is kept on
    // the real mediated invoke path so PERMISSION_REQUIRED is not merely a
    // constants/schema/guide declaration.
    if (input.permission === 'required') {
      fail(PERMISSION_REQUIRED, 'mediated operation requires explicit permission resolution');
    }
    if (input.message !== undefined && typeof input.message !== 'string') {
      fail(BROKER_PROTOCOL_ERROR, 'webmcp.echo message must be a string');
    }
    return { echoed: input.message ?? null };
  };
}

function handleBrokerConnection(socket, { scope, allowedTools, invoke, activeSockets }) {
  activeSockets.add(socket);
  socket.setNoDelay?.(true);
  let buffered = Buffer.alloc(0);
  let requestCount = 0;
  let chain = Promise.resolve();
  const close = () => activeSockets.delete(socket);
  socket.once('close', close);
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk) => {
    if (buffered.length + chunk.length > MAX_BROKER_FRAME_BYTES) {
      socket.end(`${JSON.stringify(errorResponse(null, BROKER_PROTOCOL_ERROR, 'mediated broker frame exceeds the bound'))}\n`);
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    let newline = buffered.indexOf(0x0a);
    while (newline >= 0) {
      const line = buffered.subarray(0, newline).toString('utf8');
      buffered = buffered.subarray(newline + 1);
      requestCount += 1;
      if (requestCount > MAX_BROKER_REQUESTS) {
        socket.end(`${JSON.stringify(errorResponse(null, BROKER_PROTOCOL_ERROR, 'mediated broker request limit exceeded'))}\n`);
        return;
      }
      chain = chain.then(async () => {
        let requestId = null;
        try {
          const raw = JSON.parse(line);
          requestId = typeof raw?.requestId === 'string'
            && BROKER_REQUEST_ID.test(raw.requestId)
            && !AUTHORITY_VALUE.test(raw.requestId)
            ? raw.requestId
            : null;
          const request = validateBrokerRequest(raw, scope);
          if (!allowedTools.includes(request.tool)) {
            socket.write(`${JSON.stringify(errorResponse(request.requestId, UNLISTED_MCP_TOOL_DENIED, 'tool is not in the trusted mediated allow-list'))}\n`);
            return;
          }
          const result = await invoke({
            tool: request.tool,
            input: request.input,
            requestId: request.requestId,
            scope,
          });
          socket.write(`${JSON.stringify(safeResponse(request.requestId, result, scope))}\n`);
        } catch (error) {
          const code = error instanceof AiCliError && [
            HOST_ISOLATION_BOUNDARY_MISMATCH,
            UNLISTED_MCP_TOOL_DENIED,
            PERMISSION_REQUIRED,
          ].includes(error.code)
            ? error.code
            : BROKER_PROTOCOL_ERROR;
          socket.write(`${JSON.stringify(errorResponse(requestId, code, 'mediated broker request denied'))}\n`);
        }
      });
      newline = buffered.indexOf(0x0a);
    }
  });
}

function socketFileName(dispatchId) {
  // macOS sun_path is short. The private state-root IPC directory is already
  // per-machine/per-coordination-owned; keep only a compact dispatch prefix
  // in the socket name so deep temporary roots cannot make listen(2) fail.
  return `b-${createHash('sha256').update(dispatchId).digest('hex').slice(0, 8)}.sock`;
}

function removeSocketIfSafe(socketPath) {
  try {
    const stats = lstatSync(socketPath);
    if (!stats.isSocket()) fail('POLICY_DENIED', 'managed broker socket path is occupied by a non-socket');
    unlinkSync(socketPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error instanceof AiCliError) throw error;
    fail('POLICY_DENIED', 'managed broker socket could not be removed safely');
  }
}

/**
 * Create the one trusted mediated channel used by an isolated owned process.
 * The endpoint is unlinked immediately after the supervisor obtains the
 * connected client FD; the child receives only that inherited FD, never a
 * path, token, capability file or broker authority object.
 */
export async function createMediatedToolBroker({
  socketRoot,
  dispatchId,
  bindingId,
  taskId,
  fenceEpoch,
  task,
  broker,
  dispatcher = null,
} = {}) {
  const normalizedRoot = absolutePath(socketRoot, 'managed broker socket root');
  const normalizedDispatchId = boundedString(dispatchId, 'dispatchId', 256);
  const normalizedBindingId = boundedString(bindingId, 'bindingId', 256);
  const normalizedTaskId = boundedString(taskId, 'taskId', 256);
  if (!Number.isInteger(fenceEpoch) || fenceEpoch < 0) fail('ORCHESTRATION_INVALID_INPUT', 'managed broker fenceEpoch must be a non-negative integer');
  const trusted = assertTrustedMediatedBroker({ mode: HOST_ISOLATION_MODE, broker });
  const trustedDispatcher = assertCoordinatorDispatcher(dispatcher);
  if (trusted.allowedTools.some((tool) => COORDINATOR_DISPATCH_TOOLS.includes(tool)) && !trustedDispatcher) {
    fail(HOST_ISOLATION_DISPATCHER_REQUIRED,
      'the configured WebMCP browser tool allow-list requires a coordinator-owned runtime callback');
  }
  const invoke = resolveBrokerImplementation(trusted.implementation, trustedDispatcher);
  const scope = normalizeScope(task);
  try {
    mkdirSync(normalizedRoot, { recursive: true, mode: 0o700 });
    const rootStats = lstatSync(normalizedRoot);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      fail('POLICY_DENIED', 'managed broker socket root must be a private directory');
    }
  } catch (error) {
    if (error instanceof AiCliError) throw error;
    fail(HOST_ISOLATION_BROKER_REQUIRED, 'managed broker socket root is unavailable');
  }
  assertPosixMode(normalizedRoot, 0o700, 'managed broker socket root');
  const socketPath = join(normalizedRoot, socketFileName(normalizedDispatchId));
  removeSocketIfSafe(socketPath);
  const activeSockets = new Set();
  let firstConnectionResolve;
  const firstConnection = new Promise((resolvePromise) => {
    firstConnectionResolve = resolvePromise;
  });
  let accepted = false;
  const server = net.createServer((socket) => {
    if (accepted) {
      socket.destroy();
      return;
    }
    accepted = true;
    handleBrokerConnection(socket, {
      scope: Object.freeze({
        schema: `${HOST_ISOLATION_SCHEMA}/broker-scope`,
        dispatchId: normalizedDispatchId,
        bindingId: normalizedBindingId,
        taskId: normalizedTaskId,
        fenceEpoch,
        workspace: scope.workspace,
        allowedReadRoots: scope.allowedReadRoots,
        allowedWriteRoots: scope.allowedWriteRoots,
        protectedPaths: scope.protectedPaths,
      }),
      allowedTools: trusted.allowedTools,
      invoke,
      activeSockets,
    });
    firstConnectionResolve(socket);
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('listening', resolvePromise);
    server.once('error', (error) => rejectPromise(new AiCliError(
      HOST_ISOLATION_BROKER_REQUIRED,
      'managed broker could not bind its private socket',
      { exitCode: 2, details: { cause: error?.code ?? 'ERROR' } },
    )));
    server.listen(socketPath);
  });
  assertPosixMode(socketPath, 0o600, 'managed broker socket');
  const client = await new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPromise(new AiCliError(HOST_ISOLATION_BROKER_REQUIRED, 'managed broker client connection timed out'));
    }, 2_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolvePromise(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      rejectPromise(new AiCliError(HOST_ISOLATION_BROKER_REQUIRED, `managed broker client connection failed: ${error.code ?? 'ERROR'}`));
    });
  });
  await firstConnection;
  // No second local process can discover/connect to this channel. Existing
  // accepted/client descriptors remain valid after unlinking the name.
  removeSocketIfSafe(socketPath);
  const serverClosed = new Promise((resolvePromise) => {
    if (!server.listening) {
      resolvePromise();
      return;
    }
    server.close(() => resolvePromise());
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    client.destroy();
    for (const socket of activeSockets) socket.destroy();
    await serverClosed;
    removeSocketIfSafe(socketPath);
  };
  const result = {
    schema: HOST_ISOLATION_SCHEMA,
    mode: HOST_ISOLATION_MODE,
    socket: client,
    socketPath,
    brokerFd: BROKER_FD,
    implementation: trusted.implementation,
    allowedTools: trusted.allowedTools,
    proof: Object.freeze({
      schema: HOST_ISOLATION_SCHEMA,
      mode: HOST_ISOLATION_MODE,
      primitive: HOST_ISOLATION_PRIMITIVE,
      brokerFd: BROKER_FD,
      implementation: trusted.implementation,
      mediated: true,
    }),
    close,
  };
  Object.defineProperty(result, TRUSTED_MEDIATED_TOOL_BROKER, {
    value: Object.freeze({
      implementation: result.implementation,
      allowedTools: result.allowedTools,
      socket: result.socket,
      close: result.close,
    }),
  });
  return Object.freeze(result);
}
