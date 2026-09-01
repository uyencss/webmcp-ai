import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  SELECTION_RECEIPT_SCHEMA,
  CLOSED_RISK_TIERS,
} from '../src/orchestration/constants.mjs';
import {
  buildSelectionReceipt,
  computeSelectionReceiptDigest,
  validateSelectionReceipt,
} from '../src/orchestration/selection-receipt.mjs';

function makeValidReceipt(overrides = {}) {
  const base = {
    schema: SELECTION_RECEIPT_SCHEMA,
    taskId: 'task_valid_01',
    dispatchId: 'disp_valid_01',
    role: 'writer',
    riskTier: 'low',
    rolePolicyRevision: 1,
    modelBindingRevision: 1,
    bindingRevision: 1,
    provider: 'anthropic',
    agent: 'writer-agent',
    requestedModel: 'claude-3-7-sonnet',
    actualModel: 'claude-3-7-sonnet',
    effort: 'high',
    variant: 'thinking',
    fallbackFrom: null,
    fallbackDecision: 'none',
    contributorLineageDigest: null,
    sessionFreshness: 'fresh',
    decision: 'eligible',
    evaluatedAt: new Date(1700000000000).toISOString(),
    ...overrides,
  };
  return base;
}

test('buildSelectionReceipt generates valid receipt with exact 21 fields and digest', () => {
  const receipt = buildSelectionReceipt(makeValidReceipt());
  assert.equal(receipt.schema, SELECTION_RECEIPT_SCHEMA);
  assert.equal(receipt.taskId, 'task_valid_01');
  assert.equal(receipt.dispatchId, 'disp_valid_01');
  assert.equal(receipt.role, 'writer');
  assert.equal(receipt.riskTier, 'low');
  assert.equal(receipt.decision, 'eligible');
  assert.match(receipt.receiptDigest, /^sha256:[0-9a-f]{64}$/);

  const keys = Object.keys(receipt);
  assert.equal(keys.length, 21);
  assert.ok(Object.isFrozen(receipt));

  const validated = validateSelectionReceipt(receipt);
  assert.equal(validated.receiptDigest, receipt.receiptDigest);
});
test('denied receipt has decision="denied", actualModel="indeterminate", and null provider', () => {
  const deniedInput = {
    taskId: 'task_denied_01',
    dispatchId: 'disp_denied_01',
    role: 'writer',
    riskTier: 'high',
    decision: 'denied',
    actualModel: 'indeterminate',
    provider: null,
    evaluatedAt: new Date(1700000000000).toISOString(),
  };
  const receipt = buildSelectionReceipt(deniedInput);
  assert.equal(receipt.decision, 'denied');
  assert.equal(receipt.actualModel, 'indeterminate');
  assert.equal(receipt.provider, null);
  assert.match(receipt.receiptDigest, /^sha256:[0-9a-f]{64}$/);

  const validated = validateSelectionReceipt(receipt);
  assert.equal(validated.decision, 'denied');
});

test('computeSelectionReceiptDigest is deterministic and canonical', () => {
  const receipt1 = makeValidReceipt();
  const receipt2 = {
    evaluatedAt: receipt1.evaluatedAt,
    decision: receipt1.decision,
    sessionFreshness: receipt1.sessionFreshness,
    contributorLineageDigest: receipt1.contributorLineageDigest,
    fallbackDecision: receipt1.fallbackDecision,
    fallbackFrom: receipt1.fallbackFrom,
    variant: receipt1.variant,
    effort: receipt1.effort,
    actualModel: receipt1.actualModel,
    requestedModel: receipt1.requestedModel,
    agent: receipt1.agent,
    provider: receipt1.provider,
    bindingRevision: receipt1.bindingRevision,
    modelBindingRevision: receipt1.modelBindingRevision,
    rolePolicyRevision: receipt1.rolePolicyRevision,
    riskTier: receipt1.riskTier,
    role: receipt1.role,
    dispatchId: receipt1.dispatchId,
    taskId: receipt1.taskId,
    schema: receipt1.schema,
  };

  const digest1 = computeSelectionReceiptDigest(receipt1);
  const digest2 = computeSelectionReceiptDigest(receipt2);
  assert.equal(digest1, digest2);
  assert.match(digest1, /^sha256:[0-9a-f]{64}$/);
});

test('validateSelectionReceipt rejects unknown extra fields', () => {
  const receipt = buildSelectionReceipt(makeValidReceipt());
  const mutated = { ...receipt, unauthorizedField: 'surprise' };

  assert.throws(
    () => validateSelectionReceipt(mutated),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT' && err.message.includes('unauthorized fields'),
  );
});

test('validateSelectionReceipt rejects mutated receipt digest', () => {
  const receipt = buildSelectionReceipt(makeValidReceipt());
  const tampered = { ...receipt, receiptDigest: 'sha256:' + 'a'.repeat(64) };

  assert.throws(
    () => validateSelectionReceipt(tampered),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT' && err.message.includes('receiptDigest mismatch'),
  );
});

test('validateSelectionReceipt rejects forbidden credentials, tokens, secrets and paths', () => {
  const testCases = [
    { field: 'agent', value: 'secret-token-bearer-12345' },
    { field: 'requestedModel', value: 'sk-ant-api-03-xxxx' },
    { field: 'agent', value: '/Users/foo/secret/file.txt' },
    { field: 'agent', value: 'my-template-{{user_prompt}}' },
  ];

  for (const tc of testCases) {
    const invalidReceipt = makeValidReceipt({ [tc.field]: tc.value });
    assert.throws(
      () => buildSelectionReceipt(invalidReceipt),
      (err) => err.code === 'POLICY_DENIED' || err.code === 'ORCHESTRATION_INVALID_INPUT',
      `Expected rejection for forbidden material in ${tc.field}: ${tc.value}`,
    );
  }
});

test('validateSelectionReceipt rejects invalid schema identifier', () => {
  const valid = buildSelectionReceipt(makeValidReceipt());
  const invalidReceipt = { ...valid, schema: 'provisional-alias/1' };
  assert.throws(
    () => validateSelectionReceipt(invalidReceipt),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT' && err.message.includes('Unsupported selection receipt schema'),
  );
});

test('validateSelectionReceipt validates against raw schema file', () => {
  const schemaPath = join(process.cwd(), 'src/orchestration/schemas/dispatch-selection-receipt.schema.json');
  const rawSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));

  assert.equal(rawSchema.$id, SELECTION_RECEIPT_SCHEMA);
  assert.equal(rawSchema.additionalProperties, false);
  assert.equal(Object.keys(rawSchema.properties).length, 21);
  assert.equal(rawSchema.required.length, 21);
});
