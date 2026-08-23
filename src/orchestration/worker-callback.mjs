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

/**
 * The exact internal worker handler table. Each entry verifies callback
 * identity/digest, Dispatch capability, active binding and epoch before
 * mapping onto the closed Delivery registry.
 */
export function createWorkerCallbackHandlers(options) {
  const seenCallbacks = new Map(); // callbackId -> digest
  const terminalOutcomes = new Map(); // dispatchId -> proposed outcome

  function authorize(callback, presentedCapability, presentingBindingId) {
    if (!options.bindings.has(callback.bindingId)) {
      throw new AiCliError('WORKER_CALLBACK_UNAUTHORIZED', 'unknown worker binding');
    }
    const binding = options.bindings.get(callback.bindingId);
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
    if (typeof options.activeDispatches === 'function'
      ? !options.activeDispatches().has(binding.dispatchId)
      : !options.activeDispatches.has(binding.dispatchId)) {
      throw new AiCliError('DISPATCH_NOT_FOUND', 'dispatch is no longer active for callbacks');
    }
    return binding;
  }

  function dedupeOrThrow(callback) {
    const contentDigest = digest({ operation: callback.operation, input: callback.input });
    const previous = seenCallbacks.get(callback.callbackId);
    if (previous) {
      if (previous !== contentDigest) {
        throw new AiCliError(
          'WORKER_CALLBACK_UNAUTHORIZED',
          'callback id reused with different content',
        );
      }
      return true; // duplicate
    }
    seenCallbacks.set(callback.callbackId, contentDigest);
    return false;
  }

  async function recordActivity(operationType, callback, presentedCapability, presentingBindingId) {
    const binding = authorize(callback, presentedCapability, presentingBindingId);
    const duplicate = dedupeOrThrow(callback);
    const envelope = options.appendDelivery(operationType, {
      summary: String(callback.input?.summary ?? '').slice(0, 2000),
      activity: callback.input?.activity ?? null,
      bindingId: callback.bindingId,
      dispatchId: binding.dispatchId,
    });
    return { ok: true, sequence: envelope.sequence, duplicate };
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
      const duplicate = dedupeOrThrow(request.callback);
      const envelope = options.appendDelivery('question', {
        question: String(request.callback.input?.question ?? '').slice(0, 4000),
        bindingId: request.callback.bindingId,
        dispatchId: binding.dispatchId,
      });
      void duplicate;
      return { ok: true, sequence: envelope.sequence };
    }),
    'worker.escalation': guarded(async (request) => {
      const binding = authorize(request.callback, request.presentedCapability, request.presentingBindingId);
      const duplicate = dedupeOrThrow(request.callback);
      const envelope = options.appendDelivery('escalation', {
        reason: String(request.callback.input?.reason ?? '').slice(0, 4000),
        bindingId: request.callback.bindingId,
        dispatchId: binding.dispatchId,
      });
      void duplicate;
      return { ok: true, sequence: envelope.sequence };
    }),
    'worker.terminal': guarded(async ({ callback, presentedCapability }) => {
      const binding = authorize(callback, presentedCapability);
      const proposed = TERMINAL_OUTCOME_MAP[callback.input?.outcome];
      if (!proposed) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          'worker terminal may propose only done|failed|cancelled',
          { exitCode: 2 },
        );
      }
      const duplicate = dedupeOrThrow(callback);

      // One logical terminal settlement per Dispatch: identical replays are
      // no-ops, conflicting proposals escalate and never overwrite.
      const existingOutcome = terminalOutcomes.get(binding.dispatchId);
      if (existingOutcome === proposed.outcome) {
        return { ok: true, duplicate: true };
      }
      if (existingOutcome !== undefined && existingOutcome !== proposed.outcome) {
        options.appendDelivery('escalation', {
          reason: `conflicting terminal outcome ${existingOutcome} vs ${proposed.outcome}`,
          bindingId: callback.bindingId,
          dispatchId: binding.dispatchId,
        });
        return { ok: true, escalated: true };
      }

      if (!duplicate) {
        terminalOutcomes.set(binding.dispatchId, proposed.outcome);
        options.appendDelivery(proposed.deliveryType, {
          taskId: callback.taskId,
          dispatchId: callback.dispatchId,
          outcome: proposed.outcome,
          summary: String(callback.input?.summary ?? '').slice(0, 4000),
          source: 'worker-callback',
        });
      }
      return { ok: true };
    }),
  });
}
