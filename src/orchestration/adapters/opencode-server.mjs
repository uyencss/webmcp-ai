import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, readdirSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { AiCliError } from '../../errors.mjs';
import { writeAtomicJson } from '../atomic-file.mjs';
import { validateAdapter } from './index.mjs';
import { normalizeOpenCodeEvent, createEventDeduper } from './opencode-events.mjs';
import { createPlatformIdentityDeps } from '../process-identity.mjs';
import { resolveOpencodeCliDb } from '../../providers/opencode.mjs';

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

const POSIX_MODES = process.platform !== 'win32';
const RUNTIME_DIR_MODE = 0o700;
const RUNTIME_FILE_MODE = 0o600;

/**
 * Enforce and then VERIFY a POSIX mode. A mode that cannot be proven is a
 * hard failure, never a warning.
 */
function enforceMode(targetPath, mode, kind) {
  if (!POSIX_MODES) return;
  chmodSync(targetPath, mode);
  const actual = statSync(targetPath).mode & 0o777;
  if (actual !== mode) {
    throw new AiCliError('POLICY_DENIED', `runtime ${kind} permissions could not be enforced (${actual.toString(8)} != ${mode.toString(8)})`);
  }
}

const KNOWN_DATABASE_SIDECARS = new Set([
  'opencode.db-wal',
  'opencode.db-shm',
  'opencode.db-journal',
  'sessions.json',
]);

/**
 * Prove the binding directory is still a real directory inside its real
 * parent — catching post-prepare symlink/path-substitution attacks.
 */
function proveIsolatedDatabaseLocation(dbPath) {
  const dbDir = dirname(dbPath);
  let dirStats;
  try {
    dirStats = lstatSync(dbDir);
  } catch {
    throw new AiCliError('POLICY_DENIED', 'runtime database directory vanished before identity proof');
  }
  if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
    throw new AiCliError('POLICY_DENIED', 'runtime database directory is not a real directory');
  }
  const realDir = realpathSync(dbDir);
  if (realDir !== join(realpathSync(dirname(dbDir)), basename(dbDir))) {
    throw new AiCliError('POLICY_DENIED', 'runtime database directory resolves outside its binding');
  }
  if (existsSync(dbPath)) {
    const fileStats = lstatSync(dbPath);
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      throw new AiCliError('POLICY_DENIED', 'runtime database path is not a regular file');
    }
  }
}

/**
 * Prove that a runtime's database path is exactly one isolated, runtime-owned
 * binding directory before any deletion is authorized. Every unprovable
 * property fails closed and retains the files.
 */
function proveReleaseIdentity(runtime, { protectedPaths = [] } = {}) {
  const dbPath = typeof runtime?.dbPath === 'string' ? runtime.dbPath : null;
  if (!dbPath || !isAbsolute(dbPath)) {
    throw new AiCliError('POLICY_DENIED', 'release refused: database path is not an absolute proven path');
  }
  if (runtime.databaseIdentity !== sha256(dbPath)) {
    throw new AiCliError('POLICY_DENIED', 'release refused: database identity digest does not match its path');
  }
  const dbDir = dirname(dbPath);
  if (!/^worker_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(basename(dbDir))) {
    throw new AiCliError('POLICY_DENIED', 'release refused: database does not live in a runtime binding directory');
  }
  if (basename(dirname(dbDir)) !== 'webmcp-ai-runtime') {
    throw new AiCliError('POLICY_DENIED', 'release refused: binding directory is not inside the webmcp-ai-runtime tree');
  }
  if (basename(dbPath) !== 'opencode.db') {
    throw new AiCliError('POLICY_DENIED', 'release refused: unexpected database file name');
  }
  for (const guarded of protectedPaths) {
    if (!relative(guarded, dbPath).startsWith('..')) {
      throw new AiCliError('POLICY_DENIED', 'refusing to release a protected or user-owned database');
    }
  }
  proveIsolatedDatabaseLocation(dbPath);
  return { dbDir };
}

/**
 * Machine-local OpenCode application-data root per platform. Never hardcoded
 * to ~/.local/share across operating systems.
 */
export function resolveOpencodeDataRoot({ env = {}, platform = process.platform, homeDir } = {}) {
  const home = homeDir ?? homedir();
  switch (platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'opencode');
    case 'linux':
      return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode');
    case 'win32':
      return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'opencode');
    default:
      throw new AiCliError('ORCHESTRATION_UNSUPPORTED_VERSION', `platform ${platform} has no opencode data root mapping`, { exitCode: 2 });
  }
}

function assertNoSymlinkSegments(rootPath, leafRelative) {
  let cursor = rootPath;
  const segments = leafRelative.split(/[\\/]/).filter(Boolean);
  for (const segment of segments) {
    cursor = join(cursor, segment);
    if (existsSync(cursor)) {
      const stats = lstatSync(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new AiCliError('POLICY_DENIED', `runtime database path segment is not a safe directory: ${segment}`);
      }
    }
  }
  mkdirSync(cursor, { recursive: true, mode: 0o700 });
  const real = realpathSync(cursor);
  if (real !== realpathSync(rootPath) + '/' + segments.join('/') && real !== join(realpathSync(rootPath), ...segments)) {
    throw new AiCliError('POLICY_DENIED', 'runtime database directory resolution mismatch');
  }
}

/**
 * Create and canonicalize one runtime-owned database directory per binding.
 * Rejects symlink escapes, enforces 0700, and never touches the user-owned
 * default db or the shared one-shot opencode-cli.db.
 */
export function prepareRuntimeDatabase({ dataRoot, bindingId }) {
  if (!/^worker_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(bindingId)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'binding id must use the worker_ prefix', { exitCode: 2 });
  }
  if (!isAbsolute(dataRoot)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'opencode data root must be absolute', { exitCode: 2 });
  }
  const runtimeRoot = join(dataRoot, 'webmcp-ai-runtime');
  const leafRelative = join('webmcp-ai-runtime', bindingId);
  assertNoSymlinkSegments(dataRoot, leafRelative);
  const dbDir = join(runtimeRoot, bindingId);
  const stats = lstatSync(dbDir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AiCliError('POLICY_DENIED', 'runtime database directory is unsafe');
  }
  enforceMode(dbDir, RUNTIME_DIR_MODE, 'database directory');
  const dbPath = join(dbDir, 'opencode.db');
  // Reserve the database file identity so its mode is ours from creation,
  // never inherited from a provider-side default.
  if (!existsSync(dbPath)) closeSync(openSync(dbPath, 'a', RUNTIME_FILE_MODE));
  enforceMode(dbPath, RUNTIME_FILE_MODE, 'database file');
  return Object.freeze({ dbDir, dbPath, databaseIdentity: sha256(dbPath) });
}

/**
 * Build the isolated launch environment for a runtime-owned server. HOME and
 * the caller's XDG_DATA_HOME are preserved untouched; isolation comes from
 * explicit flags plus a dispatch-private config root.
 */
export function buildIsolatedEnv({ dbPath, dispatchPrivateDir, password, baseEnv = {}, port, streamFile, fakeReadyLine, fakeDbEcho, fakeSymlinkDbDir, fakeRequestLog, fakeIgnoreSigterm }) {
  if (!isAbsolute(dbPath)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'runtime db path must be absolute', { exitCode: 2 });
  }
  const configContent = {
    share: 'disabled',
    autoupdate: false,
    mdns: false,
    cors: [],
    plugin: [],
    mcp: {},
  };
  return {
    ...baseEnv,
    OPENCODE_DB: dbPath,
    XDG_CONFIG_HOME: join(dispatchPrivateDir, 'xdg-config'),
    OPENCODE_CONFIG: join(dispatchPrivateDir, 'opencode.json'),
    OPENCODE_CONFIG_DIR: join(dispatchPrivateDir, 'opencode.d'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_PURE: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(configContent),
    OPENCODE_SERVER_PASSWORD: password,
    WEBMCP_FAKE_SERVER_PASSWORD: password,
    ...(port !== undefined ? { WEBMCP_FAKE_PORT: String(port) } : {}),
    ...(streamFile ? { WEBMCP_FAKE_STREAM_FILE: streamFile } : {}),
    ...(fakeReadyLine ? { WEBMCP_FAKE_READY_LINE: fakeReadyLine } : {}),
    ...(fakeDbEcho ? { WEBMCP_FAKE_DB_ECHO: fakeDbEcho } : {}),
    ...(fakeSymlinkDbDir ? { WEBMCP_FAKE_SYMLINK_DB: '1' } : {}),
    ...(fakeRequestLog ? { WEBMCP_FAKE_REQ_LOG: fakeRequestLog } : {}),
    ...(fakeIgnoreSigterm ? { WEBMCP_FAKE_IGNORE_SIGTERM: '1' } : {}),
  };
}

async function freeLoopbackPort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = net.createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isLoopbackHost(host) {
  if (host === null) return true; // JSON ready dialect implies loopback-only binding.
  return LOOPBACK_HOSTS.has(String(host).toLowerCase().replace(/^\[|\]$/g, ''));
}

/**
 * Parse both documented ready dialects into {host, port}:
 * - fixture JSON: {"ready":true,"port":N} (no host field, loopback implied);
 * - pinned binary text: "opencode server listening on http://host:port".
 */
function parseReadyLine(line) {
  try {
    const ready = JSON.parse(line);
    if (Number.isInteger(ready?.port)) return { host: null, port: ready.port };
    if (typeof ready?.url === 'string') {
      const parsed = new URL(ready.url);
      if (/^\d{2,5}$/.test(parsed.port)) return { host: parsed.hostname, port: Number.parseInt(parsed.port, 10) };
    }
  } catch {
    const listening = line.match(/listening on\s+https?:\/\/(?:\[([a-f0-9:]+)\]|([^:\s/]+)):(\d{2,5})/i);
    if (listening) {
      return { host: listening[1] ?? listening[2], port: Number.parseInt(listening[3], 10) };
    }
  }
  return null;
}

function requestBasic(endpoint, method, path, authToken, body = null) {
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${authToken}`).toString('base64')}`,
  };
  if (body !== null) headers['content-type'] = 'application/json';
  return fetch(`${endpoint}${path}`, {
    method,
    headers,
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  }).then(async (response) => ({
    status: response.status,
    ok: response.ok,
    json: await response.json().catch(() => null),
  }));
}

/**
 * Signal the whole detached process group so no grandchild outlives the
 * server, falling back to pid-only signalling once the group is gone.
 */
function sweepProcessGroup(child, signal) {
  if (process.platform === 'win32') {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

function isChildLive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function runBounded(binPath, binArgs, env, timeoutMs = 15_000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(binPath, binArgs, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new AiCliError('PROVIDER_PROTOCOL_ERROR', 'opencode preflight timed out'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr: sanitizeValueText(stderr) });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
  });
}

function sanitizeValueText(text) {
  // Preflight stderr stays in memory only and never carries auth material.
  return text.replace(/authorization:[^\n]*/gi, '[REDACTED]').slice(0, 2000);
}

/**
 * Recovery-side release of a runtime-owned database via the durable cleanup
 * lease persisted in the runtime binding record. Every step fails closed and
 * RETAINS the tree when anything is unprovable:
 *
 *   1. the lease must exist, name ownership mode `runtime-owned` and carry a
 *      canonical path + matching sha256 identity;
 *   2. a HARD canonical denylist runs BEFORE any filesystem mutation: the
 *      user default `<dataRoot>/opencode.db` and the shared one-shot CLI db
 *      are refused no matter what the lease claims;
 *   3. the full structural proof (worker_* dir, webmcp-ai-runtime parent,
 *      opencode.db filename, isolated real directory) is re-run;
 *   4. death of the leased process/group must be PROVEN (ESRCH, or a
 *      successful identity probe proving the pid now belongs to someone
 *      else). A still-alive original or an unavailable probe retains.
 *   5. only then is the exact binding tree removed and absence proven over
 *      every known sidecar.
 */
export async function releaseRecoveredRuntimeDatabase(record, {
  env = {},
  homeDir = undefined,
} = {}) {
  const unproven = (reason) => ({
    released: false,
    retained: true,
    disposition: 'recovered-runtime-database-cleanup-unproven',
    reason,
    absenceProven: false,
  });
  const lease = record?.cleanupLease;
  if (!lease || typeof lease !== 'object') return unproven('no cleanup lease in the durable record');
  if (lease.ownershipMode !== 'runtime-owned') return unproven('lease ownershipMode is not runtime-owned');
  const dbPath = typeof lease.canonicalRuntimeDbPath === 'string' ? lease.canonicalRuntimeDbPath : null;
  if (!dbPath || !isAbsolute(dbPath)) return unproven('lease database path is missing or not absolute');

  // ---- HARD denylist FIRST: never mutate user-owned trees ---------------
  let defaultRoot = null;
  let sharedCliDb = null;
  try {
    defaultRoot = resolveOpencodeDataRoot({ env, ...(homeDir ? { homeDir } : {}) });
    sharedCliDb = resolveOpencodeCliDb(env, { homeDir: homeDir ?? homedir() });
  } catch {
    return unproven('protected canonical roots could not be resolved; refusing to delete anything');
  }
  const canonOf = (pathValue) => {
    try {
      return realpathSync(pathValue);
    } catch {
      return resolve(pathValue);
    }
  };
  const targetCanonical = canonOf(dbPath);
  // Production geometry places runtime-owned trees INSIDE the user data
  // root (<dataRoot>/webmcp-ai-runtime/worker_*/opencode.db). The denylist
  // therefore protects everything under the data root EXCEPT the dedicated
  // webmcp-ai-runtime subtree, plus the shared CLI database absolutely.
  const runtimeSubtreeRoot = join(defaultRoot, 'webmcp-ai-runtime');
  const relToRuntime = relative(canonOf(runtimeSubtreeRoot), targetCanonical);
  const insideRuntimeSubtree = relToRuntime !== '' && !relToRuntime.startsWith('..') && !isAbsolute(relToRuntime);
  if (!insideRuntimeSubtree) {
    for (const guarded of [join(defaultRoot, 'opencode.db'), sharedCliDb, defaultRoot]) {
      const guardedCanonical = canonOf(guarded);
      const relA = relative(guardedCanonical, targetCanonical);
      const insideOrEqual = (rel) => rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      if (insideOrEqual(relA)) {
        throw new AiCliError(
          'POLICY_DENIED',
          'refusing recovered release: lease targets a protected or user-owned database path',
          { details: { leasePath: String(lease.canonicalRuntimeDbPath), protectedPath: String(guarded) } },
        );
      }
    }
  }

  // ---- Structural + digest proof ----------------------------------------
  let proof;
  try {
    proof = proveReleaseIdentity({
      dbPath,
      databaseIdentity: lease.databaseIdentity,
    });
  } catch (error) {
    if (error instanceof AiCliError) return unproven(error.message);
    return unproven('structural proof failed');
  }

  // ---- Death proof on the leased process identity -----------------------
  const pid = lease.processIdentity?.pid;
  const startIdentity = lease.processIdentity?.startIdentity;
  if (!Number.isInteger(pid) || pid <= 0 || typeof startIdentity !== 'string' || startIdentity.length === 0) {
    return unproven('lease carries no provable process identity');
  }
  if (pid === process.pid) return unproven('self-pid-refused');
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  if (alive) {
    let holderIdentity = null;
    try {
      holderIdentity = await createPlatformIdentityDeps().getStartIdentity(pid);
    } catch {
      holderIdentity = null;
    }
    if (holderIdentity === startIdentity) return unproven('the leased runtime process is still alive');
    if (typeof holderIdentity !== 'string' || holderIdentity.length === 0) {
      return unproven('identity probe unavailable; death of the original cannot be proven');
    }
    // Probe succeeded AND mismatched: the ORIGINAL provably exited and its
    // pid now belongs to an unrelated process that we never touch.
  }

  // ---- Deletion authorized: enumerate allowlist, remove, prove absence --
  let removedFiles;
  try {
    removedFiles = readdirSync(proof.dbDir).sort();
  } catch {
    return unproven('isolated runtime directory could not be enumerated');
  }
  for (const name of removedFiles) {
    if (!KNOWN_DATABASE_SIDECARS.has(name) && name !== 'opencode.db') {
      return unproven(`unexpected file '${name}' inside the isolated runtime directory`);
    }
  }
  try {
    rmSync(proof.dbDir, { recursive: true, force: true });
  } catch (error) {
    throw new AiCliError('POLICY_DENIED', `runtime database cleanup failed: ${error?.code ?? error?.message}`);
  }
  const absenceProven =
    !existsSync(proof.dbDir)
    && !existsSync(dbPath)
    && ![...KNOWN_DATABASE_SIDECARS].some((sidecar) => existsSync(join(proof.dbDir, sidecar)));
  if (!absenceProven) return unproven('cleanup could not prove absence');
  return {
    released: true,
    retained: false,
    disposition: 'released',
    exitProven: true,
    removedFiles,
    absenceProven: true,
    databaseIdentity: lease.databaseIdentity,
  };
}

/**
 * Runtime-owned OpenCode server adapter. One private database per binding;
 * documented HTTP/SSE surface only; Basic Auth on every request; observer
 * attach is read-only forever.
 */
export function createOpenCodeServerAdapter(options = {}) {
  const openCodeBin = options.openCodeBin ?? process.env.OPENCODE_BIN ?? 'opencode';
  const extraArgs = options.openCodeArgs ?? [];
  const stateDir = options.stateDir;
  if (!stateDir) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'opencode adapter requires a machine-local state dir', { exitCode: 2 });
  }
  const streamFile = options.streamFile ?? null;

  function makeBinding(fields) {
    const required = ['sessionId', 'databaseIdentity', 'serverProcessIdentity', 'bindingId', 'ownershipMode', 'fenceEpoch'];
    for (const key of required) {
      if (!(key in fields)) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `binding missing ${key}`, { exitCode: 2 });
      }
    }
    return Object.freeze({ ...fields, __private: Object.freeze({ dbPath: fields.__private?.dbPath ?? null }) });
  }

  async function startRuntimeServer({ workspace, bindingId, fenceEpoch }) {
    const dataRoot = resolveOpencodeDataRoot({ env: options.env ?? {} });
    const prepared = prepareRuntimeDatabase({ dataRoot, bindingId });

    const dispatchPrivateDir = join(stateDir, 'runtime-config', bindingId);
    mkdirSync(join(dispatchPrivateDir, 'xdg-config'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dispatchPrivateDir, 'opencode.d'), { recursive: true, mode: 0o700 });
    writeAtomicJson(join(dispatchPrivateDir, 'opencode.json'), {
      $schema: 'https://opencode.ai/config.json',
      share: 'disabled',
      autoupdate: false,
      mdns: false,
      cors: [],
      plugin: [],
      mcp: {},
    });

    // Reserve the port up front and pass it explicitly: the reported ready
    // endpoint must equal THIS port or bootstrap fails closed.
    const requestedPort = options.requestedPortForTest ?? (await freeLoopbackPort());
    const password = randomBytes(24).toString('base64url');
    const env = buildIsolatedEnv({
      dbPath: prepared.dbPath,
      dispatchPrivateDir,
      password,
      port: requestedPort,
      streamFile,
      fakeReadyLine: options.readyLineForTest,
      fakeDbEcho: options.dbProbeEchoForTest,
      fakeSymlinkDbDir: options.symlinkDbDirForTest === true,
      fakeRequestLog: options.requestLogForTest,
      fakeIgnoreSigterm: options.ignoreSigtermForTest === true,
      baseEnv: pickLaunchEnv(),
    });

    // Config preflight with the exact same environment.
    const preflight = await runBounded(openCodeBin, [...extraArgs, 'debug', 'config'], env);
    if (preflight.code !== 0) {
      throw new AiCliError('POLICY_DENIED', `opencode config preflight failed: ${preflight.stderr.slice(0, 300)}`);
    }

    // Explicit port/hostname flags: the real binary ignores env-port hints and
    // otherwise binds its default 4096, colliding with ambient servers.
    const serverChild = spawn(openCodeBin, [...extraArgs, 'serve', '--port', String(requestedPort), '--hostname', '127.0.0.1'], {
      cwd: workspace,
      env,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Every bootstrap failure path must tear the child down — a rejected
    // promise alone would orphan a live server holding its isolated env.
    // Ready lines come in two dialects: the fixture emits JSON `{port}`, the
    // real pinned binary emits `opencode server listening on http://host:port`.
    const endpoint = await new Promise((resolveEndpoint, rejectEndpoint) => {
      let settled = false;
      let buffered = '';
      const finish = (settle, error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(bootstrapTimer);
        serverChild.stdout.off('data', onData);
        if (!settle) sweepProcessGroup(serverChild, 'SIGKILL');
        settle ? resolveEndpoint(value) : rejectEndpoint(error);
      };
      const consumeLines = () => {
        let newlineIndex = buffered.indexOf('\n');
        while (newlineIndex !== -1 && !settled) {
          const line = buffered.slice(0, newlineIndex).trim();
          buffered = buffered.slice(newlineIndex + 1);
          const parsed = parseReadyLine(line);
          if (parsed) {
            if (parsed.port !== requestedPort) {
              finish(
                false,
                new AiCliError(
                  'PROVIDER_PROTOCOL_ERROR',
                  `ready line reported port ${parsed.port} which does not match the requested port ${requestedPort}`,
                ),
              );
            } else if (!isLoopbackHost(parsed.host)) {
              finish(false, new AiCliError('PROVIDER_PROTOCOL_ERROR', `ready line reported non-loopback host '${parsed.host}'`));
            } else {
              finish(true, null, `http://127.0.0.1:${requestedPort}`);
            }
            return;
          }
          newlineIndex = buffered.indexOf('\n');
        }
      };
      const onData = (chunk) => {
        if (settled) return;
        buffered += chunk.toString('utf8');
        if (buffered.length > 64 * 1024) {
          finish(false, new AiCliError('PROVIDER_PROTOCOL_ERROR', 'server produced no valid ready line'));
          return;
        }
        consumeLines();
      };
      const bootstrapTimer = setTimeout(
        () => finish(false, new AiCliError('PROVIDER_PROTOCOL_ERROR', 'server bootstrap timed out')),
        options.bootstrapTimeoutMs ?? 15_000,
      );
      bootstrapTimer.unref?.();
      serverChild.stdout.on('data', onData);
      serverChild.once('exit', (code) => finish(false, new AiCliError('WORKER_PROCESS_LOST', `server exited during bootstrap (${code})`)));
    });

    // Prove the effective database matches the intended canonical path;
    // mismatch or symlink substitution fails closed instead of degrading to an
    // ambient database.
    const intendedDbPath = options.forceIntendedDbPathForTest ?? prepared.dbPath;
    let dbProbe;
    try {
      dbProbe = await runBounded(openCodeBin, [...extraArgs, 'db', 'path', '--pure'], env);
    } catch (error) {
      sweepProcessGroup(serverChild, 'SIGKILL');
      throw error;
    }
    if (dbProbe.code !== 0 || dbProbe.stdout.trim() !== intendedDbPath) {
      sweepProcessGroup(serverChild, 'SIGKILL');
      throw new AiCliError(
        'POLICY_DENIED',
        `runtime database identity mismatch: resolved '${dbProbe.stdout.trim()}' != intended '${intendedDbPath}'`,
      );
    }
    try {
      proveIsolatedDatabaseLocation(prepared.dbPath);
    } catch (error) {
      sweepProcessGroup(serverChild, 'SIGKILL');
      throw error;
    }

    let health;
    try {
      health = await requestBasic(endpoint, 'GET', '/global/health', password);
    } catch (error) {
      sweepProcessGroup(serverChild, 'SIGKILL');
      throw new AiCliError('PROVIDER_PROTOCOL_ERROR', `server health check failed: ${error?.cause?.code ?? error?.code ?? error?.message}`);
    }
    // Health dialects: the pinned real binary reports `{ healthy: true }`,
    // the packaged fixture reports `{ status: 'ok' }`; accept either.
    const healthOk = health.ok && (health.json?.status === 'ok' || health.json?.healthy === true);
    if (!healthOk) {
      sweepProcessGroup(serverChild, 'SIGKILL');
      throw new AiCliError('PROVIDER_PROTOCOL_ERROR', 'server health check failed');
    }
    // When the dialect exposes the effective db, it must be exactly the one we
    // bound into the child environment — before any session is created.
    if (typeof health.json?.openCodeDb === 'string' && health.json.openCodeDb !== prepared.dbPath) {
      sweepProcessGroup(serverChild, 'SIGKILL');
      throw new AiCliError('POLICY_DENIED', `server effective database mismatch: '${health.json.openCodeDb}' != '${prepared.dbPath}'`);
    }

    // Prove the server process start identity so the supervisor binding can
    // reattach, interrupt and reconcile exactly like an owned process. An
    // unavailable probe stays honestly unproven — never a fabricated value.
    const identityDeps = createPlatformIdentityDeps();
    const probedStartIdentity = await identityDeps.getStartIdentity(serverChild.pid).catch(() => null);
    const processIdentity = Object.freeze({
      pid: serverChild.pid,
      ...(probedStartIdentity ? { startIdentity: probedStartIdentity } : {}),
      processGroupId: serverChild.pid,
      identityProven: probedStartIdentity !== null,
      startedAt: Date.now(),
      endpoint,
    });

    const runtime = Object.freeze({
      endpoint,
      authToken: password,
      dbPath: prepared.dbPath,
      databaseIdentity: prepared.databaseIdentity,
      workspace,
      __serverChild: serverChild,
    });
    const binding = makeBinding({
      sessionId: null,
      databaseIdentity: prepared.databaseIdentity,
      // Unified identity surface: the supervisor records THIS field for
      // recovery/interrupt; serverProcessIdentity stays as diagnostic detail.
      processIdentity,
      serverProcessIdentity: { pid: serverChild.pid, startedAt: Date.now(), endpoint },
      bindingId,
      ownershipMode: 'runtime-owned',
      fenceEpoch,
      __private: { dbPath: prepared.dbPath },
    });
    void workspace;
    return { runtime, binding };
  }

  function pickLaunchEnv() {
    const source = options.env ?? process.env;
    // Preserve only safe ambient variables; never copy provider credentials
    // or auth stores into the launch environment record.
    const keep = {};
    for (const key of ['PATH', 'HOME', 'XDG_DATA_HOME', 'TMPDIR']) {
      if (source[key] !== undefined) keep[key] = source[key];
    }
    return keep;
  }

  const adapter = {
    id: 'opencode-server',
    maturity: 'fixture-only',
    capabilities: {
      liveEvents: true,
      explicitResume: true,
      externalAttach: true,
      questionChannel: false,
      permissionControl: true,
      sameTurnSteer: false,
      gracefulInterrupt: true,
      preToolGate: false,
      processOwnership: true,
      fileEvents: true,
      testEvents: true,
    },
    async probe({ env = {} } = {}) {
      const versionRun = await runBounded(openCodeBin, [...extraArgs, '--version'], pickEnvForProbe(env)).catch(() => ({ code: -1, stdout: '', stderr: '' }));
      const installedVersion = versionRun.stdout.trim();
      let sdkAvailable = false;
      try {
        const sdk = await import('@opencode-ai/sdk');
        sdkAvailable = Boolean(sdk);
      } catch {
        sdkAvailable = false;
      }
      const available = installedVersion === '1.18.21' && sdkAvailable;
      return {
        adapterId: this.id,
        available,
        installedVersion: installedVersion || null,
        sdkVersion: sdkAvailable ? '1.18.21' : null,
        maturity: this.maturity,
        capabilities: this.capabilities,
      };
    },
    startRuntimeServer,

    requestJson: (runtime, method, path, body = null) => requestBasic(runtime.endpoint, method, path, runtime.authToken, body),

    async createSession(runtime, sessionIdOverride = null) {
      const response = await this.requestJson(runtime, 'POST', '/session', sessionIdOverride ? { sessionIdOverride } : {});
      if (!response.ok) throw new AiCliError('PROVIDER_PROTOCOL_ERROR', 'session creation failed');
      return { sessionId: response.json.id };
    },

    subscribe(runtime, { onEvent, dedupeKeyPrefix = '' } = {}) {
      const deduper = createEventDeduper();
      const controller = new AbortController();
      // Readiness handshake: `connected` resolves as soon as the SSE response
      // is validated — BEFORE any event flows — so launch wrappers can order
      // subscription ahead of prompt_async deterministically.
      let resolveConnected;
      const connected = new Promise((resolveConnectedPromise) => { resolveConnected = resolveConnectedPromise; });
      const ssePromise = fetch(`${runtime.endpoint}/event`, {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${runtime.authToken}`).toString('base64')}` },
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok || !response.body) throw new AiCliError('PROVIDER_PROTOCOL_ERROR', 'SSE subscription rejected');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
        resolveConnected({ ok: true });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          let boundary = buffered.indexOf('\n\n');
          while (boundary !== -1) {
            const frame = buffered.slice(0, boundary);
            buffered = buffered.slice(boundary + 2);
            const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
            if (dataLine) {
              try {
                const event = JSON.parse(dataLine.slice(6));
                const mapped = normalizeOpenCodeEvent(event, null, deduper);
                if (mapped) onEvent({ ...mapped, dedupeKeyPrefix });
              } catch {
                // Malformed SSE payload is dropped defensively.
              }
            }
            boundary = buffered.indexOf('\n\n');
          }
        }
      });
      // Post-handshake stream errors (including abort-on-close) are already
      // surfaced through the reader loop; sink the promise itself so no
      // unhandled rejection escapes.
      ssePromise.catch(() => { /* subscriber closed or server gone */ });
      return {
        close: () => controller.abort(),
        connected: connected.catch(() => { /* subscriber closed or server gone */ }),
      };
    },

    async promptAsync(runtime, sessionId, text) {
      const response = await this.requestJson(runtime, 'POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        parts: [{ type: 'text', text }],
      });
      if (!response.ok) throw new AiCliError('PROVIDER_PROTOCOL_ERROR', 'prompt_async rejected');
      return response.json;
    },
    async readSession(runtime, sessionId) {
      const response = await this.requestJson(runtime, 'GET', `/session/${encodeURIComponent(sessionId)}`);
      return response.ok ? response.json : null;
    },
    respondPermission(bindingOrRuntime, permissionId, decision) {
      const { binding, runtime } = unwrapControlTarget(bindingOrRuntime);
      assertMutableOwnership(binding);
      return this.requestJson(runtime, 'POST', `/session/${encodeURIComponent(binding.sessionId)}/permissions/${encodeURIComponent(permissionId)}`, { response: decision });
    },
    async abortSession(bindingOrRuntime) {
      const { binding, runtime } = unwrapControlTarget(bindingOrRuntime);
      assertMutableOwnership(binding);
      return this.requestJson(runtime, 'POST', `/session/${encodeURIComponent(binding.sessionId)}/abort`, {});
    },
    async deleteSession(bindingOrRuntime) {
      const { binding, runtime } = unwrapControlTarget(bindingOrRuntime);
      assertMutableOwnership(binding);
      return this.requestJson(runtime, 'DELETE', `/session/${encodeURIComponent(binding.sessionId)}`);
    },

    async interrupt(bindingOrRuntime, { reason = '' } = {}) {
      const { binding } = unwrapControlTarget(bindingOrRuntime);
      assertMutableOwnership(binding);
      const result = await this.abortSession(bindingOrRuntime);
      return { ok: true, interrupted: true, reason, providerResult: result.json };
    },

    async close({ binding, runtime }) {
      if (!runtime) {
        throw new AiCliError('WORKER_IDENTITY_UNPROVEN', 'observer bindings own no server to close');
      }
      const receipt = await this.stopServer(runtime);
      void binding;
      return receipt;
    },

    attach({ sessionId }) {
      return this.attachExternal({ sessionId }).binding;
    },
    attachExternal({ sessionId, databaseIdentityHint = null }) {
      // Pre-existing external sessions stay observer-only: no control verbs,
      // no guessed database identity.
      return {
        binding: makeBinding({
          sessionId,
          databaseIdentity: databaseIdentityHint,
          serverProcessIdentity: null,
          bindingId: `worker_external_${randomBytes(4).toString('hex')}`,
          ownershipMode: 'attached-observer',
          fenceEpoch: null,
        }),
      };
    },

    resolvePermission(bindingOrRuntime, permissionId, decision) {
      return this.respondPermission(bindingOrRuntime, permissionId, decision);
    },

/**
 * Stop the owned server. Cleanup receipts record disposition; user-owned
     * default databases and the shared one-shot CLI database are never
     * touched; runtime-owned databases are retained unless explicitly
     * released after settlement. Release first PROVES the isolated database
     * identity, removes exactly that directory tree, and proves absence.
     */
    async stopServer(runtime, { release = false, settled = false } = {}) {
      const child = runtime.__serverChild;
      let stopped = false;
      let exitProven = !isChildLive(child);
      // An 'exit' event fires EXACTLY once: a listener attached after the
      // fact (or a second wait) would pend forever, and an unref'd fallback
      // timer vanishes whenever the owner's loop is otherwise empty. Both
      // waits below therefore check the child's settled state FIRST and keep
      // their bounded fallback timers ref'd so the proof always completes.
      const childSettled = () => child.exitCode !== null || child.signalCode !== null;
      const awaitChildExit = (timeoutMs) => {
        if (childSettled()) return Promise.resolve();
        return new Promise((resolveWait) => {
          child.once('exit', resolveWait);
          setTimeout(() => {
            child.off?.('exit', resolveWait);
            resolveWait();
          }, timeoutMs);
        });
      };
      if (isChildLive(child)) {
        sweepProcessGroup(child, 'SIGTERM');
        await awaitChildExit(1500);
        if (isChildLive(child)) sweepProcessGroup(child, 'SIGKILL');
        // PROOF, not assumption: the child must actually be dead before any
        // destructive cleanup is authorized. SIGKILL cannot be trapped, so a
        // trapped SIGTERM still terminates here.
        await awaitChildExit(2000);
        exitProven = !isChildLive(child);
        stopped = true;
      }
      let released = false;
      let removedFiles;
      let absenceProven;
      if (release) {
        if (!settled) {
          throw new AiCliError('POLICY_DENIED', 'runtime sessions may only be released after settlement');
        }
        if (!exitProven) {
          throw new AiCliError(
            'POLICY_DENIED',
            'release refused: server process death could not be proven; database retained',
          );
        }
        const proof = proveReleaseIdentity(runtime, { protectedPaths: options.protectedPathsForTest ?? [] });
        // Only now is deletion authorized: read the manifest, remove, and
        // prove absence of every known artifact.
        try {
          removedFiles = readdirSync(proof.dbDir).sort();
        } catch {
          throw new AiCliError('POLICY_DENIED', 'release refused: isolated runtime directory could not be enumerated');
        }
        for (const name of removedFiles) {
          if (!KNOWN_DATABASE_SIDECARS.has(name) && name !== 'opencode.db') {
            throw new AiCliError('POLICY_DENIED', `release refused: unexpected file '${name}' inside the isolated runtime directory`);
          }
        }
        try {
          rmSync(proof.dbDir, { recursive: true, force: true });
        } catch (error) {
          throw new AiCliError('POLICY_DENIED', `runtime database cleanup failed: ${error?.code ?? error?.message}`);
        }
        absenceProven =
          !existsSync(proof.dbDir) &&
          !existsSync(runtime.dbPath) &&
          ![...KNOWN_DATABASE_SIDECARS].some((side) => existsSync(join(proof.dbDir, side)));
        if (!absenceProven) {
          throw new AiCliError('POLICY_DENIED', 'runtime database cleanup could not prove absence');
        }
        released = true;
      }
      return {
        action: 'cleanup_recorded',
        disposition: stopped ? 'stopped' : 'already-exited',
        retained: !released,
        released,
        exitProven,
        ...(released ? { removedFiles, absenceProven } : {}),
        databaseIdentity: runtime.databaseIdentity,
      };
    },
    sendReply() {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'same-turn steering is not claimed by this adapter');
    },
    sendGuidance() {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'guidance uses follow-up turns via prompt_async');
    },
    sanitize(event) {
      return normalizeOpenCodeEvent(event, null, createEventDeduper());
    },
    spawn() {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'the opencode-server adapter owns servers, not raw processes');
    },
  };

  function assertMutableOwnership(binding) {
    if (!binding || binding.ownershipMode !== 'runtime-owned') {
      throw new AiCliError('WORKER_IDENTITY_UNPROVEN', 'observer bindings have no ownership over external sessions');
    }
  }

  function unwrapControlTarget(target) {
    if (target?.binding && target?.runtime) return target;
    if (target?.ownershipMode === 'attached-observer') return { binding: target, runtime: null };
    if (target?.endpoint) return { binding: { ownershipMode: 'runtime-owned', sessionId: target.__sessionId }, runtime: target };
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'unknown control target');
  }

  function pickEnvForProbe(env) {
    const keep = {};
    for (const key of ['PATH', 'HOME']) {
      if (env[key] !== undefined) keep[key] = env[key];
    }
    return keep;
  }

  validateAdapter(adapter);
  return adapter;
}
