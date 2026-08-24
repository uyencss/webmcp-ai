import { AiCliError } from '../errors.mjs';
import {
  ACCEPTANCE_STATES,
  COORDINATION_STATES,
  DELIVERY_TYPES,
  GUARANTEE_TIERS,
  ID_PREFIXES,
  SNAPSHOT_SCHEMA,
  TEST_VERDICTS,
} from './constants.mjs';

export { DELIVERY_TYPES };

export const TASK_TRANSITIONS = Object.freeze({
  created: new Set(['ready', 'blocked', 'cancelled']),
  ready: new Set(['in_progress', 'blocked', 'cancelled']),
  in_progress: new Set(['awaiting_acceptance', 'blocked', 'cancelled']),
  awaiting_acceptance: new Set(['accepted', 'rejected', 'ready']),
  blocked: new Set(['ready', 'cancelled']),
  rejected: new Set(['ready', 'cancelled']),
  accepted: new Set(),
  cancelled: new Set(),
});

export const DISPATCH_TRANSITIONS = Object.freeze({
  created: new Set(['assigned', 'active', 'cancelled', 'failed', 'lost']),
  assigned: new Set(['active', 'cancelled', 'failed', 'lost']),
  active: new Set(['waiting', 'settling', 'cancelled', 'failed', 'lost']),
  waiting: new Set(['active', 'settling', 'cancelled', 'failed', 'lost']),
  settling: new Set(['settled', 'failed', 'lost']),
  settled: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  lost: new Set(),
});

export const DECISION_GATE_TRANSITIONS = Object.freeze({
  open: new Set(['resolved', 'expired', 'cancelled']),
  resolved: new Set(),
  expired: new Set(),
  cancelled: new Set(),
});

export const COORDINATION_TRANSITIONS = Object.freeze({
  open: new Set(['closing', 'abandoned']),
  closing: new Set(['closed']),
  closed: new Set(),
  abandoned: new Set(),
});

const MAX_RECEIPT_JSON_BYTES = 4096;
const MAX_ESCALATIONS = 256;
const MAX_INTERRUPT_EFFECTS = 256;
// Bounded per-binding dedupe window. Compaction below the window is safe:
// any replay at seq <= lastSeq without a retained digest classifies as stale
// and can never mutate committed (terminal) history.
export const CALLBACK_DEDUPE_WINDOW = 128;

function invalid(message, code = 'ORCHESTRATION_INVALID_INPUT') {
  return new AiCliError(code, message, { exitCode: 2 });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireInteger(value, label, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function assertTransition(map, from, to, label) {
  if (!map[from] || !map[from].has(to)) {
    throw invalid(`illegal ${label} transition ${String(from)} -> ${String(to)}`);
  }
}

export function assertTaskTransition(from, to) {
  assertTransition(TASK_TRANSITIONS, from, to, 'task');
}

export function assertDispatchTransition(from, to) {
  assertTransition(DISPATCH_TRANSITIONS, from, to, 'dispatch');
}

export function assertDecisionGateTransition(from, to) {
  assertTransition(DECISION_GATE_TRANSITIONS, from, to, 'decision gate');
}

export function createInitialState(manifest) {
  if (!isPlainObject(manifest)) throw invalid('manifest must be an object');
  return deepFreeze({
    schema: SNAPSHOT_SCHEMA,
    coordinationId: manifest.coordinationId,
    lastSequence: 0,
    acknowledgedThrough: 0,
    fenceEpoch: manifest.fenceEpoch,
    processGeneration: manifest.processGeneration,
    coordinationState: 'open',
    owner: null,
    tasks: Object.freeze({}),
    dispatches: Object.freeze({}),
    workers: Object.freeze({}),
    workerCallbacks: Object.freeze({}),
    gates: Object.freeze({}),
    escalations: Object.freeze([]),
    interruptEffects: Object.freeze([]),
    updatedAt: manifest.createdAt,
  });
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
  } else if (isPlainObject(value)) {
    Object.values(value).forEach(deepFreeze);
  }
  return Object.freeze(value);
}

function nextTask(taskId) {
  return {
    taskId,
    state: 'created',
    acceptance: 'pending',
    dependencies: [],
    cancel: null,
  };
}

function nextDispatch(dispatchId, taskId) {
  return {
    dispatchId,
    taskId,
    state: 'created',
    terminalOutcome: null,
    testVerdicts: [],
  };
}

function taskBlocked(state, taskId) {
  const gates = Object.values(state.gates);
  const hasOpenGate = gates.some(
    (gate) => gate.state === 'open'
      && (gate.taskId === taskId || gate.dependsOnTaskId === taskId),
  );
  if (hasOpenGate) return 'open decision gate';
  const task = state.tasks[taskId];
  const unresolved = (task?.dependencies ?? []).filter((depId) => {
    const dep = state.tasks[depId];
    return !dep || dep.state !== 'accepted';
  });
  if (unresolved.length > 0) return `unresolved dependencies: ${unresolved.join(', ')}`;
  return null;
}

function boundedReceipt(receipt) {
  if (receipt === undefined || receipt === null) {
    throw invalid('decision gate resolution requires a bounded receipt');
  }
  let serialized;
  try {
    serialized = JSON.stringify(receipt);
  } catch {
    throw invalid('decision gate resolution receipt must be JSON-serializable');
  }
  if (serialized.length > MAX_RECEIPT_JSON_BYTES) {
    throw invalid('decision gate resolution receipt exceeds the bounded size');
  }
  return receipt;
}

const TERMINAL_OUTCOMES = Object.freeze({
  worker_done: 'completed',
  worker_failed: 'failed',
  worker_cancelled: 'cancelled',
});

function applyTerminalWorker(state, delivery, payload, sequence) {
  const dispatch = state.dispatches[payload.dispatchId];
  if (!dispatch) throw invalid('terminal worker report references an unknown dispatch', 'DISPATCH_NOT_FOUND');
  if (dispatch.taskId !== payload.taskId) {
    throw invalid('terminal worker report task does not match its dispatch');
  }
  const outcome = TERMINAL_OUTCOMES[delivery.type];
  if (dispatch.terminalOutcome === outcome) {
    // Duplicate identical terminal delivery: idempotent no-op.
    return state;
  }
  if (dispatch.terminalOutcome !== null) {
    const escalations = [
      ...state.escalations.slice(-1 * (MAX_ESCALATIONS - 1)),
      {
        atSequence: sequence,
        taskId: payload.taskId,
        dispatchId: payload.dispatchId,
        reason: `conflicting terminal outcome ${dispatch.terminalOutcome} vs ${outcome}`,
      },
    ];
    return withMutations(state, { escalations });
  }
  if (!['active', 'waiting'].includes(dispatch.state)) {
    // Terminal reports for non-live dispatches are activity evidence only.
    return state;
  }

  const task = state.tasks[payload.taskId];
  if (!task) throw invalid('terminal worker report references an unknown task', 'TASK_NOT_FOUND');
  const dispatches = {
    ...state.dispatches,
    [payload.dispatchId]: Object.freeze({
      ...dispatch,
      state: 'settling',
      terminalOutcome: outcome,
    }),
  };
  let tasks = state.tasks;
  if (task.state === 'in_progress') {
    tasks = {
      ...state.tasks,
      [payload.taskId]: Object.freeze({ ...task, state: 'awaiting_acceptance' }),
    };
  }
  return withMutations(state, { dispatches, tasks });
}

function applyAcceptance(state, payload) {
  const task = state.tasks[payload.taskId];
  if (!task) throw invalid('acceptance references an unknown task', 'TASK_NOT_FOUND');
  if (task.state !== 'awaiting_acceptance') {
    throw invalid('acceptance_recorded requires a task awaiting acceptance');
  }
  if (!ACCEPTANCE_STATES.includes(payload.acceptance) || payload.acceptance === 'pending'
    || payload.acceptance === 'indeterminate') {
    throw invalid('acceptance_recorded verdict must be accepted or rejected');
  }
  assertTaskTransition(task.state, payload.acceptance);
  const tasks = {
    ...state.tasks,
    [payload.taskId]: Object.freeze({
      ...task,
      state: payload.acceptance,
      acceptance: payload.acceptance,
    }),
  };
  return withMutations(state, { tasks });
}

function applyDispatchStateChange(state, payload) {
  let dispatch = state.dispatches[payload.dispatchId];
  if (!dispatch) {
    // First observation of a dispatch: register it implicitly so ordered
    // provider/process events can drive the lifecycle directly.
    requireId(payload.dispatchId, ID_PREFIXES.dispatch, 'dispatchId');
    const taskId = requireId(payload.taskId, ID_PREFIXES.task, 'taskId');
    if (!state.tasks[taskId]) throw invalid('dispatch references an unknown task', 'TASK_NOT_FOUND');
    dispatch = nextDispatch(payload.dispatchId, taskId);
  }
  if (dispatch.taskId !== payload.taskId) {
    throw invalid('dispatch_state_changed task does not match its dispatch');
  }
  assertDispatchTransition(dispatch.state, payload.state);

  let tasks = state.tasks;
  if (payload.state === 'active') {
    const blocker = taskBlocked(state, payload.taskId);
    if (blocker) {
      throw invalid(`dispatch activation blocked: ${blocker}`, 'DECISION_GATE_BLOCKING');
    }
    const task = state.tasks[payload.taskId];
    // Activation walks the legal task path created -> ready -> in_progress so
    // every edge stays inside the frozen transition map.
    if (task && ['created', 'ready'].includes(task.state)) {
      let promoted = task;
      if (promoted.state === 'created') {
        assertTaskTransition(promoted.state, 'ready');
        promoted = { ...promoted, state: 'ready' };
      }
      assertTaskTransition(promoted.state, 'in_progress');
      promoted = { ...promoted, state: 'in_progress' };
      tasks = {
        ...state.tasks,
        [payload.taskId]: Object.freeze(promoted),
      };
    }
  }

  const dispatches = {
    ...state.dispatches,
    [payload.dispatchId]: Object.freeze({ ...dispatch, state: payload.state }),
  };

  let interruptEffects = state.interruptEffects;
  if (payload.state === 'cancelled' && dispatch.state !== 'cancelled') {
    // Every PROVEN cancellation of a live dispatch records exactly one
    // durable interrupt effect, independent of which terminal path (cancel,
    // close, worker self-report) won the race.
    interruptEffects = [
      ...interruptEffects.slice(-1 * (MAX_INTERRUPT_EFFECTS - 1)),
      { dispatchId: payload.dispatchId, taskId: payload.taskId, effect: 'interrupt' },
    ];
  }
  return withMutations(state, { dispatches, tasks, interruptEffects });
}

function applyTaskStateChange(state, payload) {
  const task = state.tasks[payload.taskId];
  if (!task) throw invalid('task_state_changed references an unknown task', 'TASK_NOT_FOUND');
  if ((payload.state === 'accepted' || payload.state === 'rejected')) {
    throw invalid('only acceptance_recorded may reach accepted or rejected');
  }
  if (payload.state === 'cancelled') {
    if (task.state === 'cancelled') return state; // idempotent
    assertTaskTransition(task.state, 'cancelled');
    const tasks = {
      ...state.tasks,
      [payload.taskId]: Object.freeze({
        ...task,
        state: 'cancelled',
        cancel: { reason: String(payload.reason ?? ''), actor: String(payload.actor ?? '') },
      }),
    };
    let interruptEffects = state.interruptEffects;
    for (const dispatch of Object.values(state.dispatches)) {
      // Live dispatches still earn an effect at task-cancel time; dispatches
      // the control path already reconciled recorded theirs at that moment.
      if (dispatch.taskId === payload.taskId
        && ['assigned', 'active', 'waiting'].includes(dispatch.state)
        && !interruptEffects.some((existing) => existing.dispatchId === dispatch.dispatchId)) {
        interruptEffects = [
          ...interruptEffects.slice(-1 * (MAX_INTERRUPT_EFFECTS - 1)),
          { dispatchId: dispatch.dispatchId, taskId: payload.taskId, effect: 'interrupt' },
        ];
      }
    }
    return withMutations(state, { tasks, interruptEffects });
  }
  assertTaskTransition(task.state, payload.state);
  if (payload.state === 'in_progress') {
    const blocker = taskBlocked(state, payload.taskId);
    if (blocker) {
      throw invalid(`task activation blocked: ${blocker}`, 'DECISION_GATE_BLOCKING');
    }
  }
  const tasks = {
    ...state.tasks,
    [payload.taskId]: Object.freeze({ ...task, state: payload.state }),
  };
  return withMutations(state, { tasks });
}

function applyGateCreated(state, payload) {
  requireId(payload.gateId, ID_PREFIXES.gate, 'gate id');
  const taskId = payload.taskId ?? payload.dependsOnTaskId;
  if (!taskId || !state.tasks[taskId]) {
    throw invalid('decision gate must reference a known task');
  }
  if (state.gates[payload.gateId]) {
    throw invalid('decision gate ids are single-use');
  }
  const gates = {
    ...state.gates,
    [payload.gateId]: Object.freeze({
      gateId: payload.gateId,
      taskId: payload.taskId ?? null,
      dependsOnTaskId: payload.dependsOnTaskId ?? null,
      state: 'open',
      resolution: null,
    }),
  };
  return withMutations(state, { gates });
}

function applyGateResolved(state, payload, nextState) {
  const gate = state.gates[payload.gateId];
  if (!gate) throw invalid('decision gate not found', 'DECISION_GATE_NOT_FOUND');
  assertDecisionGateTransition(gate.state, nextState);
  const gates = {
    ...state.gates,
    [payload.gateId]: Object.freeze({
      ...gate,
      state: nextState,
      ...(nextState === 'resolved' ? { resolution: boundedReceipt(payload.receipt) } : {}),
    }),
  };
  return withMutations(state, { gates });
}

function withMutations(state, mutations) {
  return deepFreeze({
    ...state,
    ...mutations,
    updatedAt: mutations.updatedAt ?? state.updatedAt,
  });
}

function requireId(value, prefix, label) {
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    throw invalid(`${label} must be a string with the ${prefix} prefix`);
  }
  return value;
}

export function acknowledgeThrough(state, sequence) {
  requireInteger(sequence, 'acknowledged sequence', { min: 0 });
  if (sequence <= state.acknowledgedThrough) {
    // Re-acking an older watermark is an idempotent no-op: acknowledgedThrough
    // simply remains at the high-water mark.
    return deepFreeze({ ...state, acknowledgedThrough: state.acknowledgedThrough });
  }
  if (sequence > state.lastSequence) {
    throw invalid('cannot acknowledge beyond the last journaled sequence');
  }
  return deepFreeze({ ...state, acknowledgedThrough: sequence });
}

function callbackRecordFor(state, bindingId) {
  const record = state.workerCallbacks?.[bindingId];
  if (!record) return { lastSeq: 0, recent: [] };
  return record;
}

/**
 * Pure pre-append classification of a worker callback's durable identity.
 * The commit path consults this BEFORE any journal write:
 * - valid-next  -> safe to append and advance the watermark atomically;
 * - duplicate   -> replay the prior committed acknowledgement verbatim;
 * - conflict    -> same identity, different content: fail closed;
 * - stale       -> below the retained window without a comparable digest;
 * - gap         -> out-of-order future event.
 */
export function classifyCallback(state, callbackRef) {
  if (!isPlainObject(callbackRef)) throw invalid('callbackRef must be an object');
  const bindingId = requireId(callbackRef.bindingId, ID_PREFIXES.worker, 'callbackRef.bindingId');
  const seq = requireInteger(callbackRef.seq ?? null, 'callbackRef.seq', { min: 1 });
  const digest = typeof callbackRef.digest === 'string' && callbackRef.digest.length > 0
    ? callbackRef.digest
    : null;
  if (!digest) throw invalid('callbackRef requires a content digest');
  const record = callbackRecordFor(state, bindingId);
  if (seq === record.lastSeq + 1) return { kind: 'valid-next', bindingId, seq };
  if (seq > record.lastSeq + 1) {
    throw invalid(
      `callback sequence gap for ${bindingId}: expected ${record.lastSeq + 1}, received ${seq}`,
      'ORCHESTRATION_EVENT_GAP',
    );
  }
  // seq <= lastSeq: a committed identity is being replayed.
  const retained = record.recent.find((entry) => entry.seq === seq);
  if (retained) {
    if (retained.digest === digest) {
      return { kind: 'duplicate', bindingId, seq, acknowledgedSequence: retained.atSequence };
    }
    throw invalid(`callback id reused with different content at ${bindingId}:${seq}`, 'WORKER_CALLBACK_UNAUTHORIZED');
  }
  throw invalid(`stale callback replay for ${bindingId} at ${seq}`, 'ORCHESTRATION_EVENT_GAP');
}

/** Advance the durable per-binding watermark inside the same transaction. */
function applyCallbackAdvance(next, callbackRef) {
  const classification = classifyCallback(next, callbackRef);
  if (classification.kind !== 'valid-next') {
    throw invalid('callback advance attempted for a non-valid-next classification', 'ORCHESTRATION_EVENT_GAP');
  }
  const record = callbackRecordFor(next, classification.bindingId);
  const recent = [
    ...record.recent,
    { seq: classification.seq, digest: callbackRef.digest, atSequence: next.lastSequence },
  ].slice(-1 * CALLBACK_DEDUPE_WINDOW);
  return withMutations(next, {
    workerCallbacks: {
      ...next.workerCallbacks,
      [classification.bindingId]: Object.freeze({ lastSeq: classification.seq, recent }),
    },
  });
}

export function applyDelivery(state, delivery) {
  if (!isPlainObject(delivery)) throw invalid('delivery must be an object');
  if (!DELIVERY_TYPES.includes(delivery.type)) {
    throw invalid(`unknown delivery type: ${String(delivery.type)}`);
  }
  if (
    delivery.coordinationId !== undefined
    && delivery.coordinationId !== state.coordinationId
  ) {
    throw invalid('delivery coordination id does not match this coordination');
  }
  const expected = state.lastSequence + 1;
  if (delivery.sequence !== undefined && delivery.sequence !== expected) {
    throw invalid(
      `delivery sequence gap: expected ${expected}, received ${String(delivery.sequence)}`,
      'ORCHESTRATION_EVENT_GAP',
    );
  }
  const sequence = expected;
  const payload = isPlainObject(delivery.payload) ? delivery.payload : {};
  const time = typeof delivery.time === 'string' ? delivery.time : state.updatedAt;
  const base = { ...state, lastSequence: sequence };

  let next;
  switch (delivery.type) {    case 'coordination_created':
    case 'heartbeat':
    case 'progress':
    case 'worker_started':
    case 'question':
    case 'reply':
    case 'escalation':
    case 'guidance':
    case 'permission_requested':
    case 'permission_resolved':
    case 'cleanup_recorded': {
      next = base;
      break;
    }
    case 'coordination_state_changed': {
      assertTransition(COORDINATION_TRANSITIONS, state.coordinationState, payload.state, 'coordination');
      next = withMutations(base, { coordinationState: payload.state });
      break;
    }
    case 'ownership_transferred': {
      const epoch = requireInteger(payload.fenceEpoch, 'transfer fenceEpoch', { min: 1 });
      if (epoch !== state.fenceEpoch + 1) {
        throw invalid('planned transfer must bump the fence epoch by exactly one');
      }
      next = withMutations(base, {
        fenceEpoch: epoch,
        owner: isPlainObject(payload.owner) ? deepFreeze({ ...payload.owner }) : null,
      });
      break;
    }
    case 'task_created': {
      requireId(payload.taskId, ID_PREFIXES.task, 'taskId');
      if (state.tasks[payload.taskId]) throw invalid('task ids are single-use');
      next = withMutations(base, {
        tasks: { ...state.tasks, [payload.taskId]: Object.freeze(nextTask(payload.taskId)) },
      });
      break;
    }
    case 'task_state_changed': {
      next = applyTaskStateChange(base, payload);
      break;
    }
    case 'dispatch_created': {
      requireId(payload.dispatchId, ID_PREFIXES.dispatch, 'dispatchId');
      const taskId = requireId(payload.taskId, ID_PREFIXES.task, 'taskId');
      if (!base.tasks[taskId]) throw invalid('dispatch references an unknown task', 'TASK_NOT_FOUND');
      if (base.dispatches[payload.dispatchId]) throw invalid('dispatch ids are single-use');
      next = withMutations(base, {
        dispatches: {
          ...base.dispatches,
          [payload.dispatchId]: Object.freeze(nextDispatch(payload.dispatchId, taskId)),
        },
      });
      break;
    }
    case 'dispatch_state_changed': {
      next = applyDispatchStateChange(base, payload);
      break;
    }
    case 'dispatch_reconciled': {
      const dispatch = base.dispatches[
        requireId(payload.dispatchId, ID_PREFIXES.dispatch, 'dispatchId')
      ];
      if (!dispatch) throw invalid('reconciliation references an unknown dispatch', 'DISPATCH_NOT_FOUND');
      const reconciledTaskId = requireId(payload.taskId, ID_PREFIXES.task, 'reconcile taskId');
      if (dispatch.taskId !== reconciledTaskId) {
        throw invalid('reconciliation task does not match its dispatch');
      }
      if (!['lost', 'reattached'].includes(payload.outcome)) {
        throw invalid('dispatch reconciliation outcome must be lost or reattached');
      }
      if (typeof payload.reason !== 'string' || payload.reason.length === 0) {
        throw invalid('dispatch reconciliation requires a typed reason');
      }
      if (payload.outcome === 'reattached') {
        // Control was reproven; the lifecycle continues truthfully unchanged.
        next = base;
        break;
      }
      assertDispatchTransition(dispatch.state, 'lost');
      next = withMutations(base, {
        dispatches: {
          ...base.dispatches,
          [payload.dispatchId]: Object.freeze({ ...dispatch, state: 'lost' }),
        },
      });
      break;
    }
    case 'worker_binding_recorded': {
      requireId(payload.bindingId, ID_PREFIXES.worker, 'bindingId');
      if (payload.guaranteeTier !== undefined && !GUARANTEE_TIERS.includes(payload.guaranteeTier)) {
        throw invalid('worker binding recorded an unknown guarantee tier');
      }
      next = withMutations(base, {
        workers: {
          ...base.workers,
          [payload.bindingId]: Object.freeze({ ...payload }),
        },
      });
      break;
    }
    case 'worker_done':
    case 'worker_failed':
    case 'worker_cancelled': {
      next = applyTerminalWorker(base, delivery, payload, sequence);
      break;
    }
    case 'test_verdict_recorded': {
      const dispatch = base.dispatches[payload.dispatchId];
      if (!dispatch) throw invalid('test verdict references an unknown dispatch', 'DISPATCH_NOT_FOUND');
      if (!TEST_VERDICTS.includes(payload.verdict)) {
        throw invalid(`test verdict must be one of ${TEST_VERDICTS.join(', ')}`);
      }
      const dispatches = {
        ...base.dispatches,
        [payload.dispatchId]: Object.freeze({
          ...dispatch,
          testVerdicts: [...dispatch.testVerdicts, { verdict: payload.verdict, atSequence: sequence }],
        }),
      };
      next = withMutations(base, { dispatches });
      break;
    }
    case 'decision_gate_created': {
      next = applyGateCreated(base, payload);
      break;
    }
    case 'decision_gate_resolved':
    case 'decision_gate_expired':
    case 'decision_gate_cancelled': {
      next = applyGateResolved(base, payload, delivery.type.slice('decision_gate_'.length));
      break;
    }
    case 'acceptance_recorded': {
      next = applyAcceptance(base, payload);
      break;
    }
    default:
      throw invalid(`unhandled delivery type: ${delivery.type}`);
  }

  // Worker callback identity advances the durable watermark in the SAME
  // transaction that appends the event, so retries and restarts observe one
  // committed acknowledgement per (bindingId, seq).
  if (delivery.callbackRef !== undefined) {
    next = applyCallbackAdvance(next ?? base, delivery.callbackRef);
  }
  return deepFreeze({ ...next, updatedAt: time });
}
