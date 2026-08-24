import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DELIVERY_TYPES,
  GUARANTEE_TIERS,
  OPERATIONS,
  ORCHESTRATION_ERROR_CODES,
  ORCHESTRATION_LIMITS,
  ORCHESTRATION_MODES,
  ORCHESTRATION_PROTOCOL,
  modeRequiresTierSatisfied,
  validateCallRequest,
  validateCreateRequest,
  validateTaskPacket,
  validateWorkerCallback,
} from '../src/orchestration/contracts.mjs';

test('v0 request contract rejects unknown fields and oversized waits', () => {
  assert.equal(ORCHESTRATION_PROTOCOL, 'webmcp.ai-orchestration/v0');
  assert.equal(ORCHESTRATION_LIMITS.maxWaitMs, 60_000);
  assert.throws(
    () => validateCallRequest({
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: 'req_test',
      operation: 'delivery.wait',
      input: { afterSequence: 0, timeoutMs: 60_001 },
      capability: 'caller-must-not-supply-this',
    }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});

test('v0 freezes public operations and Delivery names', () => {
  assert.deepEqual(OPERATIONS, [
    'coordination.inspect', 'coordination.transfer', 'coordination.close',
    'task.create', 'task.cancel', 'dispatch.start', 'dispatch.reply',
    'dispatch.guidance', 'dispatch.permission.resolve',
    'dispatch.interrupt', 'dispatch.verify', 'decision-gate.create',
    'decision-gate.resolve', 'delivery.wait', 'delivery.ack',
  ]);
  assert.equal(DELIVERY_TYPES.includes('acceptance_recorded'), true);
  assert.equal(DELIVERY_TYPES.includes('provider.turn.completed'), false);
});

test('numeric limits match the locked alpha contract exactly', () => {
  assert.deepEqual(ORCHESTRATION_LIMITS, {
    maxRequestBytes: 1024 * 1024,
    maxDeliveryBytes: 512 * 1024,
    maxInlinePayloadBytes: 256 * 1024,
    maxBatchDeliveries: 256,
    maxWaitMs: 60_000,
    maxRefBytes: 32 * 1024 * 1024,
    maxRefsTotalBytes: 64 * 1024 * 1024,
    journalBackpressureBytes: 480 * 1024 * 1024,
    journalHardLimitBytes: 512 * 1024 * 1024,
    defaultConcurrentDispatches: 4,
    maxConcurrentDispatches: 16,
    defaultDelegationDepth: 1,
    maxDelegationDepth: 4,
    maxAcceptanceCommands: 16,
    maxAcceptanceCommandMs: 1_800_000,
  });
});

test('delivery registry is the closed v0 set with terminal worker types', () => {
  assert.deepEqual([...DELIVERY_TYPES], [
    'coordination_created',
    'coordination_state_changed',
    'task_created',
    'task_state_changed',
    'dispatch_created',
    'dispatch_state_changed',
    'dispatch_reconciled',
    'worker_binding_recorded',
    'worker_started',
    'heartbeat',
    'progress',
    'question',
    'reply',
    'escalation',
    'guidance',
    'permission_requested',
    'permission_resolved',
    'worker_done',
    'worker_failed',
    'worker_cancelled',
    'decision_gate_created',
    'decision_gate_resolved',
    'decision_gate_expired',
    'decision_gate_cancelled',
    'test_verdict_recorded',
    'acceptance_recorded',
    'ownership_transferred',
    'cleanup_recorded',
  ]);
});

test('error codes expose the stable alpha taxonomy', () => {
  for (const code of [
    'ORCHESTRATION_DISABLED',
    'ORCHESTRATION_INVALID_INPUT',
    'ORCHESTRATION_UNSUPPORTED_VERSION',
    'COORDINATION_NOT_FOUND',
    'COORDINATION_CLOSED',
    'COORDINATION_LOCKED',
    'TASK_NOT_FOUND',
    'DISPATCH_NOT_FOUND',
    'DECISION_GATE_NOT_FOUND',
    'DECISION_GATE_BLOCKING',
    'STALE_COORDINATOR_EPOCH',
    'WORKER_IDENTITY_UNPROVEN',
    'WORKER_CALLBACK_UNAUTHORIZED',
    'ORCHESTRATION_CURSOR_EXPIRED',
    'ORCHESTRATION_EVENT_GAP',
    'WORKER_PROCESS_LOST',
    'PERMISSION_REQUIRED',
    'POLICY_DENIED',
    'PROVIDER_PROTOCOL_ERROR',
    'ORCHESTRATION_INDETERMINATE',
    'JOURNAL_BACKPRESSURE',
    'JOURNAL_LIMIT_REACHED',
    'JOURNAL_CORRUPT',
    'SNAPSHOT_CORRUPT',
    'UNSUPPORTED_CAPABILITY',
  ]) {
    assert.equal(ORCHESTRATION_ERROR_CODES.has(code), true, `missing code ${code}`);
  }
});

test('validateCreateRequest rejects arrays, unknown fields, bad ids and unsupported majors', () => {
  assert.throws(() => validateCreateRequest([]), (error) => error.code === 'ORCHESTRATION_INVALID_INPUT');
  assert.throws(
    () => validateCreateRequest({ protocol: ORCHESTRATION_PROTOCOL, requestId: 'req_ok', extra: true }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => validateCreateRequest({ protocol: ORCHESTRATION_PROTOCOL, requestId: 'nope' }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => validateCreateRequest({ protocol: 'webmcp.ai-orchestration/v1', requestId: 'req_ok' }),
    (error) => error.code === 'ORCHESTRATION_UNSUPPORTED_VERSION',
  );
  const normalized = validateCreateRequest({ protocol: `${ORCHESTRATION_PROTOCOL}`, requestId: 'req_ok' });
  assert.deepEqual(normalized, { protocol: ORCHESTRATION_PROTOCOL, requestId: 'req_ok' });
  assert.equal(Object.isFrozen(normalized), true);
});

test('validateCallRequest normalizes bounded input without mutating the caller object', () => {
  const caller = {
    protocol: ORCHESTRATION_PROTOCOL,
    requestId: 'req_call',
    operation: 'delivery.wait',
    input: { afterSequence: 41, timeoutMs: 30_000 },
  };
  const normalized = validateCallRequest(caller);
  assert.deepEqual(normalized, {
    protocol: ORCHESTRATION_PROTOCOL,
    requestId: 'req_call',
    operation: 'delivery.wait',
    input: { afterSequence: 41, timeoutMs: 30_000 },
  });
  assert.equal(Object.isFrozen(normalized), true);
  assert.deepEqual(caller.input, { afterSequence: 41, timeoutMs: 30_000 });

  assert.throws(
    () => validateCallRequest({
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: 'req_call',
      operation: 'not.an.operation',
      input: {},
    }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => validateCallRequest({
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: 'req_call',
      operation: 'delivery.ack',
      input: { throughSequence: 1.5 },
    }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => validateCallRequest({
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: ['array'],
      operation: 'coordination.inspect',
      input: {},
    }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});

const baseTask = {
  objective: 'Implement one bounded change',
  workspace: '/tmp/workspace',
  allowedWriteRoots: ['/tmp/workspace/src'],
  protectedPaths: ['/tmp/workspace/package.json'],
  acceptanceCommands: [['node', '--test', 'tests/x.test.mjs']],
};

test('validateTaskPacket rejects non-absolute roots, overlaps, executable strings and bad ids', () => {
  assert.throws(() => validateTaskPacket([]), (error) => error.code === 'ORCHESTRATION_INVALID_INPUT');
  assert.throws(
    () => validateTaskPacket({ ...baseTask, workspace: 'relative/path' }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => validateTaskPacket({ ...baseTask, protectedPaths: ['/tmp/workspace/src/secret.txt'] }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => validateTaskPacket({ ...baseTask, dependencies: ['disp_bad'] }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => validateTaskPacket({ ...baseTask, command: 'rm -rf /' }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => validateTaskPacket({ ...baseTask, acceptanceCommands: ['npm test'] }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => validateTaskPacket({
      ...baseTask,
      acceptanceCommands: Array.from({ length: 17 }, () => ['node', '--version']),
    }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => validateTaskPacket({ ...baseTask, delegationDepth: 9 }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  const normalized = validateTaskPacket(baseTask);
  assert.equal(normalized.workspace, '/tmp/workspace');
  assert.equal(normalized.delegationDepth, ORCHESTRATION_LIMITS.defaultDelegationDepth);
  assert.equal(Object.isFrozen(normalized.allowedWriteRoots), true);
  assert.equal(Object.isFrozen(normalized), true);
});

test('worker callbacks reject coordinator operations and unknown envelope fields', () => {
  const valid = {
    schema: 'webmcp.ai-worker-callback/v0',
    callbackId: 'cbk_one',
    coordinationId: 'coord_one',
    taskId: 'task_one',
    dispatchId: 'disp_one',
    bindingId: 'worker_one',
    fenceEpoch: 1,
    operation: 'worker.heartbeat',
    callbackSeq: 1,
    input: {},
  };
  assert.deepEqual(validateWorkerCallback(valid).operation, 'worker.heartbeat');
  assert.throws(
    () => validateWorkerCallback({ ...valid, callbackSeq: undefined }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
    'callbacks require a monotonic per-binding callbackSeq',
  );
  assert.throws(
    () => validateWorkerCallback({ ...valid, callbackSeq: 0 }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  assert.throws(
    () => validateWorkerCallback({ ...valid, operation: 'task.create' }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => validateWorkerCallback({ ...valid, capability: 'token' }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => validateWorkerCallback({ ...valid, schema: 'webmcp.ai-orchestration/v0' }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => validateWorkerCallback({ ...valid, fenceEpoch: -1 }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});

test('modes and guarantee tiers are closed sets with seam requirements', () => {
  assert.deepEqual(ORCHESTRATION_MODES, [
    'full-handoff',
    'delegated-result-return',
    'supervised-orchestration',
  ]);
  assert.deepEqual(GUARANTEE_TIERS, [
    'native-controlled',
    'owned-process',
    'attached-observer',
    'unsupported',
  ]);

  assert.equal(modeRequiresTierSatisfied('supervised-orchestration', 'owned-process'), true);
  assert.equal(modeRequiresTierSatisfied('supervised-orchestration', 'native-controlled'), true);
  assert.equal(modeRequiresTierSatisfied('supervised-orchestration', 'attached-observer'), false);
  assert.equal(modeRequiresTierSatisfied('supervised-orchestration', 'unsupported'), false);
  assert.equal(modeRequiresTierSatisfied('delegated-result-return', 'attached-observer'), true);
  assert.equal(modeRequiresTierSatisfied('delegated-result-return', 'unsupported'), false);
  assert.equal(modeRequiresTierSatisfied('full-handoff', 'native-controlled'), true);
  assert.equal(modeRequiresTierSatisfied('full-handoff', 'owned-process'), false);
  assert.equal(modeRequiresTierSatisfied('full-handoff', 'unsupported'), false);
});
