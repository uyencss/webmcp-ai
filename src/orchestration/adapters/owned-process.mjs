import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { AiCliError } from '../../errors.mjs';
import { ORCHESTRATION_LIMITS } from '../constants.mjs';
import { createPlatformIdentityDeps } from '../process-identity.mjs';
import { createAtomicExclusiveFile } from '../atomic-file.mjs';
import { sanitizeValue } from '../redaction.mjs';
import { validateAdapter } from './index.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Generic shell-disabled owned-process adapter: the compatibility floor.
 * Spawns an argv-array process group, streams bounded sanitized output into
 * progress Deliveries (spilling to refs past the inline bound), and owns the
 * SIGINT -> SIGTERM -> SIGKILL interrupt ladder with recorded receipts.
 */
export function createOwnedProcessAdapter(options = {}) {
  const stateDir = options.stateDir;
  if (!stateDir) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'owned-process adapter requires a machine-local state dir', { exitCode: 2 });
  }
  const refsDir = join(stateDir, 'refs');
  const thisRefsDir = () => refsDir;
  const signalGraceMs = options.signalGraceMs ?? 400;
  // Test seam only: production always uses the shared ORCHESTRATION_LIMITS
  // bound. Kept as an option so the quota contract is testable at realistic
  // byte sizes.
  const maxRefsTotalBytes = options.maxRefsTotalBytesForTest ?? ORCHESTRATION_LIMITS.maxRefsTotalBytes;

  /**
   * COORDINATION-TOTAL accounting, rebuilt from the durable refs directory on
   * every decision: the bound applies to the WHOLE coordination's evidence
   * (every dispatch namespace AND acceptance-command spills), never to a
   * single dispatch. Each drain runs synchronously on the event loop, so the
   * scan -> decide -> exclusive-create sequence below is atomic within the
   * single-writer supervisor process — safe under sequential and concurrent
   * spills alike, and trivially rebuilt after recovery.
   */
  const durableRefsBytes = (dir) => {
    let total = 0;
    try {
      for (const name of readdirSync(dir)) {
        try {
          const stats = statSync(join(dir, name));
          if (stats.isFile()) total += stats.size;
        } catch { /* raced removal contributes nothing */ }
      }
    } catch { /* empty or missing refs dir */ }
    return total;
  };

  async function gracefulKill(child, recordSignal) {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      recordSignal(signal);
      try {
        child.kill(signal);
      } catch {
        // Already gone; cleanup proceeds with proof below.
      }
      const exited = await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        new Promise((resolveTick) => setTimeout(resolveTick, signalGraceMs).unref?.()),
      ]);
      if (exited !== undefined) return;
    }
    recordSignal('SIGKILL');
    try {
      child.kill('SIGKILL');
    } catch {
      // Nothing left to kill.
    }
  }

  const adapter = {
    id: 'owned-process',
    maturity: 'fixture-only',
    capabilities: {
      liveEvents: false,
      explicitResume: false,
      externalAttach: false,
      questionChannel: false,
      permissionControl: false,
      sameTurnSteer: false,
      gracefulInterrupt: true,
      preToolGate: false,
      processOwnership: true,
      fileEvents: false,
      testEvents: false,
    },
    async probe() {
      return {
        adapterId: this.id,
        available: true,
        maturity: this.maturity,
        capabilities: this.capabilities,
      };
    },
    async sanitize(event) {
      return event;
    },
    async attach() {
      throw new AiCliError('WORKER_IDENTITY_UNPROVEN', 'generic processes have no attachable session identity');
    },
    async readSession() {
      return null;
    },
    sendReply() {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'generic workers expose no semantic reply channel');
    },
    sendGuidance() {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'generic workers expose no guidance channel');
    },
    resolvePermission() {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'generic workers expose no permission channel');
    },
    async close({ binding }) {
      const child = binding?.__child;
      const groupId = binding?.processIdentity?.processGroupId;
      if (!groupId || groupId <= 1 || process.platform === 'win32') {
        return { ok: true, disposition: 'no-op' };
      }
      const hasExited = () => Boolean(child && (child.exitCode !== null || child.signalCode !== null));
      if (hasExited()) {
        return { ok: true, disposition: 'already-exited', signalsAttempted: [] };
      }
      const signalsAttempted = [];
      const signalGroup = (signal) => {
        try {
          process.kill(-groupId, signal);
        } catch {
          try {
            child?.kill(signal);
          } catch {
            // Already gone.
          }
        }
        signalsAttempted.push(signal);
      };
      const waitForExit = () =>
        child
          ? Promise.race([
              new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
              new Promise((resolveTick) => setTimeout(() => resolveTick(false), signalGraceMs).unref?.()),
            ])
          : Promise.resolve(false);
      // Group-level interrupt ladder: no grandchild may outlive a closed worker.
      signalGroup('SIGTERM');
      let stopped = await waitForExit();
      if (!stopped) {
        signalGroup('SIGKILL');
        stopped = await waitForExit();
      }
      return {
        ok: true,
        disposition: stopped ? 'group-stopped' : 'group-signalled',
        signalsAttempted: [...signalsAttempted],
      };
    },
    async interrupt({ binding, reason }) {
      if (!binding?.__child) {
        // Without the live child handle there is no proven ownership to signal.
        return {
          ok: false,
          error: new AiCliError('WORKER_IDENTITY_UNPROVEN', 'no live owned process proof for interrupt').toJSON(),
        };
      }
      const child = binding.__child;
      const attempted = binding.__signalsAttempted ?? [];
      await gracefulKill(child, (signal) => attempted.push(signal));
      // Best-effort group sweep so no grandchild outlives its worker.
      if (process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
          attempted.push('GROUP_SIGKILL');
        } catch {
          // Group already gone.
        }
      }
      return {
        ok: true,
        result: {
          interrupted: true,
          reason: String(reason ?? ''),
          signalsAttempted: [...attempted],
        },
        __signals: [...attempted],
      };
    },
    async subscribe() {
      return { ok: true, deliveries: [], cursor: null };
    },

    /**
     * Spawn one shell-disabled worker. Returns a binding with proven process
     * identity plus a `done` promise settling at terminal evidence.
     *
     * Spilled output refs are namespaced per coordination+dispatch+stream and
     * land in the COORDINATION's refsDir (passed via launch context), so two
     * dispatches can never overwrite each other's durable evidence and every
     * ref resolves exactly where receipts look. Creation is exclusive; total
     * spilled bytes stay under ORCHESTRATION_LIMITS.maxRefsTotalBytes.
     */
    async spawn({ task, dispatch, emit, command, args, env, preamble, refsDir, refNamespace }) {
      if (typeof command !== 'string' || (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')))) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'spawn requires a command string and an argv array, never a shell string', { exitCode: 2 });
      }
      const resolvedCommand = command ?? process.execPath;
      const argv = args ?? [task?.workerScript].filter(Boolean);
      const activeRefsDir = refsDir ?? thisRefsDir();
      const ns = typeof refNamespace === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(refNamespace)
        ? refNamespace
        : 'unnamed';
      let sequence = 0;
      const nextSeq = () => {
        sequence += 1;
        return sequence;
      };

      emit('worker_started', { dispatchId: dispatch.dispatchId });
      // A not-yet-existing (canonicalized-safe) workspace tail is legal under
      // preventive confinement; create it so the child has a real cwd.
      try {
        mkdirSync(task.workspace, { recursive: true });
      } catch { /* spawn below surfaces an unusable workspace honestly */ }
      const child = spawn(resolvedCommand, argv, {
        cwd: task.workspace,
        env,
        detached: process.platform !== 'win32',
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // The worker's initial input contract: the bounded NON-SECRET Worker
      // ABI preamble line (when provided) precedes the objective; workers that
      // read stdin receive both lines, then the pipe closes so EOF-driven CLIs
      // settle deterministically.
      const stdinLines = [];
      if (typeof preamble === 'string' && preamble.length > 0) stdinLines.push(preamble);
      if (typeof task?.objective === 'string' && task.objective.length > 0) stdinLines.push(task.objective);
      if (stdinLines.length > 0) {
        child.stdin.end(`${stdinLines.join('\n')}\n`);
      }

      const identityDeps = createPlatformIdentityDeps();
      const probedStartIdentity = await identityDeps.getStartIdentity(child.pid);
      const provenStartIdentity = probedStartIdentity
        ?? `${process.platform}:indeterminate-${child.pid}`;
      // Launch-intent HANDSHAKE: the supervisor persists the BOUND lease the
      // instant the child exists and its identity is probed, closing the
      // crash window between spawn and durable binding persistence.
      await dispatch?.onSpawned?.({
        pid: child.pid,
        processGroupId: child.pid,
        startIdentity: provenStartIdentity,
        identityProven: probedStartIdentity !== null,
      });

      const signalsAttempted = [];
      const donePromise = new Promise((resolveDone) => {
        // Bounded accumulation: streams arrive in small chunks, so spill only
        // when the accumulated stream crosses the inline bound.
        const accumulators = new Map([['stdout', ''], ['stderr', '']]);
        let spilledCount = 0;

        const drain = (streamLabel) => {
          const buffered = accumulators.get(streamLabel) ?? '';
          if (!buffered) return;
          accumulators.set(streamLabel, '');
          const bytes = Buffer.byteLength(buffered, 'utf8');
          if (bytes <= ORCHESTRATION_LIMITS.maxInlinePayloadBytes) {
            emit('progress', {
              summary: `${streamLabel}: ${buffered.slice(0, 2000)}`,
              stream: streamLabel,
              bytes,
              truncatedInline: bytes > 2000,
            });
            return;
          }
          mkdirSync(activeRefsDir, { recursive: true, mode: 0o700 });
          const name = `ref_${ns}__${String(nextSeq()).padStart(6, '0')}__${streamLabel}.txt`;
          // Coordination-TOTAL bound, recounted from durable state right now.
          if (durableRefsBytes(activeRefsDir) + bytes > maxRefsTotalBytes) {
            emit('progress', {
              summary: `${streamLabel} output dropped: coordination refs retention bound reached`,
              stream: streamLabel,
              bytes,
              retentionOverflow: true,
            });
            return;
          }
          const sanitizedSpill = sanitizeValue(buffered);
          createAtomicExclusiveFile(
            join(activeRefsDir, name),
            typeof sanitizedSpill === 'string' ? sanitizedSpill : JSON.stringify(sanitizedSpill),
          );
          spilledCount += 1;
          emit('progress', {
            summary: `${streamLabel} output spilled to bounded ref`,
            stream: streamLabel,
            ref: join('refs', name),
            mediaType: 'text/plain',
            bytes,
            sha256: sha256(buffered),
          });
        };

        child.stdout.on('data', (chunk) => {
          accumulators.set('stdout', (accumulators.get('stdout') ?? '') + chunk.toString('utf8'));
          if (Buffer.byteLength(accumulators.get('stdout'), 'utf8') >= ORCHESTRATION_LIMITS.maxInlinePayloadBytes * 2) {
            drain('stdout');
          }
        });
        child.stderr.on('data', (chunk) => {
          accumulators.set('stderr', (accumulators.get('stderr') ?? '') + chunk.toString('utf8'));
          // Bounded memory: stderr drains at the same inline threshold as
          // stdout instead of accumulating until close.
          if (Buffer.byteLength(accumulators.get('stderr'), 'utf8') >= ORCHESTRATION_LIMITS.maxInlinePayloadBytes * 2) {
            drain('stderr');
          }
        });

        // 'close' fires after all stdio streams flushed — the only safe
        // terminal point for output-bearing workers ('exit' can precede it).
        const finishWith = (type, payload) => {
          emit(type, payload);
          resolveDone({
            terminalType: type,
            exitCode: payload.exitCode,
            signal: payload.signal ?? null,
          });
        };

        child.on('close', (code, signal) => {
          drain('stdout');
          drain('stderr');
          if (signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGKILL') {
            emit('cleanup_recorded', {
              dispatchId: dispatch.dispatchId,
              disposition: 'interrupted',
              signalsAttempted: signalsAttempted.length > 0 ? [...signalsAttempted, signal] : [signal],
              processIdentity: {
                pid: child.pid,
                startIdentity: provenStartIdentity,
                processGroupId: child.pid,
              },
            });
            finishWith('worker_cancelled', {
              taskId: task.taskId,
              dispatchId: dispatch.dispatchId,
              outcome: 'cancelled',
              exitCode: code,
              signal,
            });
            return;
          }
          if (code === 0) {
            finishWith('worker_done', {
              taskId: task.taskId,
              dispatchId: dispatch.dispatchId,
              outcome: 'completed',
              exitCode: code,
              source: 'owned-process-exit',
            });
          } else {
            finishWith('worker_failed', {
              taskId: task.taskId,
              dispatchId: dispatch.dispatchId,
              outcome: 'failed',
              exitCode: code,
              signal,
              source: 'owned-process-exit',
            });
          }
        });
        child.on('error', (error) => {
          finishWith('worker_failed', {
            taskId: task.taskId,
            dispatchId: dispatch.dispatchId,
            outcome: 'failed',
            error: error.code ?? 'SPAWN_ERROR',
          });
        });
      });

      const binding = {
        bindingId: dispatch.bindingId,
        adapterId: 'owned-process',
        guaranteeTier: 'owned-process',
        processIdentity: {
          pid: child.pid,
          startIdentity: provenStartIdentity,
          processGroupId: child.pid,
          runtimeNonce: sha256(`${child.pid}:${Date.now()}:${Math.random()}`).slice(0, 16),
        },
        __child: child,
        __signalsAttempted: signalsAttempted,
        done: donePromise,
      };
      return {
        ok: true,
        binding,
        done: donePromise,
        __signals: signalsAttempted,
      };
    },
  };

  validateAdapter(adapter);
  return adapter;
}
