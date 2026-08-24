import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AiCliError } from '../errors.mjs';

const TERMINAL_OUTCOME_MAP = Object.freeze({
  done: { deliveryType: 'worker_done', outcome: 'completed' },
  failed: { deliveryType: 'worker_failed', outcome: 'failed' },
  cancelled: { deliveryType: 'worker_cancelled', outcome: 'cancelled' },
});

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

/**
 * Versioned Worker ABI packet. The model-visible preamble excludes the
 * callback endpoint/capability; objective and policy travel as digests only.
 */
export function buildWorkerPacket(task, dispatch) {
  return {
    schema: 'webmcp.ai-worker-packet/v0',
    coordinationId: dispatch.coordinationId,
    taskId: task.taskId,
    dispatchId: dispatch.dispatchId,
    bindingId: dispatch.bindingId,
    mode: dispatch.mode,
    guaranteeTier: dispatch.guaranteeTier,
    fenceEpoch: dispatch.fenceEpoch,
    objectiveDigest: `sha256:${digest(task.objective)}`,
    policyDigest: `sha256:${digest({
      allowedReadRoots: task.allowedReadRoots,
      allowedWriteRoots: task.allowedWriteRoots,
      protectedPaths: task.protectedPaths,
      commandPolicy: task.commandPolicy,
      delegationDepth: task.delegationDepth,
    })}`,
    workspace: task.workspace,
    initialRevision: task.initialRevision ?? null,
    allowedReadRoots: task.allowedReadRoots ?? [],
    allowedWriteRoots: task.allowedWriteRoots ?? [],
    protectedPaths: task.protectedPaths ?? [],
    questionRoute: 'dispatch-callback',
    terminalReportRoute: 'dispatch-callback',
    cleanupOwner: 'coordination',
    acceptanceCommands: (task.acceptanceCommands ?? []).slice(0, 16),
  };
}

/**
 * Persist the per-Dispatch worker capability file. Mode-0600, machine-local;
 * its path may be passed via environment, its content may not.
 */
export function writeDispatchCapability(layout, dispatch, capabilityToken) {
  const capabilityDir = join(layout.coordinationDir, 'dispatch-capabilities');
  const file = join(capabilityDir, `${dispatch.dispatchId}.cap`);
  writeFileSync(file, `${JSON.stringify({ schema: 'webmcp.ai-dispatch-capability/v0', ...dispatch, capabilityToken })}\n`, { mode: 0o600 });
  return file;
}

export function generateDispatchCapabilityToken() {
  return randomBytes(24).toString('hex');
}

function requireCallbackSeq(callback) {
  if (!Number.isInteger(callback?.callbackSeq) || callback.callbackSeq < 1) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'worker callbacks require a positive integer callbackSeq (per-binding monotonic identity)',
      { exitCode: 2 },
    );
  }
  return callback.callbackSeq;
}

function callbackRefFor(bindingId, callback) {
  const seq = requireCallbackSeq(callback);
  const digestValue = digest({ operation: callback.operation, input: callback.input ?? null });
  return { bindingId, seq, digest: digestValue };
}

/**
 * The exact internal worker handler table. Each entry verifies callback
 * identity/digest, Dispatch capability, active binding and epoch before
 * delegating to the owner's single-writer commit path. Every commit carries a
 * verified callbackRef so acknowledgement watermarks persist durably:
 *
 * - duplicate (any seq <= lastSeq with matching retained digest) returns the
 *   PRIOR committed acknowledgement without appending;
 * - stale/gap/conflicting replays fail closed through the classifier;
 * - terminal settlement is exactly-once across retries and supervisor
 *   restarts; conflicting outcomes escalate without overwriting history.
 */
export function createWorkerCallbackHandlers(options) {
  function resolveBinding(callback) {
    if (!options.bindings.has(callback.bindingId)) {
      throw new AiCliError('WORKER_CALLBACK_UNAUTHORIZED', 'unknown worker binding');
    }
    return options.bindings.get(callback.bindingId);
  }

  function authorize(callback, presentedCapability, presentingBindingId) {
    const binding = resolveBinding(callback);
    if (presentingBindingId !== undefined && presentingBindingId !== callback.bindingId) {
      throw new AiCliError('WORKER_CALLBACK_UNAUTHORIZED', 'callback identity does not match the presenting binding');
    }
    if (presentedCapability !== binding.capabilityToken) {
      throw new AiCliError('WORKER_CALLBACK_UNAUTHORIZED', 'dispatch capability unproven');
    }
    if (callback.dispatchId !== binding.dispatchId || callback.taskId !== binding.taskId) {
      throw new AiCliError('WORKER_CALLBACK_UNAUTHORIZED', 'callback does not match its recorded dispatch');
    }
    if (callback.fenceEpoch !== options.fenceEpoch()) {
      throw new AiCliError('STALE_COORDINATOR_EPOCH', 'worker used a stale fence epoch');
    }
    return binding;
  }

  function requireLiveDispatch(binding) {
    const isActive = typeof options.activeDispatches === 'function'
      ? options.activeDispatches().has(binding.dispatchId)
      : options.activeDispatches.has(binding.dispatchId);
    if (!isActive) {
      throw new AiCliError('DISPATCH_NOT_FOUND', 'dispatch is no longer active for callbacks');
    }
    return binding;
  }

  /**
   * Terminal reports must stay idempotent even when the dispatch already
   * settled: the durable watermark replays prior acks for identical retries,
   * unknown dispatches are typed rejections, conflicting outcomes escalate in
   * the reducer without overwriting settled history.
   */
  function authorizeTerminal(callback, presentedCapability) {
    const binding = resolveBinding(callback);
    if (presentedCapability !== binding.capabilityToken) {
      throw new AiCliError('WORKER_CALLBACK_UNAUTHORIZED', 'dispatch capability unproven');
    }
    if (callback.dispatchId !== binding.dispatchId || callback.taskId !== binding.taskId) {
      throw new AiCliError('WORKER_CALLBACK_UNAUTHORIZED', 'callback does not match its recorded dispatch');
    }
    if (callback.fenceEpoch !== options.fenceEpoch()) {
      throw new AiCliError('STALE_COORDINATOR_EPOCH', 'worker used a stale fence epoch');
    }
    const isActive = typeof options.activeDispatches === 'function'
      ? options.activeDispatches().has(binding.dispatchId)
      : options.activeDispatches.has(binding.dispatchId);
    const knownDispatches = typeof options.knownDispatchIds === 'function'
      ? options.knownDispatchIds()
      : null;
    if (!isActive && !(knownDispatches?.has?.(binding.dispatchId))) {
      throw new AiCliError('DISPATCH_NOT_FOUND', 'terminal report references an unknown or terminally incompatible dispatch');
    }
    return binding;
  }

  async function recordActivity(operationType, callback, presentedCapability, presentingBindingId) {
    const binding = authorize(callback, presentedCapability, presentingBindingId);
    requireLiveDispatch(binding);
    const callbackRef = callbackRefFor(callback.bindingId, callback);
    const outcome = options.appendDelivery(operationType, {
      summary: String(callback.input?.summary ?? '').slice(0, 2000),
      activity: callback.input?.activity ?? null,
      eventId: `${callback.bindingId}:${callbackRef.seq}`,
      bindingId: callback.bindingId,
      dispatchId: binding.dispatchId,
    }, callbackRef);
    if (outcome.duplicate) {
      return { ok: true, duplicate: true, acknowledgedSequence: outcome.acknowledgedSequence };
    }
    return { ok: true, sequence: outcome.sequence, duplicate: false, acknowledgedSequence: outcome.sequence };
  }

  function guarded(handlerFn) {
    return async (request) => {
      try {
        return await handlerFn(request);
      } catch (error) {
        if (error instanceof AiCliError) {
          return { ok: false, error: { code: error.code, message: error.message } };
        }
        throw error;
      }
    };
  }

  return Object.freeze({
    'worker.heartbeat': guarded(async (request) => recordActivity('heartbeat', request.callback, request.presentedCapability, request.presentingBindingId)),
    'worker.progress': guarded(async (request) => recordActivity('progress', request.callback, request.presentedCapability, request.presentingBindingId)),
    'worker.question': guarded(async (request) => {
      const binding = authorize(request.callback, request.presentedCapability, request.presentingBindingId);
      requireLiveDispatch(binding);
      const callbackRef = callbackRefFor(request.callback.bindingId, request.callback);
      const outcome = options.appendDelivery('question', {
        question: String(request.callback.input?.question ?? '').slice(0, 4000),
        eventId: `${request.callback.bindingId}:${callbackRef.seq}`,
        bindingId: request.callback.bindingId,
        dispatchId: binding.dispatchId,
      }, callbackRef);
      if (outcome.duplicate) return { ok: true, duplicate: true, acknowledgedSequence: outcome.acknowledgedSequence };
      return { ok: true, sequence: outcome.sequence, acknowledgedSequence: outcome.sequence };
    }),
    'worker.escalation': guarded(async (request) => {
      const binding = authorize(request.callback, request.presentedCapability, request.presentingBindingId);
      requireLiveDispatch(binding);
      const callbackRef = callbackRefFor(request.callback.bindingId, request.callback);
      const outcome = options.appendDelivery('escalation', {
        reason: String(request.callback.input?.reason ?? '').slice(0, 4000),
        eventId: `${request.callback.bindingId}:${callbackRef.seq}`,
        bindingId: request.callback.bindingId,
        dispatchId: binding.dispatchId,
      }, callbackRef);
      if (outcome.duplicate) return { ok: true, duplicate: true, acknowledgedSequence: outcome.acknowledgedSequence };
      return { ok: true, sequence: outcome.sequence, acknowledgedSequence: outcome.sequence };
    }),
    'worker.terminal': guarded(async ({ callback, presentedCapability }) => {
      const proposed = TERMINAL_OUTCOME_MAP[callback.input?.outcome];
      if (!proposed) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          'worker terminal may propose only done|failed|cancelled',
          { exitCode: 2 },
        );
      }
      const binding = authorizeTerminal(callback, presentedCapability);
      const callbackRef = callbackRefFor(callback.bindingId, callback);

      // Conflicting outcomes are journaled as escalation evidence and never
      // overwrite the settled history of the dispatch.
      const settledOutcome = typeof options.dispatchOutcomeOf === 'function'
        ? options.dispatchOutcomeOf(binding.dispatchId)
        : null;
      if (settledOutcome && settledOutcome !== proposed.outcome) {
        const escalated = options.appendDelivery('escalation', {
          reason: `conflicting terminal outcome ${settledOutcome} vs ${proposed.outcome}`,
          eventId: `${callback.bindingId}:${callbackRef.seq}`,
          bindingId: callback.bindingId,
          dispatchId: binding.dispatchId,
        }, callbackRef);
        if (escalated.duplicate) {
          return { ok: true, duplicate: true, acknowledgedSequence: escalated.acknowledgedSequence };
        }
        return { ok: true, escalated: true, sequence: escalated.sequence, acknowledgedSequence: escalated.sequence };
      }

      // Exactly-once settlement: identical replays (including across restart)
      // hit the durable watermark and replay the prior acknowledgement.
      const settled = options.appendDelivery(proposed.deliveryType, {
        taskId: callback.taskId,
        dispatchId: callback.dispatchId,
        outcome: proposed.outcome,
        summary: String(callback.input?.summary ?? '').slice(0, 4000),
        source: 'worker-callback',
        eventId: `${callback.bindingId}:${callbackRef.seq}`,
      }, callbackRef);
      if (settled.duplicate) {
        return { ok: true, duplicate: true, acknowledgedSequence: settled.acknowledgedSequence };
      }
      void binding;
      return { ok: true, sequence: settled.sequence, acknowledgedSequence: settled.sequence };
    }),
  });
}
