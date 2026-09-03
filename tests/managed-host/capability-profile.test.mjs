import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ENTRY_POLICY_REVISION,
  CAPABILITY_PROFILE_TABLE,
  ALLOWED_PROFILE_IDS,
  computeCapabilityProfileRevision,
  validateCapabilityProfile,
  profileIdForState,
  allowedCapabilitiesForState,
} from '../../src/orchestration/managed-host/capability-profile.mjs';

const TRUSTED_ROLE_REVISION = 'sha256:d87e3a8d533fe678b1196b560207a73edf803aeb55981b7adb47d91782095123';

test('capability-profile: deterministic revision is stable and sorted', () => {
  const params = {
    capabilityProfileId: 'webmcp-managed-capability-profile/1:ENTRY_READY',
    capabilityClassesSorted: ['runner.handoff'],
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    guideSelectionDigestOrNull: null,
  };
  const a = computeCapabilityProfileRevision(params);
  const b = computeCapabilityProfileRevision(params);
  assert.equal(a, b, 'deterministic');
  assert.match(a, /^sha256:[0-9a-f]{64}$/);

  // Different entryPolicyRevision produces different digest
  const c = computeCapabilityProfileRevision({ ...params, entryPolicyRevision: 'sha256:' + 'a'.repeat(64) });
  assert.notEqual(a, c);

  // Guide digest changes revision
  const d = computeCapabilityProfileRevision({ ...params, guideSelectionDigestOrNull: 'sha256:' + 'b'.repeat(64) });
  assert.notEqual(a, d);

  // Sorted requirement: unsorted input throws
  assert.throws(() => computeCapabilityProfileRevision({
    ...params,
    capabilityClassesSorted: ['skill.load', 'project.doctor', 'project.resolve'], // unsorted vs sorted is project.doctor etc.
  }), (e) => e.code === 'ORCHESTRATION_INVALID_INPUT');

  // Correct sorted for ROUTE_VALIDATED succeeds
  const routeParams = {
    capabilityProfileId: 'webmcp-managed-capability-profile/1:ROUTE_VALIDATED',
    capabilityClassesSorted: ['project.doctor', 'project.resolve', 'skill.load'],
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    guideSelectionDigestOrNull: null,
  };
  const e = computeCapabilityProfileRevision(routeParams);
  assert.match(e, /^sha256:[0-9a-f]{64}$/);
});

test('capability-profile: trusted-source binding — entryPolicyRevision drift fails closed', () => {
  const profileId = 'webmcp-managed-capability-profile/1:HOST_PREFLIGHT';
  const classes = [...CAPABILITY_PROFILE_TABLE[profileId].capabilityClassesSorted];
  const goodRev = computeCapabilityProfileRevision({
    capabilityProfileId: profileId,
    capabilityClassesSorted: classes,
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    guideSelectionDigestOrNull: null,
  });
  // Valid profile passes
  const validated = validateCapabilityProfile({
    capabilityProfileId: profileId,
    capabilityClassesSorted: classes,
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    guideSelectionDigestOrNull: null,
    expectedRevision: goodRev,
    trustedEntryPolicyRevision: ENTRY_POLICY_REVISION,
    trustedRolePolicyRevision: TRUSTED_ROLE_REVISION,
  });
  assert.equal(validated.revision, goodRev);

  // Drifted entryPolicyRevision
  assert.throws(() => validateCapabilityProfile({
    capabilityProfileId: profileId,
    capabilityClassesSorted: classes,
    entryPolicyRevision: 'sha256:' + 'f'.repeat(64),
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    guideSelectionDigestOrNull: null,
    expectedRevision: goodRev,
    trustedEntryPolicyRevision: ENTRY_POLICY_REVISION,
    trustedRolePolicyRevision: TRUSTED_ROLE_REVISION,
  }), (e) => e.code === 'WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH');

  // Drifted rolePolicyRevision
  assert.throws(() => validateCapabilityProfile({
    capabilityProfileId: profileId,
    capabilityClassesSorted: classes,
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: 'sha256:' + 'e'.repeat(64),
    guideSelectionDigestOrNull: null,
    expectedRevision: goodRev,
    trustedEntryPolicyRevision: ENTRY_POLICY_REVISION,
    trustedRolePolicyRevision: TRUSTED_ROLE_REVISION,
  }), (e) => e.code === 'AI_ROLE_POLICY_DIGEST_MISMATCH');

  // Drifted guide digest
  assert.throws(() => validateCapabilityProfile({
    capabilityProfileId: profileId,
    capabilityClassesSorted: classes,
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    guideSelectionDigestOrNull: 'sha256:' + 'c'.repeat(64),
    expectedRevision: goodRev,
    trustedEntryPolicyRevision: ENTRY_POLICY_REVISION,
    trustedRolePolicyRevision: TRUSTED_ROLE_REVISION,
    trustedGuideDigest: null,
  }), (e) => e.code === 'PROJECT_GUIDE_CONTEXT_STALE');
});

test('capability-profile: unknown/stale/drifted profile denial', () => {
  // Unknown profile id
  assert.throws(() => computeCapabilityProfileRevision({
    capabilityProfileId: 'webmcp-managed-capability-profile/1:UNKNOWN_STATE',
    capabilityClassesSorted: [],
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    guideSelectionDigestOrNull: null,
  }), (e) => e.code === 'WEBMCP_ROUTE_REQUIRED');

  assert.throws(() => validateCapabilityProfile({
    capabilityProfileId: 'webmcp-managed-capability-profile/1:UNKNOWN_STATE',
    capabilityClassesSorted: [],
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    guideSelectionDigestOrNull: null,
    expectedRevision: 'sha256:' + 'a'.repeat(64),
    trustedEntryPolicyRevision: ENTRY_POLICY_REVISION,
    trustedRolePolicyRevision: TRUSTED_ROLE_REVISION,
  }), (e) => e.code === 'WEBMCP_ROUTE_REQUIRED');

  // Stale capabilityClasses (drift)
  const goodId = 'webmcp-managed-capability-profile/1:ENTRY_READY';
  assert.throws(() => validateCapabilityProfile({
    capabilityProfileId: goodId,
    capabilityClassesSorted: ['store.discovery'], // wrong for ENTRY_READY
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    guideSelectionDigestOrNull: null,
    expectedRevision: 'sha256:' + 'a'.repeat(64),
    trustedEntryPolicyRevision: ENTRY_POLICY_REVISION,
    trustedRolePolicyRevision: TRUSTED_ROLE_REVISION,
  }), (e) => e.code === 'WEBMCP_ROUTE_REQUIRED');

  // Unknown capability class
  assert.throws(() => computeCapabilityProfileRevision({
    capabilityProfileId: goodId,
    capabilityClassesSorted: ['shell'],
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    guideSelectionDigestOrNull: null,
  }), (e) => e.code === 'WEBMCP_ROUTE_REQUIRED');

  // Revision mismatch (computed vs expected)
  const classes = [...CAPABILITY_PROFILE_TABLE[goodId].capabilityClassesSorted];
  const correct = computeCapabilityProfileRevision({
    capabilityProfileId: goodId,
    capabilityClassesSorted: classes,
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    guideSelectionDigestOrNull: null,
  });
  assert.throws(() => validateCapabilityProfile({
    capabilityProfileId: goodId,
    capabilityClassesSorted: classes,
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    guideSelectionDigestOrNull: null,
    expectedRevision: 'sha256:' + 'f'.repeat(64),
    trustedEntryPolicyRevision: ENTRY_POLICY_REVISION,
    trustedRolePolicyRevision: TRUSTED_ROLE_REVISION,
  }), (e) => e.code === 'WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH');
});

test('capability-profile: 11-row table is exact and sorted', () => {
  assert.equal(ALLOWED_PROFILE_IDS.length, 11, 'exactly 11 profiles');
  for (const id of ALLOWED_PROFILE_IDS) {
    const meta = CAPABILITY_PROFILE_TABLE[id];
    assert.ok(meta.entryState, `entryState for ${id}`);
    const sorted = [...meta.capabilityClassesSorted].sort();
    assert.deepEqual([...meta.capabilityClassesSorted], sorted, `${id} classes must be sorted`);
  }
  // Check specific rows
  assert.deepEqual(CAPABILITY_PROFILE_TABLE['webmcp-managed-capability-profile/1:SESSION_NEW'].capabilityClassesSorted, []);
  assert.deepEqual(CAPABILITY_PROFILE_TABLE['webmcp-managed-capability-profile/1:HOST_PREFLIGHT'].capabilityClassesSorted, ['host-inspection', 'skill-inspection']);
  assert.deepEqual(CAPABILITY_PROFILE_TABLE['webmcp-managed-capability-profile/1:ENTRY_READY'].capabilityClassesSorted, ['runner.handoff']);
});

test('capability-profile: helper profileIdForState and allowedCapabilitiesForState', () => {
  assert.equal(profileIdForState('ENTRY_READY'), 'webmcp-managed-capability-profile/1:ENTRY_READY');
  assert.deepEqual(allowedCapabilitiesForState('ENTRY_READY'), ['runner.handoff']);
  assert.throws(() => profileIdForState('UNKNOWN'), (e) => e.code === 'WEBMCP_ROUTE_REQUIRED');
});

test('capability-profile: secret absence — revisions contain only digests', () => {
  const rev = computeCapabilityProfileRevision({
    capabilityProfileId: 'webmcp-managed-capability-profile/1:PROJECT_POLICY_LOADED',
    capabilityClassesSorted: ['guide.validate', 'request.prepare', 'store.discovery'],
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    guideSelectionDigestOrNull: null,
  });
  assert.match(rev, /^sha256:[0-9a-f]{64}$/);
  // Ensure no secret patterns in revision
  assert.equal(rev.includes('secret'), false);
  assert.equal(rev.includes('/Users'), false);
});
