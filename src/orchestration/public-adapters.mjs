import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { AiCliError } from '../errors.mjs';
import { validateAdapter } from './adapters/index.mjs';
import { createOwnedProcessAdapter } from './adapters/owned-process.mjs';
import { createOpenCodeServerAdapter } from './adapters/opencode-server.mjs';
import { createClaudeStreamAdapter } from './adapters/claude-stream.mjs';
import { createCodexExecAdapter } from './adapters/codex-exec.mjs';
import { renderWorkerPreamble } from './worker-callback.mjs';
import { canonicalizeExistingPrefix } from './verifier.mjs';

export const PUBLIC_ADAPTER_KINDS = Object.freeze([
  'owned-process',
  'opencode-server',
  'claude-stream',
  'codex-exec',
]);

/**
 * Trusted-coordinator adapter assembly. Everything behavioral (binaries,
 * fixture scripts, sandbox flags, disposable roots) arrives exclusively
 * through this configuration — never through a Task payload or IPC request.
 * `allowFixtureDispatch` is a dual-opt-in seam for canary/closure harnesses;
 * no request path can ever set it.
 */
export function createTrustedCoordinatorConfig(options = {}) {
  const env = options.env ?? {};
  const config = {
    stateDir: options.stateDir ?? null,
    streamFile: options.streamFile ?? null,
    allowFixtureDispatch: options.allowFixtureDispatch === true,
    // Second, narrower dual-opt-in: lets the AUTHORIZED canary/closure
    // harness drive a provider adapter through the public runtime before any
    // receipt exists. Requests can never set it.
    allowUnprovenProviderDispatch: options.allowUnprovenProviderDispatch === true,
    confinement: options.confinement ?? null, // 'disposable-workspace' | null
    disposableRoot: options.disposableRoot ?? null,
    // Provider-native preventive gates that a COMPLETED canary has proven,
    // keyed by adapter id (e.g. { 'opencode-server': 'canary-proven' }).
    // Only machine-local trusted configuration may grant this.
    providerNativeGate: Object.freeze({ ...(options.providerNativeGate ?? {}) }),
    managedBindingId: options.managedBindingId ?? null,
    ownedProcessCommand: options.ownedProcessCommand ?? null,
    openCodeBin: options.openCodeBin ?? env.OPENCODE_BIN ?? 'opencode',
    openCodeArgs: options.openCodeArgs ?? [],
    claudeBin: options.claudeBin ?? env.CLAUDE_BIN ?? 'claude',
    claudeArgs: options.claudeArgs ?? [],
    codexBin: options.codexBin ?? env.CODEX_BIN ?? 'codex',
    codexArgs: options.codexArgs ?? [],
    fakeModeEnv: options.fakeModeEnv ?? {},
  };
  return Object.freeze(config);
}

const TRUSTED_CONFIG_SCHEMA = 'webmcp.ai-trusted-coordinator-config/v1';
const TRUSTED_ADAPTERS_SCHEMA = 'webmcp.ai-trusted-adapters/v1';
const TRUSTED_CONFIG_ALLOWED_FIELDS = new Set([
  'schema',
  'stateDir',
  'confinement',
  'disposableRoot',
  'providerNativeGate',
  'managedBindingId',
  'ownedProcess',
  'publicAdapters',
]);
// Fields a config FILE may never set: the fixture/bypass opt-ins are dual
// opt-ins reserved for authorized harnesses, never file-granted privileges.
const TRUSTED_CONFIG_FORBIDDEN_FIELDS = new Set(['allowFixtureDispatch', 'allowUnprovenProviderDispatch']);
const ADAPTER_ENV_ALLOWLIST = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ']);

function requirePrivateFile(path, kind) {
  if (process.platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) {
      throw new AiCliError('POLICY_DENIED', `${kind} must be mode 0600 (got ${mode.toString(8)}): ${path}`);
    }
  }
}

function parseJsonFile(path, schema, kind) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `${kind} is not valid JSON: ${error?.code ?? 'ERROR'}`, { exitCode: 2 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `${kind} must be a JSON object`, { exitCode: 2 });
  }
  if (parsed.schema !== schema) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `${kind} schema must be ${schema}`, { exitCode: 2 });
  }
  return parsed;
}

function enforceTrustedConfigFields(parsed) {
  for (const key of Object.keys(parsed)) {
    if (TRUSTED_CONFIG_FORBIDDEN_FIELDS.has(key)) {
      throw new AiCliError('POLICY_DENIED', `trusted coordinator config files may never set ${key}`);
    }
    if (!TRUSTED_CONFIG_ALLOWED_FIELDS.has(key)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `trusted coordinator config has unknown field ${key}`, { exitCode: 2 });
    }
  }
}

/**
 * Load a machine-local trusted coordinator configuration file (mode 0600).
 * The ONLY way the packaged supervisor entry receives confinement policy,
 * disposable roots or launch commands. Caller-supplied Task/IPC payloads are
 * structurally incapable of providing any of these.
 */
export function loadTrustedCoordinatorConfigFile(path) {
  requirePrivateFile(path, 'trusted coordinator config');
  const parsed = parseJsonFile(path, TRUSTED_CONFIG_SCHEMA, 'trusted coordinator config');
  enforceTrustedConfigFields(parsed);
  if (parsed.confinement !== undefined && parsed.confinement !== null && parsed.confinement !== 'disposable-workspace') {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'confinement must be disposable-workspace or null', { exitCode: 2 });
  }
  if (parsed.ownedProcess !== undefined && parsed.ownedProcess !== null) {
    const op = parsed.ownedProcess;
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'ownedProcess must be an object', { exitCode: 2 });
    }
    for (const key of Object.keys(op)) {
      if (!['command', 'args', 'env'].includes(key)) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `ownedProcess has unknown field ${key}`, { exitCode: 2 });
      }
    }
    if (typeof op.command !== 'string' || !isAbsolute(op.command)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'ownedProcess.command must be an absolute path', { exitCode: 2 });
    }
    if (op.args !== undefined && (!Array.isArray(op.args) || op.args.some((arg) => typeof arg !== 'string'))) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'ownedProcess.args must be a string array', { exitCode: 2 });
    }
    if (op.env !== undefined && (typeof op.env !== 'object' || op.env === null || Array.isArray(op.env))) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'ownedProcess.env must be an object', { exitCode: 2 });
    }
  }
  if (parsed.managedBindingId !== undefined && parsed.managedBindingId !== null) {
    if (typeof parsed.managedBindingId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.managedBindingId)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'managedBindingId must be a bounded identifier string', { exitCode: 2 });
    }
  }
  const env = process.env;
  return createTrustedCoordinatorConfig({
    stateDir: parsed.stateDir ?? null,
    confinement: parsed.confinement ?? null,
    disposableRoot: parsed.disposableRoot ?? null,
    providerNativeGate: parsed.providerNativeGate ?? {},
    managedBindingId: parsed.managedBindingId ?? null,
    ownedProcessCommand: parsed.ownedProcess
      ? { command: parsed.ownedProcess.command, args: parsed.ownedProcess.args ?? [], env: { ...parsed.ownedProcess.env } }
      : null,
    publicAdapters: undefined,
    allowFixtureDispatch: false,
    allowUnprovenProviderDispatch: false,
    openCodeBin: env.OPENCODE_BIN ?? 'opencode',
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    codexBin: env.CODEX_BIN ?? 'codex',
  });
}

/**
 * Load a machine-local trusted adapter registry file (mode 0600): adapter id,
 * ABSOLUTE executable, argv array and a sanitized static environment
 * allowlist per entry. Nothing here is reachable from Task payloads.
 */
export function loadTrustedAdapterRegistry(path) {
  requirePrivateFile(path, 'trusted adapter registry');
  const parsed = parseJsonFile(path, TRUSTED_ADAPTERS_SCHEMA, 'trusted adapter registry');
  if (!Array.isArray(parsed.adapters) || parsed.adapters.length === 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'trusted adapter registry requires a non-empty adapters array', { exitCode: 2 });
  }
  const adapters = parsed.adapters.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'adapter entries must be objects', { exitCode: 2 });
    }
    for (const key of Object.keys(entry)) {
      if (!['id', 'executable', 'args', 'env'].includes(key)) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `adapter entry has unknown field ${key}`, { exitCode: 2 });
      }
    }
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'adapter id must be a non-empty string', { exitCode: 2 });
    }
    if (typeof entry.executable !== 'string' || !isAbsolute(entry.executable)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `adapter ${entry.id} executable must be absolute`, { exitCode: 2 });
    }
    if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== 'string'))) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `adapter ${entry.id} args must be a string array`, { exitCode: 2 });
    }
    const safeEnv = {};
    for (const [key, value] of Object.entries(entry.env ?? {})) {
      if (!ADAPTER_ENV_ALLOWLIST.has(key)) {
        throw new AiCliError('POLICY_DENIED', `adapter ${entry.id} env key ${key} is outside the static allowlist`);
      }
      if (typeof value !== 'string' || value.length > 4096) {
        throw new AiCliError('POLICY_DENIED', `adapter ${entry.id} env value for ${key} must be a bounded string`);
      }
      safeEnv[key] = value;
    }
    return { id: entry.id, command: entry.executable, args: [...(entry.args ?? [])], env: safeEnv };
  });
  return Object.freeze({ schema: TRUSTED_ADAPTERS_SCHEMA, adapters });
}

function requireTrusted(config, field, message) {
  if (!config[field]) throw new AiCliError('POLICY_DENIED', message, { exitCode: 2 });
}

/**
 * One public lifecycle wrapper per adapter kind. `launch` starts the real
 * adapter surface using only trusted configuration; `control` maps the
 * supervisor's interrupt/close verbs; `finalize` performs resource
 * reconciliation after the provider reaches terminal state.
 */
export function createPublicLifecycle(kind, adapter, config) {
  switch (kind) {
    case 'owned-process':
      return {
        kind,
        spawnStyle: 'process',
        async launch(context) {
          requireTrusted(config, 'ownedProcessCommand',
            'owned-process dispatch requires a coordinator-owned launch command');
          const { command, args = [], env = {} } = config.ownedProcessCommand;
          // The worker learns its callback route through EXACTLY one trusted
          // environment variable naming the capability file; the token itself
          // never enters argv, env values, prompts or logs.
          const childEnv = { ...env };
          if (context.dispatch?.capabilityFile) {
            childEnv.WEBMCP_AI_WORKER_CAPABILITY_FILE = String(context.dispatch.capabilityFile);
          }
          return adapter.spawn({
            task: context.task,
            dispatch: context.dispatch,
            emit: context.emit,
            command,
            args,
            env: childEnv,
            preamble: context.dispatch?.workerPacket ? renderWorkerPreamble(context.dispatch.workerPacket) : null,
            refsDir: context.dispatch?.refsDir ?? null,
            refNamespace: context.dispatch?.refNamespace ?? null,
          });
        },
        // Interrupt control routes through the adapter's own graceful ladder
        // (SIGINT -> SIGTERM -> SIGKILL); the runtime then demands exit proof.
        async control({ binding, reason }) {
          const result = await adapter.interrupt({ binding, reason });
          if (result?.ok === false) {
            return { ok: false, error: result.error ?? { code: 'WORKER_STOP_UNPROVEN', message: 'adapter interrupt refused' } };
          }
          return {
            ok: true,
            mode: 'graceful-ladder',
            disposition: 'adapter-interrupt',
            signalsAttempted: result?.__signals ?? result?.result?.signalsAttempted ?? [],
          };
        },
        async finalize(context) {
          return adapter.close(context.bindingOnly ? {} : { binding: context.binding });
        },
      };
    case 'claude-stream':
      return {
        kind,
        spawnStyle: 'process',
        async launch(context) {
          return adapter.spawn({
            task: context.task,
            dispatch: context.dispatch,
            emit: context.emit,
            resumeSessionId: context.resumeSessionId ?? null,
            taskPolicy: {},
            followUpTexts: [],
          });
        },
        // Claude interrupt control is the adapter's own SIGINT-first ladder.
        async control({ binding, reason }) {
          const result = await adapter.interrupt({ binding, reason });
          if (result?.ok === false) {
            return { ok: false, error: result.error ?? { code: 'WORKER_STOP_UNPROVEN', message: 'adapter interrupt refused' } };
          }
          return {
            ok: true,
            mode: 'graceful-ladder',
            disposition: 'adapter-interrupt',
            signalsAttempted: result?.__signals ?? result?.result?.signalsAttempted ?? [],
          };
        },
        async finalize(context) {
          return adapter.close({ binding: context.binding });
        },
      };
    case 'codex-exec':
      return {
        kind,
        spawnStyle: 'process',
        async launch(context) {
          return adapter.spawn({
            task: context.task,
            dispatch: context.dispatch,
            emit: context.emit,
            resumeThread: context.resumeThread ?? null,
          });
        },
        // Codex exposes no graceful interrupt: control is the announced hard
        // kill of exactly the owned child process group.
        async control({ binding }) {
          const child = binding?.__child;
          const signalsAttempted = [];
          if (!child || child.exitCode !== null || child.signalCode !== null) {
            return { ok: true, mode: 'hard-kill', alreadyExited: true, signalsAttempted };
          }
          if (process.platform !== 'win32') {
            try {
              process.kill(-child.pid, 'SIGKILL');
              signalsAttempted.push('GROUP_SIGKILL');
            } catch {
              try {
                child.kill('SIGKILL');
                signalsAttempted.push('SIGKILL');
              } catch { /* already gone */ }
            }
          } else {
            try {
              child.kill('SIGKILL');
              signalsAttempted.push('SIGKILL');
            } catch { /* already gone */ }
          }
          return { ok: true, mode: 'hard-kill', disposition: 'group-stopped', signalsAttempted };
        },
        async finalize(context) {
          return adapter.close({ binding: context.binding });
        },
      };
    case 'opencode-server':
      return {
        kind,
        spawnStyle: 'server',
        async launch(context) {
          const { runtime, binding } = await adapter.startRuntimeServer({
            workspace: context.task.workspace,
            bindingId: context.dispatch.bindingId,
            fenceEpoch: context.dispatch.fenceEpoch,
            // Universal crash-window handshake: the supervisor's durable
            // launch lease is bound the instant the server process exists,
            // BEFORE readiness/health/session/prompt work begins.
            onSpawned: context.dispatch?.onSpawned,
          });
          const session = await adapter.createSession(runtime);
          const boundBinding = { ...binding, sessionId: session.sessionId };
          const subscription = adapter.subscribe(runtime, {
            onEvent: (event) => {
              // Provider idle status IS the terminal evidence for server-style
              // sessions; everything else maps through its declared type.
              const deliveryType = event.kind === 'session_status_idle'
                ? 'worker_done'
                : (event.deliveryType ?? 'progress');
              context.emit(deliveryType, {
                taskId: context.task.taskId,
                dispatchId: context.dispatch.dispatchId,
                summary: event.summary ?? event.kind,
                ...event.payload,
                source: 'opencode-events',
              });
            },
          });
          // Readiness handshake: the SSE subscription MUST be established
          // before the first prompt so no early provider event is lost and
          // the prompt is never issued against an unproven stream.
          const sseReady = await Promise.race([
            subscription.connected,
            new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({ __sseTimeout: true }), 5_000).unref?.()),
          ]);
          if (sseReady?.__sseTimeout) {
            try { subscription.close(); } catch { /* already closed */ }
            throw new AiCliError('PROVIDER_PROTOCOL_ERROR', 'opencode SSE subscription did not become ready before prompting');
          }
          await adapter.promptAsync(runtime, session.sessionId, context.task.objective);
          return {
            ok: true,
            binding: {
              ...boundBinding,
              guaranteeTier: 'owned-process',
              __runtime: runtime,
              __subscription: subscription,
            },
            done: context.doneForServer,
          };
        },
        // Interrupt control aborts the SESSION through the provider surface.
        // The owned server process is NEVER killed by default; it shuts down
        // during finalize after the provider reaches terminal state.
        async control({ binding }) {
          try {
            await adapter.abortSession(binding);
            return { ok: true, mode: 'session-abort', signalsAttempted: [] };
          } catch (error) {
            return {
              ok: false,
              error: {
                code: error.code ?? 'WORKER_STOP_UNPROVEN',
                message: String(error.message ?? 'session abort failed').slice(0, 300),
              },
            };
          }
        },
        async finalize(context) {
          const runtime = context.binding?.__runtime;
          if (!runtime) return { action: 'cleanup_recorded', disposition: 'already-exited' };
          return adapter.stopServer(runtime, { release: true, settled: true });
        },
      };
    default:
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `unknown public adapter kind ${String(kind)}`, { exitCode: 2 });
  }
}

/** Build one validated public adapter from an inner adapter + lifecycle. */
export function asPublicAdapter(inner, lifecycle) {
  const wrapped = { ...inner, lifecycle };
  return validateAdapter(wrapped);
}

/**
 * Convenience factory for supervisors: assemble the requested kinds from
 * trusted configuration. Fixture overrides are only honored when
 * config.allowFixtureDispatch is true (dual opt-in).
 */
export function createPublicAdapters(config, overrides = {}) {
  const adapters = [];
  for (const kind of PUBLIC_ADAPTER_KINDS) {
    const override = overrides[kind];
    if (override) {
      if (!config.allowFixtureDispatch) {
        throw new AiCliError(
          'POLICY_DENIED',
          `fixture override for ${kind} requires dual-opt-in allowFixtureDispatch`,
          { exitCode: 2 },
        );
      }
      adapters.push(asPublicAdapter(override.inner, override.lifecycle));
      continue;
    }
    let inner = null;
    switch (kind) {
      case 'owned-process':
        inner = createOwnedProcessAdapter({ stateDir: config.stateDir });
        break;
      case 'opencode-server':
        inner = createOpenCodeServerAdapter({
          stateDir: config.stateDir,
          openCodeBin: config.openCodeBin,
          openCodeArgs: config.openCodeArgs,
          streamFile: config.streamFile,
        });
        break;
      case 'claude-stream':
        inner = createClaudeStreamAdapter({
          stateDir: config.stateDir,
          claudeBin: config.claudeBin,
          claudeArgs: config.claudeArgs,
          fakeModeEnv: config.fakeModeEnv,
        });
        break;
      case 'codex-exec':
        inner = createCodexExecAdapter({
          stateDir: config.stateDir,
          codexBin: config.codexBin,
          codexArgs: config.codexArgs,
          fakeModeEnv: config.fakeModeEnv,
        });
        break;
      default:
        break;
    }
    if (!inner) continue;
    adapters.push(asPublicAdapter(inner, createPublicLifecycle(kind, inner, config)));
  }
  return adapters;
}

export function newDispatchId() {
  return `disp_${randomUUID()}`;
}
