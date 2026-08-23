import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { AiCliError } from '../../errors.mjs';
import { validateAdapter } from './index.mjs';
import { sanitizeValue } from '../redaction.mjs';

/**
 * Map one Codex `exec --json` event onto bounded evidence. Reasoning items
 * are dropped entirely; thread ids stay inside binding metadata and never
 * enter Delivery payloads.
 */
export function normalizeCodexEvent(event, binding = null) {
  if (typeof event !== 'object' || event === null) return null;

  switch (event.type) {
    case 'thread.started':
      return sanitize({
        kind: 'thread_started',
        deliveryType: 'progress',
        summary: 'codex thread started',
        payload: {},
      });
    case 'turn.started':
      return sanitize({
        kind: 'turn_started',
        deliveryType: 'progress',
        summary: 'codex turn started',
        payload: {},
      });
    case 'item.started': {
      const item = event.item ?? {};
      if (item.type === 'reasoning') return null;
      if (item.type === 'command_execution') {
        return sanitize({
          kind: 'command_execution',
          deliveryType: 'progress',
          summary: `command started: ${String(item.command ?? '').slice(0, 200)}`,
          payload: { itemId: item.id ?? null },
        });
      }
      if (item.type === 'file_change') {
        return sanitize({
          kind: 'file_change',
          deliveryType: 'progress',
          summary: 'file change in progress',
          payload: { changes: item.changes ?? [] },
        });
      }
      return null;
    }
    case 'item.completed': {
      const item = event.item ?? {};
      if (item.type === 'reasoning') return null;
      if (item.type === 'command_execution') {
        return sanitize({
          kind: 'command_execution',
          deliveryType: 'progress',
          summary: `command exit ${item.exit_code}`,
          payload: { itemId: item.id ?? null, exitCode: item.exit_code ?? null, outputOmitted: Boolean(item.aggregated_output) },
        });
      }
      if (item.type === 'file_change') {
        return sanitize({
          kind: 'file_change',
          deliveryType: 'progress',
          summary: `files changed: ${(item.changes ?? []).length}`,
          payload: { changes: item.changes ?? [] },
        });
      }
      return null;
    }
    case 'error':
      return sanitize({
        kind: 'provider_error',
        deliveryType: 'escalation',
        summary: `codex error: ${String(event.message ?? '').slice(0, 500)}`,
        payload: {},
      });
    case 'turn.completed':
      return sanitize({
        kind: 'turn_completed',
        deliveryType: 'worker_done',
        summary: 'codex turn completed',
        payload: { tokensTotal: event.usage?.total_tokens ?? null, terminalEvidence: true },
      });
    default:
      return null;
  }

  function sanitize(value) {
    // Binding metadata (thread ids) never enters mapped events.
    void binding;
    return sanitizeValue(value, {});
  }
}

/**
 * Codex `exec --json` compatibility adapter. Read-only sandbox only; explicit
 * resume of adapter-created threads only; App Server stays an
 * experimental-unavailable note.
 */
export function createCodexExecAdapter(options = {}) {
  const stateDir = options.stateDir;
  if (!stateDir) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'codex adapter requires a machine-local state dir', { exitCode: 2 });
  }
  const receipts = new Map(); // dispatchId -> { threadId, workspaceDigest, taskId }

  function workspaceDigest(workspace) {
    return createHash('sha256').update(String(workspace)).digest('hex');
  }

  function buildArgs({ resumeThread = null, modelPolicy = null, effortPolicy = null }) {
    if (resumeThread) {
      const args = ['exec', 'resume', '--json', '--ignore-user-config', '--ignore-rules', resumeThread, '-'];
      return args;
    }
    const args = [
      'exec', '--json',
      '--sandbox', 'read-only',
      '--ignore-user-config',
      '--ignore-rules',
      '--color', 'never',
    ];
    if (modelPolicy) args.push('--model', String(modelPolicy));
    if (effortPolicy) args.push('-c', `model_reasoning_effort="${effortPolicy}"`);
    args.push('-');
    return args;
  }

  async function probeBounded(args) {
    return new Promise((resolveProbe) => {
      const child = spawn(options.codexBin ?? process.env.CODEX_BIN ?? process.execPath,
        [...(options.codexArgs ?? []), ...args], {
          env: { ...(options.env ?? process.env), ...(options.fakeModeEnv ?? {}) },
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.on('close', (code) => resolveProbe({ code, stdout }));
      child.on('error', () => resolveProbe({ code: -1, stdout: '' }));
      setTimeout(() => {
        child.kill('SIGKILL');
        resolveProbe({ code: -1, stdout });
      }, 10_000).unref?.();
    });
  }

  const adapter = {
    id: 'codex-exec',
    maturity: 'fixture-only',
    capabilities: {
      liveEvents: true,
      explicitResume: true,
      externalAttach: false,
      questionChannel: false,
      permissionControl: false,
      sameTurnSteer: false,
      gracefulInterrupt: false,
      preToolGate: false,
      processOwnership: true,
      fileEvents: true,
      testEvents: true,
    },

    __receiptFor(dispatchId) {
      return receipts.get(dispatchId) ?? null;
    },

    async probe() {
      const modes = options.probeModes ?? [];
      if (modes.length > 0) {
        for (const mode of modes) {
          const result = await probeBounded(mode === 'resume-help'
            ? ['exec', 'resume', '--help']
            : ['exec', '--help']);
          if (result.code !== 0) {
            return {
              adapterId: this.id,
              available: false,
              maturity: this.maturity,
              capabilities: this.capabilities,
              experimentalSurfaces: [{ name: 'app-server', status: 'experimental-unavailable' }],
              reason: 'exec help probes failed',
            };
          }
        }
      }
      return {
        adapterId: this.id,
        available: true,
        maturity: this.maturity,
        capabilities: this.capabilities,
        experimentalSurfaces: [{ name: 'app-server', status: 'experimental-unavailable' }],
      };
    },

    sanitize(event) {
      return normalizeCodexEvent(event, null);
    },
    attach() {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'codex exec owns its processes; no external thread attach');
    },
    subscribe() {
      return { ok: true, deliveries: [], cursor: null };
    },
    readSession() {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'codex reads flow through the owned exec stream');
    },
    sendReply() {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'no semantic reply channel on exec --json');
    },
    sendGuidance() {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'guidance requires a new turn or dispatch');
    },
    resolvePermission() {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'no permission channel on exec --json');
    },
    interrupt() {
      // Hard owned-process cancellation only; graceful turn interruption is
      // not advertised by this adapter.
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'interrupt is a hard process kill handled by the runtime');
    },
    close({ binding }) {
      try {
        if (binding?.__child && binding.__child.exitCode === null) {
          binding.__child.kill('SIGKILL');
        }
        return { ok: true, disposition: 'killed' };
      } catch {
        return { ok: true, disposition: 'already-exited' };
      }
    },

    /**
     * Spawn one read-only codex exec. Mutable codex execution is out of the
     * alpha because there is no preventive write gate in this baseline.
     */
    async spawn({
      task,
      dispatch,
      emit,
      resumeThread = null,
    }) {
      const finishInvalid = async (error) => ({
        ok: false,
        done: Promise.resolve({ terminalType: 'worker_failed', error: error.code }),
        error: error.toJSON(),
      });

      // Git workspace requirement — never skip the repo check.
      const revParse = spawnSyncQuiet(['-C', task.workspace, 'rev-parse', '--show-toplevel']);
      if (!revParse.ok) {
        return finishInvalid(new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          'codex exec requires a Git workspace; refusing to skip the repo check',
          { exitCode: 2 },
        ));
      }

      // Resume eligibility: only adapter-recorded threads bound to the same
      // task/workspace/read-only dispatch may be resumed.
      let effectiveResumeThread = resumeThread ?? null;
      if (effectiveResumeThread) {
        const receipt = receipts.get(dispatch.dispatchId);
        if (
          !receipt
          || receipt.threadId !== effectiveResumeThread
          || receipt.workspaceDigest !== workspaceDigest(task.workspace)
          || receipt.taskId !== task.taskId
        ) {
          return finishInvalid(new AiCliError(
            'WORKER_IDENTITY_UNPROVEN',
            'resume refused: no matching adapter-owned thread receipt for this dispatch',
          ));
        }
      }

      const args = buildArgs({
        resumeThread: effectiveResumeThread,
        modelPolicy: task.modelPolicy,
        effortPolicy: task.effortPolicy,
      });

      emit('worker_started', { dispatchId: dispatch.dispatchId });
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const child = spawn(options.codexBin ?? process.env.CODEX_BIN ?? process.execPath,
        [...(options.codexArgs ?? []), ...args], {
          cwd: task.workspace,
          env: { ...(options.env ?? process.env), ...(options.fakeModeEnv ?? {}) },
          detached: process.platform !== 'win32',
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

      child.stdin.write(`${task.objective}\n`);
      child.stdin.end();

      let stdoutBuffer = '';
      let promptEcho = '';
      const donePromise = new Promise((resolveDone) => {
        child.stdout.on('data', (chunk) => {
          stdoutBuffer += chunk.toString('utf8');
          let newlineIndex = stdoutBuffer.indexOf('\n');
          while (newlineIndex !== -1) {
            const line = stdoutBuffer.slice(0, newlineIndex);
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            try {
              const parsedEvent = JSON.parse(line);
              if (parsedEvent.type === 'thread.started') {
                receipts.set(dispatch.dispatchId, {
                  threadId: parsedEvent.thread_id,
                  workspaceDigest: workspaceDigest(task.workspace),
                  taskId: task.taskId,
                });
                emit('worker_binding_recorded', { dispatchId: dispatch.dispatchId, threadRecorded: true });
              } else {
                const mappedList = [normalizeCodexEvent(parsedEvent)].flat();
                for (const mapped of mappedList.flat()) {
                  if (!mapped) continue;
                  emit(mapped.deliveryType, {
                    taskId: task.taskId,
                    dispatchId: dispatch.dispatchId,
                    summary: mapped.summary,
                    ...mapped.payload,
                    source: 'codex-exec-json',
                  });
                }
              }
            } catch {
              promptEcho += line;
            }
            newlineIndex = stdoutBuffer.indexOf('\n');
          }
        });

        child.on('close', (code, signal) => {
          if (promptEcho.trim()) {
            emit('progress', { summary: promptEcho.slice(0, 2000).replace(/PROMPT_ECHO:/, ''), source: 'stdout' });
          }
          const interrupted = ['SIGINT', 'SIGTERM', 'SIGKILL'].includes(signal);
          emit('cleanup_recorded', {
            dispatchId: dispatch.dispatchId,
            disposition: interrupted ? 'killed' : 'exited',
            signalsAttempted: signal ? [signal] : [],
          });
          resolveDone({
            terminalType: interrupted ? 'worker_cancelled' : code === 0 ? 'worker_done' : 'worker_failed',
            exitCode: code,
            signal: signal ?? null,
            sessionId: receipts.get(dispatch.dispatchId)?.threadId ?? null,
          });
        });
        child.on('error', (error) => {
          resolveDone({ terminalType: 'worker_failed', error: error.code ?? 'SPAWN_ERROR' });
        });
      });

      return {
        ok: true,
        binding: {
          bindingId: dispatch.bindingId,
          adapterId: 'codex-exec',
          guaranteeTier: 'owned-process',
          sessionId: receipts.get(dispatch.dispatchId)?.threadId ?? null,
          __child: child,
          done: donePromise,
        },
        done: donePromise,
        sessionId: receipts.get(dispatch.dispatchId)?.threadId ?? null,
      };
    },
  };

  function spawnSyncQuiet(gitArgs) {
    const result = spawnSync('git', gitArgs, { shell: false, timeout: 15_000 });
    return { ok: result.status === 0 };
  }

  validateAdapter(adapter);
  return adapter;
}
