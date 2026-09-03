import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEntryPlan, validateEntryPlan, REQUIRED_OBLIGATION_IDS } from '../../src/orchestration/managed-host/entry-plan.mjs';
import { ENTRY_POLICY_REVISION } from '../../src/orchestration/managed-host/capability-profile.mjs';

const TRUSTED_ROLE_REVISION = 'sha256:d87e3a8d533fe678b1196b560207a73edf803aeb55981b7adb47d91782095123';

test('entry-plan: builds structured plan citing obligationIds and exact revisions', () => {
  const plan = buildEntryPlan({
    entryState: 'PROJECT_POLICY_LOADED',
    projectPolicyLoaded: true,
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
  });
  assert.equal(plan.schema, 'webmcp-entry-plan/1');
  assert.equal(plan.entryState, 'PROJECT_POLICY_LOADED');
  assert.equal(plan.entryPolicyRevision, ENTRY_POLICY_REVISION);
  assert.equal(plan.rolePolicyRevision, TRUSTED_ROLE_REVISION);
  assert.match(plan.capabilityProfileRevision, /^sha256:[0-9a-f]{64}$/);
  for (const oid of REQUIRED_OBLIGATION_IDS) {
    assert.ok(plan.obligationIds.includes(oid), `must cite ${oid}`);
  }
  assert.equal(plan.guideSelectionDigest, null, 'no-guide route has null guide digest');
  assert.deepEqual(plan.capabilityClassesSorted, ['guide.validate', 'request.prepare', 'store.discovery']);
});

test('entry-plan: unknown-field rejection', () => {
  assert.throws(() => buildEntryPlan({
    entryState: 'ENTRY_READY',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    unknownField: 'evil',
  }), (e) => e.code === 'ORCHESTRATION_INVALID_INPUT' && /unknown field/.test(e.message));

  assert.throws(() => buildEntryPlan({
    entryState: 'ENTRY_READY',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    secret: 'sk-1234',
  }), (e) => e.code === 'ORCHESTRATION_INVALID_INPUT');
});

test('entry-plan: unknown entryState denied', () => {
  assert.throws(() => buildEntryPlan({
    entryState: 'UNKNOWN_STATE',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
  }), (e) => e.code === 'WEBMCP_ROUTE_REQUIRED');
});

test('entry-plan: entryPolicyRevision drift fails closed', () => {
  assert.throws(() => buildEntryPlan({
    entryState: 'ENTRY_READY',
    entryPolicyRevision: 'sha256:' + 'f'.repeat(64),
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
  }), (e) => e.code === 'WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH');
});

test('entry-plan: missing rolePolicyRevision fails closed', () => {
  assert.throws(() => buildEntryPlan({
    entryState: 'ENTRY_READY',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
  }), (e) => e.code === 'AI_ROLE_POLICY_REQUIRED');
});

test('entry-plan: guide-required on no-guide route is denied', () => {
  assert.throws(() => buildEntryPlan({
    entryState: 'PROJECT_POLICY_LOADED',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    guideRequired: true,
  }), (e) => e.code === 'PROJECT_GUIDE_APPROVAL_REQUIRED');

  assert.throws(() => buildEntryPlan({
    entryState: 'PROJECT_POLICY_LOADED',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    collectionId: 'col_123',
  }), (e) => e.code === 'PROJECT_GUIDE_APPROVAL_REQUIRED');

  assert.throws(() => buildEntryPlan({
    entryState: 'PROJECT_POLICY_LOADED',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    guideSelectionDigest: 'sha256:' + 'a'.repeat(64),
  }), (e) => e.code === 'PROJECT_GUIDE_CONTEXT_STALE');
});

test('entry-plan: validateEntryPlan detects revision drift', () => {
  const plan = buildEntryPlan({
    entryState: 'ENTRY_READY',
    projectPolicyLoaded: true,
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
  });
  const tampered = { ...plan, capabilityProfileRevision: 'sha256:' + 'f'.repeat(64) };
  assert.throws(() => validateEntryPlan(tampered), (e) => e.code === 'WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH');
  assert.doesNotThrow(() => validateEntryPlan(plan));
});

test('entry-plan: capabilityProfileId must match entryState', () => {
  assert.throws(() => buildEntryPlan({
    entryState: 'ENTRY_READY',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    capabilityProfileId: 'webmcp-managed-capability-profile/1:SESSION_NEW',
  }), (e) => e.code === 'WEBMCP_ROUTE_REQUIRED');
});

test('entry-plan: no-guide valid plan has no guide fields and no collections scan', () => {
  const plan = buildEntryPlan({
    entryState: 'ENTRY_READY',
    projectPolicyLoaded: true,
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
  });
  assert.equal(plan.guideSelectionDigest, null);
  assert.equal('collectionId' in plan, false, 'must not contain collectionId');
  assert.equal('guideSha256' in plan, false);
});

test('entry-plan: secret absence — plan contains only digests and bounded IDs', () => {
  const plan = buildEntryPlan({
    entryState: 'HOST_PREFLIGHT',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
  });
  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('token'), false);
  assert.equal(serialized.includes('/Users'), false);
  assert.equal(serialized.includes('sk-'), false);
});
