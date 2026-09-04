import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { AiCliError } from '../../errors.mjs';
import { ORCHESTRATION_LIMITS } from '../constants.mjs';
import { awaitProcessGroupEmpty, createPlatformIdentityDeps, isPidLive, proveProcessGroupEmpty } from '../process-identity.mjs';
import { createAtomicExclusiveFile } from '../atomic-file.mjs';
import { reserveRefsBytes } from '../refs-quota.mjs';
import { sanitizeValue } from '../redaction.mjs';
import { validateAdapter } from './index.mjs';
import {
  assertBoundWorkspaceIdentity,
  assertBoundWorkspaceSafe,
  HOST_ISOLATION_LAUNCH_BOUNDARY,
  HOST_ISOLATION_LIFECYCLE_UNTRUSTED,
} from '../managed-host/host-isolation.mjs';

// Only this factory can mint the adapter trust marker. Keeping the marker
// beside the implementation prevents callers from promoting an arbitrary
// spawn-shaped object after the supervisor has validated its lifecycle.
const TRUSTED_OWNED_PROCESS_ADAPTER = Symbol('webmcp.trusted-owned-process-adapter');

function markTrustedOwnedProcessAdapter(adapter) {
  if (typeof adapter !== 'object' || adapter === null || Array.isArray(adapter)) {
    throw new AiCliError(HOST_ISOLATION_LIFECYCLE_UNTRUSTED, 'trusted owned-process adapter must be an object', { exitCode: 2 });
  }
  for (const method of ['spawn', 'interrupt', 'close']) {
    if (typeof adapter[method] !== 'function') {
      throw new AiCliError(HOST_ISOLATION_LIFECYCLE_UNTRUSTED, `trusted owned-process adapter is missing ${method}()`, { exitCode: 2 });
    }
  }
  if (adapter.capabilities && typeof adapter.capabilities === 'object') {
    Object.freeze(adapter.capabilities);
  }
  const marker = Object.freeze({
    spawn: adapter.spawn,
    interrupt: adapter.interrupt,
    close: adapter.close,
  });
  Object.defineProperty(adapter, TRUSTED_OWNED_PROCESS_ADAPTER, { value: marker });
  return Object.freeze(adapter);
}

export function isTrustedOwnedProcessAdapter(adapter) {
  const marker = adapter?.[TRUSTED_OWNED_PROCESS_ADAPTER];
  return Object.isFrozen(adapter)
    && Object.isFrozen(marker)
    && marker?.spawn === adapter.spawn
    && marker?.interrupt === adapter.interrupt
    && marker?.close === adapter.close;
}

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
  // Deterministic race seam for the launch-boundary test. Production adapter
  // assembly never supplies this callback; it is deliberately outside task,
  // packet and IPC input.
  const beforeSpawnHook = typeof options.beforeSpawnHook === 'function' ? options.beforeSpawnHook : null;
  // Test seam only: production always uses the shared ORCHESTRATION_LIMITS
  // bound. Kept as an option so the quota contract is testable at realistic
  // byte sizes.
  const maxRefsTotalBytes = options.maxRefsTotalBytesForTest ?? ORCHESTRATION_LIMITS.maxRefsTotalBytes;

  // COORDINATION-TOTAL accounting now lives in the shared quota primitive
  // (refs-quota.mjs): disk-derived, shared by every refs/ writer, typed on
  // overflow and trivially rebuilt after recovery.

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
      const platform = options.platformForTest ?? process.platform;
      // ABSENCE IS THE ONLY no-op TICKET: a live child must never be skipped
      // because of a platform check. Where group signalling is unavailable
      // (win32 / no group), the pid-level ladder still runs to completion.
      //
      // NOTE on the pid-only branch below: this platform/identity has no
      // POSIX process-group primitive to prove emptiness with (win32 has no
      // process groups and this runtime has not wired up a Job Object
      // substitute yet; `!groupId || groupId <= 1` means no group was even
      // recorded). `group-stopped` here therefore means "the single owned
      // pid provably exited", NOT "the whole process group is provably
      // empty" — see the settlement.mjs contract doc for the platform
      // caveat. It is the best proof available in the absence of a group,
      // and is a deliberate, documented degrade (see R13 handoff), not an
      // oversight.
      const settled = () => !child || child.exitCode !== null || child.signalCode !== null;
      if (platform === 'win32' || !groupId || groupId <= 1) {
        if (settled()) return { ok: true, disposition: 'no-op', signalsAttempted: [] };
        const signalsAttempted = [];
        const ladder = ['SIGTERM', 'SIGKILL'];
        for (const signal of ladder) {
          try {
            child.kill(signal);
            signalsAttempted.push(signal);
          } catch { /* already gone */ }
          await Promise.race([
            new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
            new Promise((resolveTick) => setTimeout(() => resolveTick(false), signalGraceMs)),
          ]);
          if (settled()) {
            return { ok: true, disposition: 'group-stopped', exitProven: true, signalsAttempted: [...signalsAttempted] };
          }
        }
        return { ok: true, disposition: 'group-signalled', signalsAttempted: [...signalsAttempted] };
      }
      if (settled()) {
        // The leader was ALREADY gone before close() was ever called — a
        // normal worker that finished its own work and exited while a
        // background/detached child it spawned lingers, no signal ladder
        // involved at all. Node's own child-object bookkeeping (settled())
        // is 100% reliable proof that OUR exact leader is dead, but the
        // numeric groupId is just that dead leader's OLD pid number, and an
        // UNBOUNDED amount of real time may have passed since it exited
        // (unlike the live-leader ladder below, whose whole window is
        // bounded by our own signal-grace timeouts). Before trusting
        // `-groupId` as "our own orphaned descendants", rule out the OS
        // having recycled that exact pid for an unrelated process: if
        // anything at all currently occupies that literal pid, NOTHING
        // about `-groupId`'s membership can be trusted as ours (a brand
        // new unrelated process could only ever end up sharing that pgid
        // number by itself BEING that pid and founding a new group with
        // it), so fail closed rather than risk signalling a stranger's
        // process group.
        // (platform !== 'win32' && groupId > 1 already guaranteed here —
        // the branch above already returned for win32/no-group.)
        if (isPidLive(groupId)) {
          return { ok: true, disposition: 'group-signalled', signalsAttempted: [] };
        }
        const initialProof = proveProcessGroupEmpty(groupId, platform);
        if (initialProof !== 'alive') {
          return { ok: true, disposition: 'already-exited', signalsAttempted: [] };
        }
        // The group still has live members despite the leader's own prior
        // exit: fall through into the SAME ladder used below for a leader
        // that was still alive at call time — no grandchild may outlive a
        // closed worker just because its leader beat close() to the exit.
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
      // A dead child's 'exit' event has ALREADY fired once and will never
      // fire again: attaching a listener AFTER the fact — which the group
      // escalation below can legitimately do, since the leader may already
      // be gone while the group still has live members — would otherwise
      // resolve ONLY through the unref'd fallback timer below, which by
      // definition never keeps the loop alive on its own. The settled()
      // check up front is what makes this a real, always-resolving wait
      // rather than a leak that only happened not to be hit before this
      // ladder started calling it a second time.
      const waitForExit = () => new Promise((resolveExit) => {
        if (!child || settled()) { resolveExit(true); return; }
        const timer = setTimeout(() => {
          child.off('exit', onExit);
          resolveExit(settled());
        }, signalGraceMs);
        const onExit = () => {
          clearTimeout(timer);
          resolveExit(true);
        };
        child.once('exit', onExit);
      });
      // Group-level interrupt ladder: no grandchild may outlive a closed
      // worker. PROOF, not the leader's own `exit` event, gates escalation
      // and the terminal disposition: a leader that comply-exits after
      // SIGTERM says NOTHING about grandchildren that ignored the same
      // signal and are still parented inside the group. `waitForExit()` is
      // used only to pace each rung (an early-exit optimisation when the
      // leader happens to die quickly); the actual decision to stop
      // escalating — and the only thing allowed to authorize
      // `group-stopped` + `exitProven: true` — is an independent
      // `kill(-pgid, 0)` probe of the WHOLE group.
      signalGroup('SIGTERM');
      await waitForExit();
      let groupProof = proveProcessGroupEmpty(groupId, platform);
      if (groupProof !== 'empty') {
        signalGroup('SIGKILL');
        await waitForExit();
        groupProof = proveProcessGroupEmpty(groupId, platform);
      }
      if (groupProof !== 'empty') {
        // A group that was JUST SIGKILLed can still read 'alive' for a few
        // milliseconds purely because the kernel has not reaped it yet, not
        // because anything survived. A short bounded re-probe avoids
        // wasting a whole finalize-retry round-trip on that race, WITHOUT
        // trading away the fail-closed contract: if the group is still
        // alive when the budget runs out, that exact (unproven) reading is
        // what gets returned below.
        groupProof = await awaitProcessGroupEmpty(groupId, platform);
      }
      if (groupProof === 'empty') {
        return { ok: true, disposition: 'group-stopped', exitProven: true, signalsAttempted: [...signalsAttempted] };
      }
      return { ok: true, disposition: 'group-signalled', signalsAttempted: [...signalsAttempted] };
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
    async spawn({ task, dispatch, emit, command, args, env, preamble, refsDir, refNamespace, brokerSocket = null, cwdBinding = null }) {
      if (typeof command !== 'string' || (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')))) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'spawn requires a command string and an argv array, never a shell string', { exitCode: 2 });
      }
      if (brokerSocket !== null && (typeof brokerSocket !== 'object' || typeof brokerSocket.on !== 'function')) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'managed broker must be an inherited stream', { exitCode: 2 });
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
      let child;
      let previousCwd = null;
      let cwdBound = false;
      try {
        if (cwdBinding !== null) {
          if (typeof cwdBinding !== 'object'
            || cwdBinding.workspace !== task.workspace
            || cwdBinding.cwd !== task.workspace
            || cwdBinding.launchBoundary !== HOST_ISOLATION_LAUNCH_BOUNDARY
            || typeof cwdBinding.workspaceReadSetDigest !== 'string') {
            throw new AiCliError('HOST_ISOLATION_UNSAFE_WORKSPACE', 'managed launch cwd binding does not match the validated workspace', { exitCode: 2 });
          }
          previousCwd = process.cwd();
          // process.chdir binds the current working directory to the kernel's
          // directory inode. spawn() then inherits that binding, so a rename
          // or symlink replacement of the pathname cannot redirect the child.
          process.chdir(cwdBinding.cwd);
          cwdBound = true;
          assertBoundWorkspaceSafe(cwdBinding.workspace);
          if (beforeSpawnHook) {
            const hookResult = beforeSpawnHook({ workspace: cwdBinding.workspace });
            if (hookResult && typeof hookResult.then === 'function') {
              throw new AiCliError('HOST_ISOLATION_UNSAFE_WORKSPACE', 'managed launch boundary hook must be synchronous', { exitCode: 2 });
            }
          }
          // The full safety scan is intentionally before the deterministic
          // race seam. After the seam, re-prove the cwd inode and every
          // snapshotted read-set entry before spawn; new names remain outside
          // the immutable Seatbelt literal read-set.
          assertBoundWorkspaceIdentity(cwdBinding.workspace, cwdBinding.workspaceReadSetDigest);
        }
        child = spawn(resolvedCommand, argv, {
          ...(cwdBound ? {} : { cwd: task.workspace }),
          // Node may augment the supplied environment while propagating its
          // own instrumentation (for example NODE_V8_COVERAGE). Launch specs
          // are intentionally frozen, so hand the runtime a private mutable
          // copy without changing the caller-owned authority boundary.
          env: env === undefined ? undefined : { ...env },
          detached: process.platform !== 'win32',
          shell: false,
          stdio: brokerSocket === null
            ? ['pipe', 'pipe', 'pipe']
            : ['pipe', 'pipe', 'pipe', brokerSocket],
        });
      } finally {
        if (cwdBound && previousCwd !== null) {
          process.chdir(previousCwd);
        }
      }

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
      // Launch-intent HANDSHAKE: the supervisor persists the BOUND lease the
      // instant the child exists and its identity is probed, closing the
      // crash window between spawn and durable binding persistence. Identity
      // is recorded ONLY when actually proven — never fabricated.
      await dispatch?.onSpawned?.({
        pid: child.pid,
        processGroupId: child.pid,
        ...(probedStartIdentity ? { startIdentity: probedStartIdentity } : {}),
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
          // Coordination-TOTAL bound via the shared quota primitive: the
          // reservation uses the ACTUAL sanitized bytes about to be written
          // (never the raw size), recounted from durable disk state, so every
          // writer into refs/ shares one honest ceiling.
          const sanitizedSpill = sanitizeValue(buffered);
          const spillText = typeof sanitizedSpill === 'string'
            ? sanitizedSpill
            : JSON.stringify(sanitizedSpill);
          try {
            reserveRefsBytes(activeRefsDir, Buffer.byteLength(spillText, 'utf8'), {
              limitBytes: maxRefsTotalBytes,
              writerId: `owned-spill:${ns}:${streamLabel}`,
            });
          } catch (error) {
            if (error?.code === 'REFS_LIMIT_REACHED') {
              emit('progress', {
                summary: `${streamLabel} output dropped: coordination refs retention bound reached`,
                stream: streamLabel,
                bytes,
                retentionOverflow: true,
              });
              return;
            }
            throw error;
          }
          mkdirSync(activeRefsDir, { recursive: true, mode: 0o700 });
          const name = `ref_${ns}__${String(nextSeq()).padStart(6, '0')}__${streamLabel}.txt`;
          createAtomicExclusiveFile(join(activeRefsDir, name), spillText);
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
                ...(probedStartIdentity ? { startIdentity: probedStartIdentity } : {}),
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
          ...(probedStartIdentity ? { startIdentity: probedStartIdentity } : {}),
          identityProven: probedStartIdentity !== null,
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
  return markTrustedOwnedProcessAdapter(adapter);
}
