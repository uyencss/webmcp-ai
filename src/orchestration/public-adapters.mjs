import { randomUUID } from 'node:crypto';

import { AiCliError } from '../errors.mjs';
import { validateAdapter } from './adapters/index.mjs';
import { createOwnedProcessAdapter } from './adapters/owned-process.mjs';
import { createOpenCodeServerAdapter } from './adapters/opencode-server.mjs';
import { createClaudeStreamAdapter } from './adapters/claude-stream.mjs';
import { createCodexExecAdapter } from './adapters/codex-exec.mjs';

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
          return adapter.spawn({
            task: context.task,
            dispatch: context.dispatch,
            emit: context.emit,
            command,
            args,
            env,
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
