import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DECISION_GATE_TRANSITIONS,
  DELIVERY_TYPES,
  DISPATCH_TRANSITIONS,
  TASK_TRANSITIONS,
  acknowledgeThrough,
  applyDelivery,
  assertDecisionGateTransition,
  assertDispatchTransition,
  assertTaskTransition,
  createInitialState,
} from '../src/orchestration/state-machine.mjs';

function manifest(overrides = {}) {
  return {
    coordinationId: 'coord_test',
    fenceEpoch: 1,
    processGeneration: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
}

function delivery(type, payload = {}, overrides = {}) {
  return {
    schema: 'webmcp.ai-orchestration-delivery/v0',
    type,
    time: '2026-08-22T00:00:01.000Z',
    payload,
    ...overrides,
  };
}

function taskReady(state, taskId = 'task_test') {
  return applyDelivery(state, delivery('task_created', { taskId }));
}

test('activity and worker completion cannot accept a task', () => {
  const state = createInitialState(manifest());
  const withTask = taskReady(state);
  const active = applyDelivery(withTask, delivery('dispatch_state_changed', {
    taskId: 'task_test', dispatchId: 'disp_test', state: 'active',
  }));
  const done = applyDelivery(active, delivery('worker_done', {
    taskId: 'task_test', dispatchId: 'disp_test', outcome: 'completed',
  }));

  assert.equal(done.tasks.task_test.state, 'awaiting_acceptance');
  assert.equal(done.tasks.task_test.acceptance, 'pending');
});

test('transition maps freeze the exact independent axes', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(TASK_TRANSITIONS).map(([k, v]) => [k, [...v]])),
    {
      created: ['ready', 'blocked', 'cancelled'],
      ready: ['in_progress', 'blocked', 'cancelled'],
      in_progress: ['awaiting_acceptance', 'blocked', 'cancelled'],
      awaiting_acceptance: ['accepted', 'rejected', 'ready'],
      blocked: ['ready', 'cancelled'],
      rejected: ['ready', 'cancelled'],
      accepted: [],
      cancelled: [],
    },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(DISPATCH_TRANSITIONS).map(([k, v]) => [k, [...v]])),
    {
      created: ['assigned', 'active', 'cancelled', 'failed'],
      assigned: ['active', 'cancelled', 'failed'],
      active: ['waiting', 'settling', 'cancelled', 'failed', 'lost'],
      waiting: ['active', 'settling', 'cancelled', 'failed'],
      settling: ['settled', 'failed'],
      settled: [],
      failed: [],
      cancelled: [],
      lost: [],
    },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(DECISION_GATE_TRANSITIONS).map(([k, v]) => [k, [...v]])),
    {
      open: ['resolved', 'expired', 'cancelled'],
      resolved: [],
      expired: [],
      cancelled: [],
    },
  );
});

test('illegal lifecycle edges are rejected by the assertion helpers', () => {
  assert.throws(() => assertTaskTransition('accepted', 'in_progress'));
  assert.throws(() => assertDispatchTransition('settled', 'active'));
  assert.throws(() => assertDecisionGateTransition('resolved', 'open'));
  // awaiting_acceptance -> accepted is a legal edge; only the
  // acceptance_recorded delivery type may drive it through the reducer.
  assert.equal(assertTaskTransition('awaiting_acceptance', 'accepted'), undefined);
});

test('coordination close is one-way and reopen is rejected', () => {
  let state = createInitialState(manifest());
  state = applyDelivery(state, delivery('coordination_state_changed', { state: 'closing' }));
  assert.equal(state.coordinationState, 'closing');
  state = applyDelivery(state, delivery('coordination_state_changed', { state: 'closed' }));
  assert.equal(state.coordinationState, 'closed');
  assert.throws(
    () => applyDelivery(state, delivery('coordination_state_changed', { state: 'open' })),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});

test('a green test verdict can never accept a task without acceptance_recorded', () => {
  let state = createInitialState(manifest());
  state = taskReady(state);
  state = applyDelivery(state, delivery('dispatch_state_changed', {
    taskId: 'task_test', dispatchId: 'disp_test', state: 'active',
  }));
  state = applyDelivery(state, delivery('worker_done', {
    taskId: 'task_test', dispatchId: 'disp_test', outcome: 'completed',
  }));
  const verified = applyDelivery(state, delivery('test_verdict_recorded', {
    taskId: 'task_test', dispatchId: 'disp_test', verdict: 'GREEN',
  }));

  assert.equal(verified.tasks.task_test.acceptance, 'pending');
  assert.equal(verified.tasks.task_test.state, 'awaiting_acceptance');
  assert.deepEqual(verified.dispatches.disp_test.testVerdicts.map((v) => v.verdict), ['GREEN']);
});

test('a task with an unresolved dependency or open gate cannot enter in_progress', () => {
  let state = createInitialState(manifest());
  state = taskReady(state, 'task_dep');
  state = taskReady(state, 'task_main');
  state = applyDelivery(state, delivery('task_state_changed', {
    taskId: 'task_main', state: 'ready',
  }));
  // Declare main dependent on dep through a blocking gate instead of raw deps.
  state = applyDelivery(state, delivery('decision_gate_created', {
    gateId: 'gate_main', taskId: 'task_main',
  }));

  assert.throws(
    () => applyDelivery(state, delivery('dispatch_state_changed', {
      taskId: 'task_main', dispatchId: 'disp_main', state: 'active',
    })),
    (error) => error.code === 'DECISION_GATE_BLOCKING',
  );

  // Resolving the gate unblocks activation.
  const resolved = applyDelivery(state, delivery('decision_gate_resolved', {
    gateId: 'gate_main', receipt: { decidedBy: 'coordinator', note: 'approved' },
  }));
  const active = applyDelivery(resolved, delivery('dispatch_state_changed', {
    taskId: 'task_main', dispatchId: 'disp_main', state: 'active',
  }));
  assert.equal(active.tasks.task_main.state, 'in_progress');
});

test('worker_done settles only its matching active dispatch and awaits acceptance', () => {
  let state = createInitialState(manifest());
  state = taskReady(state);
  state = applyDelivery(state, delivery('dispatch_state_changed', {
    taskId: 'task_test', dispatchId: 'disp_a', state: 'active',
  }));
  state = applyDelivery(state, delivery('worker_done', {
    taskId: 'task_test', dispatchId: 'disp_a', outcome: 'completed',
  }));

  assert.equal(state.dispatches.disp_a.state, 'settling');
  assert.equal(state.dispatches.disp_a.terminalOutcome, 'completed');

  assert.throws(
    () => applyDelivery(state, delivery('worker_done', {
      taskId: 'task_test', dispatchId: 'disp_missing', outcome: 'completed',
    })),
    (error) => error.code === 'DISPATCH_NOT_FOUND',
  );
});

test('duplicate identical terminals are idempotent; conflicting terminals escalate', () => {
  let state = createInitialState(manifest());
  state = taskReady(state);
  state = applyDelivery(state, delivery('dispatch_state_changed', {
    taskId: 'task_test', dispatchId: 'disp_a', state: 'active',
  }));
  const first = applyDelivery(state, delivery('worker_done', {
    taskId: 'task_test', dispatchId: 'disp_a', outcome: 'completed',
  }));
  const duplicate = applyDelivery(first, delivery('worker_done', {
    taskId: 'task_test', dispatchId: 'disp_a', outcome: 'completed',
  }, { deliveryId: 'del_dup', time: '2026-08-22T00:00:02.000Z' }));

  assert.equal(duplicate.dispatches.disp_a.terminalOutcome, 'completed');
  assert.equal(duplicate.tasks.task_test.state, 'awaiting_acceptance');
  assert.equal(duplicate.escalations.length, first.escalations.length);

  const conflict = applyDelivery(duplicate, delivery('worker_failed', {
    taskId: 'task_test', dispatchId: 'disp_a', outcome: 'failed',
  }, { time: '2026-08-22T00:00:03.000Z' }));

  assert.equal(conflict.dispatches.disp_a.terminalOutcome, 'completed');
  assert.equal(conflict.tasks.task_test.acceptance, 'pending');
  assert.equal(conflict.escalations.length, duplicate.escalations.length + 1);
  assert.match(conflict.escalations.at(-1).reason, /conflicting/i);
});

test('acceptance_recorded is the only event that reaches accepted or rejected', () => {
  let state = createInitialState(manifest());
  state = taskReady(state);
  state = applyDelivery(state, delivery('dispatch_state_changed', {
    taskId: 'task_test', dispatchId: 'disp_a', state: 'active',
  }));
  state = applyDelivery(state, delivery('worker_done', {
    taskId: 'task_test', dispatchId: 'disp_a', outcome: 'completed',
  }));
  assert.throws(
    () => applyDelivery(state, delivery('task_state_changed', { taskId: 'task_test', state: 'accepted' })),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  const accepted = applyDelivery(state, delivery('acceptance_recorded', {
    taskId: 'task_test', acceptance: 'accepted',
  }));
  assert.equal(accepted.tasks.task_test.state, 'accepted');
  assert.equal(accepted.tasks.task_test.acceptance, 'accepted');
  assert.throws(
    () => applyDelivery(accepted, delivery('task_state_changed', { taskId: 'task_test', state: 'in_progress' })),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});

test('decision gates validate identities, resolve once, and never reopen', () => {
  let state = createInitialState(manifest());
  state = taskReady(state);
  assert.throws(
    () => applyDelivery(state, delivery('decision_gate_created', {
      gateId: 'gate_bad', taskId: 'task_missing',
    })),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  state = applyDelivery(state, delivery('decision_gate_created', {
    gateId: 'gate_one', taskId: 'task_test',
  }));
  state = applyDelivery(state, delivery('decision_gate_resolved', {
    gateId: 'gate_one', receipt: { decidedBy: 'coordinator' },
  }));
  assert.equal(state.gates.gate_one.state, 'resolved');

  assert.throws(
    () => applyDelivery(state, delivery('decision_gate_resolved', {
      gateId: 'gate_one', receipt: { decidedBy: 'conflicting' },
    })),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => applyDelivery(state, delivery('decision_gate_created', {
      gateId: 'gate_one', taskId: 'task_test',
    })),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.equal(state.gates.gate_one.resolution.decidedBy, 'coordinator');
});

test('task.cancel is idempotent and interrupts only that task live owned dispatches', () => {
  let state = createInitialState(manifest());
  state = taskReady(state, 'task_a');
  state = taskReady(state, 'task_b');
  state = applyDelivery(state, delivery('dispatch_state_changed', {
    taskId: 'task_a', dispatchId: 'disp_a', state: 'active',
  }));
  state = applyDelivery(state, delivery('dispatch_state_changed', {
    taskId: 'task_b', dispatchId: 'disp_b', state: 'active',
  }));

  const cancelledOnce = applyDelivery(state, delivery('task_state_changed', {
    taskId: 'task_a', state: 'cancelled', reason: 'obsolete', actor: 'req_c1',
  }));
  assert.equal(cancelledOnce.tasks.task_a.state, 'cancelled');
  assert.equal(cancelledOnce.dispatches.disp_b.state, 'active', 'unrelated worker untouched');

  const effects = cancelledOnce.interruptEffects.filter((effect) => effect.dispatchId === 'disp_a');
  assert.equal(effects.length, 1);
  assert.equal(effects[0].dispatchId, 'disp_a');

  const cancelledTwice = applyDelivery(cancelledOnce, delivery('task_state_changed', {
    taskId: 'task_a', state: 'cancelled', reason: 'obsolete', actor: 'req_c2',
  }));
  assert.equal(
    cancelledTwice.interruptEffects.filter((effect) => effect.dispatchId === 'disp_a').length,
    1,
    'cancel is idempotent',
  );
});

test('sequences advance monotonically and gaps are typed errors', () => {
  let state = createInitialState(manifest());
  state = taskReady(state);
  assert.equal(state.lastSequence, 1);
  assert.throws(
    () => applyDelivery(state, delivery('heartbeat', {}, { sequence: 3 })),
    (error) => error.code === 'ORCHESTRATION_EVENT_GAP',
  );
  const replayed = applyDelivery(state, delivery('heartbeat', {}, { sequence: 2 }));
  assert.equal(replayed.lastSequence, 2);
});

test('acknowledgeThrough is monotonic and bounded by the journal end', () => {
  let state = createInitialState(manifest());
  state = taskReady(state);
  state = applyDelivery(state, delivery('heartbeat', {}));
  const acked = acknowledgeThrough(state, 2);
  assert.equal(acked.acknowledgedThrough, 2);
  assert.equal(acknowledgeThrough(acked, 2).acknowledgedThrough, 2);

  // A stale re-ack is an idempotent no-op, not an error.
  assert.equal(acknowledgeThrough(acked, 1).acknowledgedThrough, 2);
  assert.throws(() => acknowledgeThrough(acked, 3), (error) => error.code === 'ORCHESTRATION_INVALID_INPUT');
  assert.throws(() => acknowledgeThrough(acked, 2.5), (error) => error.code === 'ORCHESTRATION_INVALID_INPUT');
});

test('unknown delivery types and mismatched coordination ids are rejected', () => {
  const state = createInitialState(manifest());
  assert.throws(
    () => applyDelivery(state, delivery('provider.turn.completed', {})),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT'
      && DELIVERY_TYPES.includes('provider.turn.completed') === false,
  );
  assert.throws(
    () => applyDelivery(state, delivery('heartbeat', {}, { coordinationId: 'coord_other' })),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});

test('planned ownership transfer bumps the epoch by exactly one', () => {
  let state = createInitialState(manifest());
  state = applyDelivery(state, delivery('ownership_transferred', {
    fenceEpoch: 2,
    owner: { host: 'claude', instanceId: 'host-b' },
  }));
  assert.equal(state.fenceEpoch, 2);
  assert.deepEqual(state.owner, { host: 'claude', instanceId: 'host-b' });

  assert.throws(
    () => applyDelivery(state, delivery('ownership_transferred', {
      fenceEpoch: 9, owner: { host: 'claude', instanceId: 'host-c' },
    })),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});
