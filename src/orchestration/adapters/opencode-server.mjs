import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import { AiCliError } from '../../errors.mjs';
import { writeAtomicJson } from '../atomic-file.mjs';
import { validateAdapter } from './index.mjs';
import { normalizeOpenCodeEvent, createEventDeduper } from './opencode-events.mjs';

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
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
  try {
    process.chmod?.(dbDir, 0o700);
  } catch {
    // chmod best-effort on platforms without POSIX modes.
  }
  const dbPath = join(dbDir, 'opencode.db');
  return Object.freeze({ dbDir, dbPath, databaseIdentity: sha256(dbPath) });
}

/**
 * Build the isolated launch environment for a runtime-owned server. HOME and
 * the caller's XDG_DATA_HOME are preserved untouched; isolation comes from
 * explicit flags plus a dispatch-private config root.
 */
export function buildIsolatedEnv({ dbPath, dispatchPrivateDir, password, baseEnv = {}, port, streamFile }) {
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

function requestBasic(endpoint, method, path, authToken, body = null) {
  const headers = {
    authorization: `Basic ${Buffer.from(`webmcp:${authToken}`).toString('base64')}`,
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

    const port = await freeLoopbackPort();
    const password = randomBytes(24).toString('base64url');
    const env = buildIsolatedEnv({
      dbPath: prepared.dbPath,
      dispatchPrivateDir,
      password,
      port,
      streamFile,
      baseEnv: pickLaunchEnv(),
    });

    // Config preflight with the exact same environment.
    const preflight = await runBounded(openCodeBin, [...extraArgs, 'debug', 'config'], env);
    if (preflight.code !== 0) {
      throw new AiCliError('POLICY_DENIED', `opencode config preflight failed: ${preflight.stderr.slice(0, 300)}`);
    }

    const serverChild = spawn(openCodeBin, [...extraArgs, 'serve'], {
      cwd: workspace,
      env,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Every bootstrap failure path must tear the child down — a rejected
    // promise alone would orphan a live server holding its isolated env.
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
      const onData = (chunk) => {
        if (settled) return;
        buffered += chunk.toString('utf8');
        const newlineIndex = buffered.indexOf('\n');
        if (newlineIndex === -1) return;
        try {
          const ready = JSON.parse(buffered.slice(0, newlineIndex));
          finish(true, null, `http://127.0.0.1:${ready.port}`);
        } catch {
          finish(false, new AiCliError('PROVIDER_PROTOCOL_ERROR', 'server produced no valid ready line'));
        }
      };
      const bootstrapTimer = setTimeout(
        () => finish(false, new AiCliError('PROVIDER_PROTOCOL_ERROR', 'server bootstrap timed out')),
        options.bootstrapTimeoutMs ?? 15_000,
      );
      bootstrapTimer.unref?.();
      serverChild.stdout.on('data', onData);
      serverChild.once('exit', (code) => finish(false, new AiCliError('WORKER_PROCESS_LOST', `server exited during bootstrap (${code})`)));
    });

    // Prove the effective database matches the intended path; mismatch fails
    // closed instead of degrading to an ambient database.
    const intendedDbPath = options.forceIntendedDbPathForTest ?? prepared.dbPath;
    const dbProbe = await runBounded(openCodeBin, [...extraArgs, 'db', 'path', '--pure'], env);
    if (dbProbe.code !== 0 || dbProbe.stdout.trim() !== intendedDbPath) {
      sweepProcessGroup(serverChild, 'SIGKILL');
      throw new AiCliError(
        'POLICY_DENIED',
        `runtime database identity mismatch: resolved '${dbProbe.stdout.trim()}' != intended '${intendedDbPath}'`,
      );
    }

    const health = await requestBasic(endpoint, 'GET', '/global/health', password);
    if (!health.ok || health.json?.status !== 'ok') {
      sweepProcessGroup(serverChild, 'SIGKILL');
      throw new AiCliError('PROVIDER_PROTOCOL_ERROR', 'server health check failed');
    }

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
      const ssePromise = fetch(`${runtime.endpoint}/event`, {
        headers: { authorization: `Basic ${Buffer.from(`webmcp:${runtime.authToken}`).toString('base64')}` },
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok || !response.body) throw new AiCliError('PROVIDER_PROTOCOL_ERROR', 'SSE subscription rejected');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
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
      return { close: () => controller.abort(), connected: ssePromise };
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
     * released after settlement.
     */
    async stopServer(runtime, { release = false, settled = false } = {}) {
      const child = runtime.__serverChild;
      let stopped = false;
      if (isChildLive(child)) {
        sweepProcessGroup(child, 'SIGTERM');
        await Promise.race([
          new Promise((resolveExit) => child.once('exit', resolveExit)),
          new Promise((resolveTick) => setTimeout(resolveTick, 1500).unref?.()),
        ]);
        if (isChildLive(child)) sweepProcessGroup(child, 'SIGKILL');
        stopped = true;
      }
      let released = false;
      if (release) {
        if (!settled) {
          throw new AiCliError('POLICY_DENIED', 'runtime sessions may only be released after settlement');
        }
        const insideRuntimeTree = runtime.dbPath.includes('webmcp-ai-runtime');
        const protectedHit = (options.protectedPathsForTest ?? []).some(
          (guarded) => !relative(guarded, runtime.dbPath).startsWith('..'),
        );
        if (protectedHit || !insideRuntimeTree) {
          throw new AiCliError('POLICY_DENIED', 'refusing to release a database outside the runtime-owned tree');
        }
        released = true;
      }
      return {
        action: 'cleanup_recorded',
        disposition: stopped ? 'stopped' : 'already-exited',
        retained: !released,
        released,
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
