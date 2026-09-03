import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEntryPlan } from '../../src/orchestration/managed-host/entry-plan.mjs';
import { ENTRY_POLICY_REVISION } from '../../src/orchestration/managed-host/capability-profile.mjs';
import { selectCapabilityProfile, isCapabilityAllowed } from '../../src/orchestration/managed-host/tool-gating.mjs';

const TRUSTED_ROLE_REVISION = 'sha256:d87e3a8d533fe678b1196b560207a73edf803aeb55981b7adb47d91782095123';

function makePlan(entryState, projectPolicyLoaded = true) {
  return buildEntryPlan({
    entryState,
    projectPolicyLoaded,
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
  });
}

test('tool-gating: allow-list enforcement — only accepted profile for state', () => {
  const plan = makePlan('ENTRY_READY');
  const hostEv = {
    entryState: 'ENTRY_READY',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    projectPolicyLoaded: true,
  };
  const result = selectCapabilityProfile(plan, hostEv);
  assert.equal(result.acceptedProfileId, 'webmcp-managed-capability-profile/1:ENTRY_READY');
  assert.deepEqual(result.allowedCapabilities, ['runner.handoff']);

  // Requesting a capability not in allow-list is denied
  assert.throws(() => selectCapabilityProfile(plan, {
    ...hostEv,
    requestedCapabilities: ['store.discovery'],
  }), (e) => e.code === 'WEBMCP_ENTRY_RECEIPT_REQUIRED');

  // Valid requested capability passes
  assert.doesNotThrow(() => selectCapabilityProfile(plan, {
    ...hostEv,
    requestedCapabilities: ['runner.handoff'],
  }));
});

test('tool-gating: unknown capability class deny', () => {
  const plan = makePlan('HOST_PREFLIGHT');
  const hostEv = {
    entryState: 'HOST_PREFLIGHT',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    projectPolicyLoaded: false,
    requestedCapabilities: ['browser.evil'],
  };
  assert.throws(() => selectCapabilityProfile(plan, hostEv), (e) => e.code === 'WEBMCP_ENTRY_RECEIPT_REQUIRED');

  // Unknown class via capabilityClasses drift already fails at plan level, but gating also checks requested
  assert.throws(() => selectCapabilityProfile(plan, {
    ...hostEv,
    requestedCapabilities: ['shell'],
  }), (e) => e.code === 'WEBMCP_ENTRY_RECEIPT_REQUIRED');

  assert.throws(() => selectCapabilityProfile(plan, {
    ...hostEv,
    requestedCapabilities: ['curl'],
  }), (e) => /WEBMCP_ENTRY_RECEIPT_REQUIRED/.test(e.code));
});

test('tool-gating: prompt-injected shell/curl/direct-browser denied', () => {
  const plan = makePlan('PROJECT_POLICY_LOADED');
  const baseHost = {
    entryState: 'PROJECT_POLICY_LOADED',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    projectPolicyLoaded: true,
  };
  assert.throws(() => selectCapabilityProfile(plan, { ...baseHost, requestedCapabilities: ['shell'] }), (e) => e.code === 'WEBMCP_ENTRY_RECEIPT_REQUIRED');
  assert.throws(() => selectCapabilityProfile(plan, { ...baseHost, requestedCapabilities: ['curl'] }), (e) => e.code === 'WEBMCP_ENTRY_RECEIPT_REQUIRED');
  assert.throws(() => selectCapabilityProfile(plan, { ...baseHost, requestedCapabilities: ['direct-browser'] }), (e) => e.code === 'WEBMCP_ENTRY_RECEIPT_REQUIRED');
  assert.throws(() => selectCapabilityProfile(plan, { ...baseHost, requestedCapabilities: ['browser.navigate'] }), (e) => e.code === 'WEBMCP_ENTRY_RECEIPT_REQUIRED');
  assert.throws(() => selectCapabilityProfile(plan, { ...baseHost, requestedCapabilities: ['provider.exec'] }), (e) => /WEBMCP_ENTRY_RECEIPT_REQUIRED/.test(e.code));
});

test('tool-gating: unknown entryState denied', () => {
  const plan = makePlan('ENTRY_READY');
  assert.throws(() => selectCapabilityProfile(plan, {
    entryState: 'UNKNOWN_STATE',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    projectPolicyLoaded: true,
  }), (e) => e.code === 'WEBMCP_ROUTE_REQUIRED');
});

test('tool-gating: entryPolicyRevision drift denied', () => {
  const plan = makePlan('ENTRY_READY');
  assert.throws(() => selectCapabilityProfile(plan, {
    entryState: 'ENTRY_READY',
    entryPolicyRevision: 'sha256:' + 'f'.repeat(64),
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    projectPolicyLoaded: true,
  }), (e) => e.code === 'WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH');
});

test('tool-gating: rolePolicyRevision drift denied', () => {
  const plan = makePlan('ENTRY_READY');
  assert.throws(() => selectCapabilityProfile(plan, {
    entryState: 'ENTRY_READY',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: 'sha256:' + 'e'.repeat(64),
    projectPolicyLoaded: true,
  }), (e) => e.code === 'AI_ROLE_POLICY_DIGEST_MISMATCH');
});

test('tool-gating: guideSelectionDigest drift on no-guide route denied', () => {
  const plan = makePlan('ENTRY_READY');
  assert.throws(() => selectCapabilityProfile(plan, {
    entryState: 'ENTRY_READY',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    projectPolicyLoaded: true,
    guideSelectionDigest: 'sha256:' + 'a'.repeat(64),
  }), (e) => e.code === 'PROJECT_GUIDE_CONTEXT_STALE' || e.code === 'PROJECT_GUIDE_APPROVAL_REQUIRED');
});

test('tool-gating: missing/stale project policy denied for store.discovery state', () => {
  const plan = makePlan('PROJECT_POLICY_LOADED', true);
  // projectPolicyLoaded false should deny PROJECT_POLICY_LOADED
  assert.throws(() => selectCapabilityProfile(plan, {
    entryState: 'PROJECT_POLICY_LOADED',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    projectPolicyLoaded: false,
  }), (e) => e.code === 'WEBMCP_PROJECT_BOOTSTRAP_REQUIRED');

  // ENTRY_READY without projectPolicyLoaded also denied
  const entryPlan = makePlan('ENTRY_READY', true);
  assert.throws(() => selectCapabilityProfile(entryPlan, {
    entryState: 'ENTRY_READY',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    projectPolicyLoaded: false,
  }), (e) => e.code === 'WEBMCP_ENTRY_RECEIPT_REQUIRED' || e.code === 'WEBMCP_PROJECT_BOOTSTRAP_REQUIRED');
});

test('tool-gating: unapproved guide denied', () => {
  const plan = makePlan('PROJECT_POLICY_LOADED');
  assert.throws(() => selectCapabilityProfile(plan, {
    entryState: 'PROJECT_POLICY_LOADED',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    projectPolicyLoaded: true,
    guideSelectionDigest: 'sha256:' + 'a'.repeat(64),
  }), (e) => e.code === 'PROJECT_GUIDE_CONTEXT_STALE' || e.code === 'PROJECT_GUIDE_APPROVAL_REQUIRED');
});

test('tool-gating: unsupported host G2 claim denied', () => {
  const plan = makePlan('ENTRY_READY');
  assert.throws(() => selectCapabilityProfile(plan, {
    entryState: 'ENTRY_READY',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    projectPolicyLoaded: true,
    guaranteeTier: 'G2',
  }), (e) => e.code === 'POLICY_DENIED');

  assert.throws(() => selectCapabilityProfile(plan, {
    entryState: 'ENTRY_READY',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    projectPolicyLoaded: true,
    hostMode: 'g2',
  }), (e) => e.code === 'POLICY_DENIED');
});

test('tool-gating: model self-set state/profile/guarantee ignored but G2 self-set denied', () => {
  const plan = makePlan('ENTRY_READY');
  // self-set G2 should be denied
  assert.throws(() => selectCapabilityProfile(plan, {
    entryState: 'ENTRY_READY',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    projectPolicyLoaded: true,
    modelProposed: { guaranteeTier: 'G2', state: 'ENTRY_READY', profile: 'evil' },
  }), (e) => e.code === 'POLICY_DENIED');

  // self-set non-G2 is ignored (validator derives from trusted)
  assert.doesNotThrow(() => selectCapabilityProfile(plan, {
    entryState: 'ENTRY_READY',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    projectPolicyLoaded: true,
    modelProposed: { state: 'SESSION_NEW', skillRead: true },
  }));
});

test('tool-gating: isCapabilityAllowed helper', () => {
  assert.equal(isCapabilityAllowed('runner.handoff', 'ENTRY_READY'), true);
  assert.equal(isCapabilityAllowed('store.discovery', 'ENTRY_READY'), false);
  assert.equal(isCapabilityAllowed('host-inspection', 'HOST_PREFLIGHT'), true);
  assert.equal(isCapabilityAllowed('browser.navigate', 'ENTRY_READY'), false);
});

test('tool-gating: capabilityProfileRevision mismatch denied', () => {
  const plan = makePlan('ENTRY_READY');
  const tampered = { ...plan, capabilityProfileRevision: 'sha256:' + 'f'.repeat(64) };
  assert.throws(() => selectCapabilityProfile(tampered, {
    entryState: 'ENTRY_READY',
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: TRUSTED_ROLE_REVISION,
    projectPolicyLoaded: true,
  }), (e) => e.code === 'WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH');
});
