import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { AiCliError } from '../../errors.mjs';
import { validateAdapter } from './index.mjs';
import { awaitProcessGroupEmpty, createPlatformIdentityDeps, isPidLive, proveProcessGroupEmpty } from '../process-identity.mjs';
import { sanitizeValue } from '../redaction.mjs';

/**
 * Map one Claude `stream-json --verbose` event onto the closed Delivery
 * registry. Partial token streams, thinking blocks and unbounded tool output
 * never persist verbatim; the explicit session id always does.
 */
export function normalizeClaudeEvent(event, binding = null) {
  if (typeof event !== 'object' || event === null) return null;
  const sessionId = typeof event.session_id === 'string' ? event.session_id : null;
  if (binding?.sessionId && sessionId && sessionId !== binding.sessionId) return null;

  const sanitize = (value) => sanitizeValue(value, {});

  switch (event.type) {
    case 'system':
      if (event.subtype !== 'init') return null;
      return sanitize({
        kind: 'session_init',
        deliveryType: 'worker_started',
        summary: `claude session initialized (${event.model ?? 'unknown model'})`,
        payload: {
          sessionId,
          model: event.model ?? null,
          cwd: event.cwd ?? null,
        },
      });
    case 'assistant': {
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      const mapped = [];
      for (const block of content) {
        if (block.type === 'thinking') continue; // dropped entirely
        if (block.type === 'text') {
          mapped.push(sanitize({
            kind: 'assistant_text',
            deliveryType: 'progress',
            summary: String(block.text ?? '').slice(0, 2000),
            payload: { sessionId },
          }));
        } else if (block.type === 'tool_use') {
          mapped.push(sanitize({
            kind: 'tool_use',
            deliveryType: 'progress',
            summary: `tool ${block.name ?? 'unknown'} requested`,
            payload: {
              tool: block.name ?? null,
              toolUseId: block.id ?? null,
              inputKeys: Object.keys(block.input ?? {}),
            },
          }));
        }
      }
      return mapped;
    }
    case 'user': {
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      const mapped = [];
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        mapped.push(sanitize({
          kind: 'tool_result',
          deliveryType: 'progress',
          summary: `tool result for ${block.tool_use_id ?? 'unknown'}`,
          payload: {
            toolUseId: block.tool_use_id ?? null,
            outputOmitted: Boolean(block.content),
          },
        }));
      }
      return mapped;
    }
    case 'result': {
      const isError = event.subtype !== 'success';
      return sanitize({
        kind: isError ? 'result_error' : 'result_success',
        deliveryType: isError ? 'escalation' : 'worker_done',
        summary: String(event.result ?? event.error ?? '').slice(0, 2000),
        payload: {
          sessionId,
          tokensTotal: event.usage?.total_tokens ?? null,
          durationMs: event.duration_ms ?? null,
          terminalEvidence: !isError,
        },
      });
    }
    default:
      // stream deltas and unknown types are telemetry noise here.
      return null;
  }
}

/**
 * Build the exact documented invocation. New sessions require a runtime
 * generated UUID via --session-id; resume reuses that exact id through
 * --resume. --continue and pickers are never emitted.
 */
export function buildClaudeInvocation({
  sessionId = null,
  hookMode = false,
  settingsPath = null,
  mcpConfigPath = null,
} = {}) {
  const effectiveSessionId = sessionId ?? randomUUID();
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-chrome',
  ];
  if (!hookMode) args.push('--safe-mode');
  if (hookMode) {
    args.push(
      '--bare',
      '--settings', settingsPath,
      '--strict-mcp-config',
      '--mcp-config', mcpConfigPath,
      '--include-hook-events',
    );
  }
  // A supplied session id means explicit resume; a null one starts a new
  // runtime-generated session. --continue is never emitted.
  if (sessionId) {
    args.push('--resume', sessionId);
  } else {
    args.push('--session-id', effectiveSessionId);
  }
  return { args, stdin: true, sessionId: effectiveSessionId };
}

function parseNdjson(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Non-JSON provider chatter is ignored by contract.
    }
  }
  return events;
}

/**
 * Claude programmatic adapter: owned `-p` process with explicit session ids.
 * Hook mode is a separate explicit upgrade requiring Task policy opt-in and a
 * live isolation canary before preToolGate may ever be advertised.
 */
export function createClaudeStreamAdapter(options = {}) {
  const stateDir = options.stateDir;
  if (!stateDir) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'claude adapter requires a machine-local state dir', { exitCode: 2 });
  }

  const adapter = {
    id: 'claude-stream',
    maturity: 'fixture-only',
    capabilities: {
      liveEvents: true,
      explicitResume: true,
      externalAttach: false,
      questionChannel: false,
      permissionControl: false,
      sameTurnSteer: false,
      gracefulInterrupt: true,
      preToolGate: false,
      processOwnership: true,
      fileEvents: false,
      testEvents: true,
    },
    async probe({ env = {} } = {}) {
      return {
        adapterId: this.id,
        available: env.CLAUDE_BIN ? true : Boolean(options.claudeBin),
        maturity: this.maturity,
        capabilities: this.capabilities,
        note: 'preToolGate requires a separately authorized live isolation canary',
      };
    },
    sanitize: (event) => normalizeClaudeEvent(event, null),

    attach() {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'claude adapter owns its processes; no external attach');
    },
    subscribe() {
      return { ok: true, deliveries: [], cursor: null };
    },
    readSession() {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'session reads flow through the owned process stream');
    },
    sendReply() {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'use follow-up turns; busy stdin is queued, not steering');
    },
    sendGuidance() {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'guidance uses follow-up turns serialized by terminal result');
    },
    resolvePermission() {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'permission control requires a proven hook canary');
    },

    /**
     * Spawn one owned claude process. Returns sendFollowUp (queued follow-up
     * turn classification) plus interrupt semantics over SIGINT/SIGTERM.
     */
    async spawn({
      task,
      dispatch,
      emit,
      resumeSessionId = null,
      taskPolicy = {},
      followUpTexts = [],
    }) {
      // New sessions MUST use --session-id with a runtime-generated UUID;
      // --resume is only valid for an adapter-recorded prior session.
      // Passing a fresh UUID as "resume" makes real CLIs fail with
      // "No conversation found".
      const invocation = buildClaudeInvocation({
        sessionId: resumeSessionId,
        hookMode: taskPolicy.claudeHooks === true,
        settingsPath: taskPolicy.hookSettingsPath ?? null,
        mcpConfigPath: taskPolicy.hookMcpConfigPath ?? null,
      });
      const sessionId = invocation.sessionId;

      emit('worker_started', { dispatchId: dispatch.dispatchId });
      const child = spawn(options.claudeBin ?? process.env.CLAUDE_BIN ?? process.execPath,
        [...(options.claudeArgs ?? []), ...invocation.args], {
          cwd: task.workspace,
          env: {
            ...process.env,
            ...(options.fakeModeEnv ?? {}),
          },
          detached: process.platform !== 'win32',
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

      // Launch-intent HANDSHAKE: the durable lease is upgraded the instant
      // the child exists and its identity has been probed — BEFORE the
      // objective write or any other fallible work. Identity is recorded
      // ONLY when actually proven; an unavailable probe stays honestly
      // unproven (identityProven:false) instead of fabricating a placeholder.
      const identityDeps = createPlatformIdentityDeps();
      let probedStartIdentity = null;
      try {
        probedStartIdentity = await identityDeps.getStartIdentity(child.pid);
      } catch {
        probedStartIdentity = null;
      }
      await dispatch?.onSpawned?.({
        pid: child.pid,
        processGroupId: child.pid,
        ...(probedStartIdentity ? { startIdentity: probedStartIdentity } : {}),
        identityProven: probedStartIdentity !== null,
      });

      let stdoutBuffer = '';
      const events = [];
      const signalsAttempted = [];

      // A fast-exiting worker can close its stdin pipe before the objective
      // write lands; the close/error events report that truthfully, so an
      // EPIPE here must never crash the owner loop.
      child.stdin.on('error', () => { /* terminal evidence flows via close */ });

      // The Task objective is the initial turn's prompt: write it as the
      // first stdin line and close the pipe so real `-p` runs settle instead
      // of waiting for EOF forever. Queued follow-ups (sendFollowUp) remain
      // available for adapters that keep the turn open.
      if (typeof task?.objective === 'string' && task.objective.length > 0) {
        child.stdin.end(`${task.objective}\n`);
      }

      const donePromise = new Promise((resolveDone) => {
        child.stdout.on('data', (chunk) => {
          stdoutBuffer += chunk.toString('utf8');
          let newlineIndex = stdoutBuffer.indexOf('\n');
          while (newlineIndex !== -1) {
            const line = stdoutBuffer.slice(0, newlineIndex);
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            try {
              const parsedEvent = JSON.parse(line);
              const mappedList = normalizeClaudeEvent(parsedEvent, { sessionId });
              for (const mapped of [mappedList].flat()) {
                if (!mapped) continue;
                events.push(mapped);
                if (mapped.deliveryType) {
                  emit(mapped.deliveryType, {
                    taskId: task.taskId,
                    dispatchId: dispatch.dispatchId,
                    ...mapped.payload,
                    summary: mapped.summary,
                    source: 'claude-stream-json',
                  });
                }
              }
            } catch {
              // Ignore non-JSON lines defensively.
            }
            newlineIndex = stdoutBuffer.indexOf('\n');
          }
        });

        const finishWith = (payload) => {
          resolveDone(payload);
        };

        child.on('close', (code, signal) => {
          const interrupted = ['SIGINT', 'SIGTERM', 'SIGKILL'].includes(signal);
          emit('cleanup_recorded', {
            dispatchId: dispatch.dispatchId,
            disposition: interrupted ? 'interrupted' : 'exited',
            signalsAttempted: [...signalsAttempted, ...(signal ? [signal] : [])],
            unfinishedTurn: interrupted && signal === 'SIGTERM',
            resumableSessionId: sessionId,
          });
          finishWith({
            terminalType: interrupted ? 'worker_cancelled' : code === 0 ? 'worker_done' : 'worker_failed',
            exitCode: code,
            signal: signal ?? null,
            unfinishedTurn: interrupted,
            sessionId,
          });
        });
        child.on('error', (error) => {
          finishWith({ terminalType: 'worker_failed', error: error.code ?? 'SPAWN_ERROR', sessionId });
        });
      });

      // Busy stdin writes are queued follow-up turns — never same-turn steer.
      async function sendFollowUp(text) {
        await new Promise((resolveTick) => setTimeout(resolveTick, 10));
        try {
          child.stdin.write(`${text}\n`);
          emit('guidance', {
            taskId: task.taskId,
            dispatchId: dispatch.dispatchId,
            sameTurn: false,
            classification: 'queued-followup',
            summaryLength: String(text).length,
          });
          return { ok: true, classification: 'queued-followup', sameTurn: false };
        } catch (error) {
          return { ok: false, error: { code: 'PROVIDER_PROTOCOL_ERROR', message: error.message } };
        }
      }
      void followUpTexts;

      const binding = {
        bindingId: dispatch.bindingId,
        adapterId: 'claude-stream',
        guaranteeTier: 'owned-process',
        sessionId,
        processIdentity: {
          pid: child.pid,
          processGroupId: child.pid,
          ...(probedStartIdentity ? { startIdentity: probedStartIdentity } : {}),
          identityProven: probedStartIdentity !== null,
        },
        __child: child,
        __signalsAttempted: signalsAttempted,
        done: donePromise,
      };

      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      return {
        ok: true,
        binding,
        done: donePromise,
        sendFollowUp,
        sessionId,
        events,
      };
    },

    async interrupt({ binding, reason = '' }) {
      if (!binding?.__child) {
        return { ok: false, error: { code: 'WORKER_IDENTITY_UNPROVEN', message: 'no live owned claude process' } };
      }
      const child = binding.__child;
      // SIGINT requests turn interruption; SIGTERM remains a stop fallback
      // whose unfinished-turn semantics are reported in cleanup.
      child.kill('SIGINT');
      binding.__signalsAttempted.push('SIGINT');
      await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        new Promise((resolveTick) => setTimeout(resolveTick, 800).unref?.()),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        binding.__signalsAttempted.push('SIGTERM');
      }
      return { ok: true, interrupted: true, reason };
    },

    /**
     * Proof-driven close: the ladder is SIGTERM -> SIGKILL with a bounded
     * exit wait after every step. When a real process group is recorded,
     * the receipt claims `group-stopped` ONLY once the WHOLE group is
     * proven empty via `proveProcessGroupEmpty` (`kill(-pgid, 0)` -> ESRCH)
     * — the leader's own `exit` event is used only to pace each rung, never
     * to authorize the claim, because a leader that complies with SIGTERM
     * proves nothing about grandchildren that ignored the same signal and
     * are still parented inside the group. Without a usable group id (no
     * group recorded, or win32 — see process-identity.mjs), the ladder
     * falls back to pid-only proof of the single owned child. A surviving
     * group/child yields `group-signalled` (pending retry), never `stopped`.
     */
    async close({ binding }) {
      const child = binding?.__child;
      const gone = () => !child || child.exitCode !== null || child.signalCode !== null;
      // Group sweep authority comes from the RECORDED process identity (the
      // detached spawn made this child its own group leader) — ChildProcess
      // objects expose no `.detached` flag at runtime, so that must never be
      // the gate.
      const groupId = binding?.processIdentity?.processGroupId;
      const hasGroup = process.platform !== 'win32' && Number.isInteger(groupId) && groupId > 1;
      if (gone()) {
        if (!hasGroup) return { ok: true, disposition: 'already-exited', signalsAttempted: [] };
        // The leader was ALREADY gone before close() was ever called: no
        // signal ladder involved at all (a worker that simply finished and
        // exited while a background child it spawned lingers). An UNBOUNDED
        // amount of real time may have passed since the leader died, so
        // before trusting `-groupId` as "our own orphaned descendants",
        // rule out the OS having recycled that exact pid for an unrelated
        // process — see owned-process.mjs's close() for the full reasoning.
        // If anything at all currently occupies that literal pid, fail
        // closed rather than risk signalling a stranger's process group.
        if (isPidLive(groupId)) {
          return { ok: true, disposition: 'group-signalled', signalsAttempted: [] };
        }
        const initialProof = proveProcessGroupEmpty(groupId);
        if (initialProof !== 'alive') {
          return { ok: true, disposition: 'already-exited', signalsAttempted: [] };
        }
        // Group still has live members despite the leader's prior exit:
        // fall through into the same ladder used below for a leader that
        // was still alive at call time.
      }
      const graceMs = options.closeGraceMsForTest ?? 800;
      const forceGraceMs = options.forceCloseGraceMsForTest ?? 2000;
      const signalsAttempted = [];
      const signalOnce = (signal) => {
        if (hasGroup) {
          try {
            process.kill(-groupId, signal);
            signalsAttempted.push(`GROUP_${signal}`);
            return;
          } catch { /* fall back to pid-only signalling */ }
        }
        try {
          child.kill(signal);
          signalsAttempted.push(signal);
        } catch { /* already gone */ }
      };
      const awaitExit = (ms) => new Promise((resolveExit) => {
        if (gone()) { resolveExit(true); return; }
        const timer = setTimeout(() => {
          child.off('exit', onExit);
          resolveExit(gone());
        }, ms);
        const onExit = () => {
          clearTimeout(timer);
          resolveExit(true);
        };
        child.once('exit', onExit);
      });
      const proven = () => (hasGroup ? proveProcessGroupEmpty(groupId) === 'empty' : gone());
      signalOnce('SIGTERM');
      await awaitExit(graceMs);
      let done = proven();
      if (!done) {
        signalOnce('SIGKILL');
        await awaitExit(forceGraceMs);
        done = proven();
      }
      if (!done && hasGroup) {
        // A group that was just SIGKILLed can still read 'alive' for a few
        // milliseconds purely because the kernel has not reaped it yet, not
        // because anything survived. A short bounded re-probe avoids a
        // wasted finalize-retry round-trip WITHOUT trading away fail-closed:
        // if the group is still alive when the budget runs out, that exact
        // (unproven) reading is what gets returned below.
        done = (await awaitProcessGroupEmpty(groupId)) === 'empty';
      }
      if (!done) {
        // Signals were sent but survival remains possible. NEVER claim stopped.
        return { ok: true, disposition: 'group-signalled', signalsAttempted: [...signalsAttempted] };
      }
      return { ok: true, disposition: 'group-stopped', exitProven: true, signalsAttempted: [...signalsAttempted] };
    },
  };

  validateAdapter(adapter);
  return adapter;
}

export function hookControlDirectory(stateRoot, coordinationId, dispatchId) {
  const dir = join(stateRoot, 'claude-hooks', coordinationId, dispatchId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
