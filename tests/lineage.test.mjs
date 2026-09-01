import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LINEAGE_INDEX_FILENAME,
  LINEAGE_INDEX_SCHEMA,
  LINEAGE_RECORD_SCHEMA,
  buildLineageIndex,
  buildLineageRecordFromReceipt,
  checkLineageIndependence,
  computeContributorDigest,
  mergeLineageRecords,
  reconcileLineageFromReceipts,
  validateLineageIndex,
  validateLineageRecord,
} from '../src/orchestration/lineage.mjs';
import {
  buildSelectionReceipt,
  validateSelectionReceipt,
} from '../src/orchestration/selection-receipt.mjs';
import {
  DEFAULT_ROLE_POLICY,
  computePolicyDigest,
} from '../src/orchestration/role-policy.mjs';

function makeReceipt(overrides = {}) {
  return buildSelectionReceipt({
    taskId: 'task_test_01',
    dispatchId: 'disp_test_01',
    role: 'writer',
    riskTier: 'medium',
    rolePolicyRevision: computePolicyDigest(DEFAULT_ROLE_POLICY),
    modelBindingRevision: 1,
    bindingRevision: 1,
    provider: 'anthropic',
    agent: 'writer-agent',
    requestedModel: 'claude-3-7-sonnet',
    actualModel: 'claude-3-7-sonnet',
    effort: 'high',
    variant: 'thinking',
    sessionFreshness: 'not-required',
    decision: 'eligible',
    evaluatedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  });
}

test('lineage: constants are defined and locked', () => {
  assert.equal(typeof LINEAGE_INDEX_SCHEMA, 'string');
  assert.equal(typeof LINEAGE_RECORD_SCHEMA, 'string');
  assert.equal(LINEAGE_INDEX_FILENAME, 'lineage-index.json');
});

test('lineage: computeContributorDigest is deterministic and lowercase sha256', () => {
  const digest1 = computeContributorDigest({
    role: 'writer',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    agent: 'writer-agent',
    bindingId: 'bind_writer_01',
  });
  const digest2 = computeContributorDigest({
    model: 'claude-3-7-sonnet',
    agent: 'writer-agent',
    bindingId: 'bind_writer_01',
    role: 'writer',
    provider: 'anthropic',
  });
  assert.equal(digest1, digest2);
  assert.match(digest1, /^sha256:[0-9a-f]{64}$/);
});

test('lineage: buildLineageRecordFromReceipt creates valid record from selection receipt', () => {
  const receipt = makeReceipt();
  const record = buildLineageRecordFromReceipt(receipt, { bindingId: 'bind_writer_01' });

  assert.equal(record.schema, LINEAGE_RECORD_SCHEMA);
  assert.equal(record.dispatchId, 'disp_test_01');
  assert.equal(record.taskId, 'task_test_01');
  assert.equal(record.role, 'writer');
  assert.equal(record.provider, 'anthropic');
  assert.equal(record.model, 'claude-3-7-sonnet');
  assert.equal(record.agent, 'writer-agent');
  assert.equal(record.bindingId, 'bind_writer_01');
  assert.equal(record.receiptDigest, receipt.receiptDigest);
  assert.match(record.contributorDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(record), true);

  const validated = validateLineageRecord(record);
  assert.deepEqual(validated, record);
});

test('lineage: validateLineageRecord rejects forbidden secret, path, prompt template and machine identity', () => {
  const receipt = makeReceipt();
  const validRecord = buildLineageRecordFromReceipt(receipt);

  assert.throws(
    () => validateLineageRecord({ ...validRecord, prompt: '{{template}}' }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  assert.throws(
    () => validateLineageRecord({ ...validRecord, extraPath: '/etc/passwd' }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  assert.throws(
    () => validateLineageRecord({ ...validRecord, secret: 'bearer secret-token-auth' }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  assert.throws(
    () => validateLineageRecord({ ...validRecord, sessionId: 'raw-provider-session' }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});

test('lineage: buildLineageIndex and validateLineageIndex manage durable index', () => {
  const r1 = makeReceipt({ dispatchId: 'disp_01', taskId: 'task_01', role: 'writer' });
  const r2 = makeReceipt({ dispatchId: 'disp_02', taskId: 'task_02', role: 'coordinator' });

  const rec1 = buildLineageRecordFromReceipt(r1);
  const rec2 = buildLineageRecordFromReceipt(r2);

  const index = buildLineageIndex([rec1, rec2]);
  assert.equal(index.schema, LINEAGE_INDEX_SCHEMA);
  assert.equal(index.records.length, 2);
  assert.equal(Object.isFrozen(index), true);

  const validated = validateLineageIndex(index);
  assert.deepEqual(validated, index);
});

test('lineage: mergeLineageRecords merges disjoint records and fails closed on conflicting duplicates', () => {
  const r1 = makeReceipt({ dispatchId: 'disp_01', taskId: 'task_01', role: 'writer' });
  const r2 = makeReceipt({ dispatchId: 'disp_02', taskId: 'task_02', role: 'coordinator' });

  const rec1 = buildLineageRecordFromReceipt(r1);
  const rec2 = buildLineageRecordFromReceipt(r2);

  const merged = mergeLineageRecords([rec1], [rec2]);
  assert.equal(merged.length, 2);

  // Identical duplicate is idempotent
  const dupMerged = mergeLineageRecords([rec1], [rec1]);
  assert.equal(dupMerged.length, 1);

  // Conflicting duplicate fails closed
  const conflictingR1 = makeReceipt({ dispatchId: 'disp_01', taskId: 'task_01', role: 'coordinator' });
  const conflictingRec1 = buildLineageRecordFromReceipt(conflictingR1);
  assert.throws(
    () => mergeLineageRecords([rec1], [conflictingRec1]),
    (err) => err.code === 'ORCHESTRATION_INDETERMINATE',
  );
});

test('lineage: reconcileLineageFromReceipts derives index from validated receipts', () => {
  const r1 = makeReceipt({ dispatchId: 'disp_01', taskId: 'task_01', role: 'writer' });
  const r2 = makeReceipt({ dispatchId: 'disp_02', taskId: 'task_02', role: 'coordinator' });

  const index = reconcileLineageFromReceipts([r1, r2]);
  assert.equal(index.records.length, 2);
  assert.equal(index.records[0].dispatchId, 'disp_01');
  assert.equal(index.records[1].dispatchId, 'disp_02');
});

test('lineage: checkLineageIndependence enforces final-auditor independence against trusted records', () => {
  const writerReceipt = makeReceipt({
    dispatchId: 'disp_writer_01',
    taskId: 'task_01',
    role: 'writer',
    provider: 'anthropic',
    actualModel: 'claude-3-7-sonnet',
    agent: 'writer-agent',
  });
  const writerRecord = buildLineageRecordFromReceipt(writerReceipt, { bindingId: 'bind_writer_01' });

  // 1. Independent auditor: different provider, model, agent, bindingId, fresh session
  const independentAuditor = {
    dispatchId: 'disp_auditor_01',
    taskId: 'task_audit_01',
    role: 'final-auditor',
    assurance: 'release-final',
    provider: 'google-ai',
    model: 'gemini-2.5-pro',
    agent: 'auditor-agent',
    bindingId: 'bind_auditor_01',
    sessionFreshness: 'fresh',
    readOnly: true,
    writeRoots: [],
  };

  const indepCheck = checkLineageIndependence({
    candidate: independentAuditor,
    trustedRecords: [writerRecord],
    taskPolicy: {
      readOnly: true,
      freshSession: true,
      mustNotMatchDispatchIds: ['disp_writer_01'],
    },
  });
  assert.equal(indepCheck.independent, true);
  assert.equal(indepCheck.violations.length, 0);

  // 2. Non-independent auditor: same model & provider as prior writer
  const nonIndepAuditor = {
    ...independentAuditor,
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
  };
  const nonIndepCheck = checkLineageIndependence({
    candidate: nonIndepAuditor,
    trustedRecords: [writerRecord],
    taskPolicy: {
      readOnly: true,
      freshSession: true,
    },
  });
  assert.equal(nonIndepCheck.independent, false);
  assert.ok(nonIndepCheck.violations.some((v) => v.code === 'AI_AUDITOR_NOT_INDEPENDENT'));

  // 3. Candidate matches mustNotMatchDispatchIds
  const matchDispatchAuditor = {
    ...independentAuditor,
    dispatchId: 'disp_writer_01',
  };
  const matchDispatchCheck = checkLineageIndependence({
    candidate: matchDispatchAuditor,
    trustedRecords: [writerRecord],
    taskPolicy: {
      readOnly: true,
      freshSession: true,
      mustNotMatchDispatchIds: ['disp_writer_01'],
    },
  });
  assert.equal(matchDispatchCheck.independent, false);
  assert.ok(matchDispatchCheck.violations.some((v) => v.code === 'AI_AUDITOR_NOT_INDEPENDENT'));

  // 4. Auditor missing fresh session
  const staleAuditor = {
    ...independentAuditor,
    sessionFreshness: 'reused',
  };
  const staleCheck = checkLineageIndependence({
    candidate: staleAuditor,
    trustedRecords: [writerRecord],
    taskPolicy: {
      readOnly: true,
      freshSession: false,
    },
  });
  assert.equal(staleCheck.independent, false);
  assert.ok(staleCheck.violations.some((v) => v.code === 'AI_AUDITOR_NOT_INDEPENDENT'));

  // 5. Empty trusted lineage fails closed for final-auditor
  const emptyCheck = checkLineageIndependence({
    candidate: independentAuditor,
    trustedRecords: [],
    taskPolicy: {
      readOnly: true,
      freshSession: true,
    },
  });
  assert.equal(emptyCheck.independent, false);
  assert.ok(emptyCheck.violations.some((v) => v.code === 'AI_AUDITOR_NOT_INDEPENDENT'));
});
