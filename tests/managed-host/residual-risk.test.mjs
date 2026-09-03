import assert from 'node:assert/strict';
import test from 'node:test';

import { buildResidualRisk, RESIDUAL_RISK_SCHEMA } from '../../src/orchestration/managed-host/residual-risk.mjs';

const ENTRY_REV = 'sha256:e9822cdf5114b19ace74dd09573c01c0aa28a0e7c2ae02daf3a74ecc142fe939';
const ROLE_REV = 'sha256:d87e3a8d533fe678b1196b560207a73edf803aeb55981b7adb47d91782095123';
const PROFILE_REV = 'sha256:' + 'a'.repeat(64);

test('residual-risk: builds G0/G1 payload honestly and never G2', () => {
  const payload = buildResidualRisk({
    guaranteeTier: 'G1',
    hostMode: 'managed-G1',
    entryState: 'PROJECT_POLICY_LOADED',
    capabilityProfileRevision: PROFILE_REV,
    entryPolicyRevision: ENTRY_REV,
    rolePolicyRevision: ROLE_REV,
    missingPrimitives: ['tool-surface-hiding', 'mediated-fs'],
    wouldDeny: ['shell.before-entry', 'curl.before-entry'],
  });
  assert.equal(payload.schema, RESIDUAL_RISK_SCHEMA);
  assert.equal(payload.guaranteeTier, 'G1');
  assert.equal(payload.hostMode, 'managed-G1');
  assert.deepEqual([...payload.missingPrimitives].sort(), ['mediated-fs', 'tool-surface-hiding']);
  assert.deepEqual([...payload.wouldDeny].sort(), ['curl.before-entry', 'shell.before-entry']);
  assert.equal(payload.guaranteeTier === 'G2', false, 'never G2');

  const g0 = buildResidualRisk({
    guaranteeTier: 'G0',
    hostMode: 'ambient-G0',
    entryState: 'SESSION_NEW',
    capabilityProfileRevision: PROFILE_REV,
    entryPolicyRevision: ENTRY_REV,
    rolePolicyRevision: ROLE_REV,
    missingPrimitives: ['mediated-network'],
    wouldDeny: ['browser.before-entry'],
  });
  assert.equal(g0.guaranteeTier, 'G0');
  assert.equal(g0.hostMode, 'ambient-G0');
});

test('residual-risk: G2 claim is denied', () => {
  assert.throws(() => buildResidualRisk({
    guaranteeTier: 'G2',
    hostMode: 'managed-G1',
    entryState: 'ENTRY_READY',
    capabilityProfileRevision: PROFILE_REV,
    entryPolicyRevision: ENTRY_REV,
    rolePolicyRevision: ROLE_REV,
    missingPrimitives: [],
    wouldDeny: [],
  }), (e) => e.code === 'POLICY_DENIED');

  assert.throws(() => buildResidualRisk({
    guaranteeTier: 'G1',
    hostMode: 'g2',
    entryState: 'ENTRY_READY',
    capabilityProfileRevision: PROFILE_REV,
    entryPolicyRevision: ENTRY_REV,
    rolePolicyRevision: ROLE_REV,
    missingPrimitives: [],
    wouldDeny: [],
  }), (e) => /G2|hostMode/.test(e.message));
});

test('residual-risk: never reports G2 even when missingPrimitives empty', () => {
  const payload = buildResidualRisk({
    guaranteeTier: 'G1',
    hostMode: 'unsupported',
    entryState: 'ENTRY_READY',
    capabilityProfileRevision: PROFILE_REV,
    entryPolicyRevision: ENTRY_REV,
    rolePolicyRevision: ROLE_REV,
    missingPrimitives: [],
    wouldDeny: [],
  });
  assert.notEqual(payload.guaranteeTier, 'G2');
  assert.notEqual(payload.hostMode, 'G2');
});

test('residual-risk: contains no secrets or absolute paths', () => {
  const payload = buildResidualRisk({
    guaranteeTier: 'G1',
    hostMode: 'managed-G1',
    entryState: 'PROJECT_POLICY_LOADED',
    capabilityProfileRevision: PROFILE_REV,
    entryPolicyRevision: ENTRY_REV,
    rolePolicyRevision: ROLE_REV,
    missingPrimitives: ['tool-surface-hiding'],
    wouldDeny: ['shell.before-entry'],
  });
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('token'), false);
  assert.equal(serialized.includes('sk-'), false);
  assert.equal(serialized.includes('/Users'), false);
  assert.equal(serialized.includes('credential'), false);
  assert.equal(serialized.includes('bindingPath'), false);
  // Digests are allowed
  assert.ok(serialized.includes('sha256:'));
});

test('residual-risk: invalid guaranteeTier/hostMode denied', () => {
  assert.throws(() => buildResidualRisk({
    guaranteeTier: 'G3',
    hostMode: 'managed-G1',
    entryState: 'ENTRY_READY',
    capabilityProfileRevision: PROFILE_REV,
    entryPolicyRevision: ENTRY_REV,
    rolePolicyRevision: ROLE_REV,
    missingPrimitives: [],
    wouldDeny: [],
  }), (e) => e.code === 'ORCHESTRATION_INVALID_INPUT');

  assert.throws(() => buildResidualRisk({
    guaranteeTier: 'G1',
    hostMode: 'invalid-mode',
    entryState: 'ENTRY_READY',
    capabilityProfileRevision: PROFILE_REV,
    entryPolicyRevision: ENTRY_REV,
    rolePolicyRevision: ROLE_REV,
    missingPrimitives: [],
    wouldDeny: [],
  }), (e) => e.code === 'ORCHESTRATION_INVALID_INPUT');
});

test('residual-risk: revision fields must be valid digests', () => {
  assert.throws(() => buildResidualRisk({
    guaranteeTier: 'G1',
    hostMode: 'managed-G1',
    entryState: 'ENTRY_READY',
    capabilityProfileRevision: 'not-a-digest',
    entryPolicyRevision: ENTRY_REV,
    rolePolicyRevision: ROLE_REV,
    missingPrimitives: [],
    wouldDeny: [],
  }), (e) => e.code === 'ORCHESTRATION_INVALID_INPUT');
});

test('residual-risk: frozen and deterministic', () => {
  const p1 = buildResidualRisk({
    guaranteeTier: 'G1',
    hostMode: 'managed-G1',
    entryState: 'ENTRY_READY',
    capabilityProfileRevision: PROFILE_REV,
    entryPolicyRevision: ENTRY_REV,
    rolePolicyRevision: ROLE_REV,
    missingPrimitives: ['b', 'a'],
    wouldDeny: ['y', 'x'],
  });
  const p2 = buildResidualRisk({
    guaranteeTier: 'G1',
    hostMode: 'managed-G1',
    entryState: 'ENTRY_READY',
    capabilityProfileRevision: PROFILE_REV,
    entryPolicyRevision: ENTRY_REV,
    rolePolicyRevision: ROLE_REV,
    missingPrimitives: ['a', 'b'],
    wouldDeny: ['x', 'y'],
  });
  assert.deepEqual(p1.missingPrimitives, p2.missingPrimitives, 'sorted deterministically');
  assert.deepEqual(p1.wouldDeny, p2.wouldDeny);
  assert.ok(Object.isFrozen(p1));
  assert.ok(Object.isFrozen(p1.missingPrimitives));
});

test('residual-risk: secret material in fields is denied', () => {
  assert.throws(() => buildResidualRisk({
    guaranteeTier: 'G1',
    hostMode: 'managed-G1',
    entryState: 'ENTRY_READY',
    capabilityProfileRevision: PROFILE_REV,
    entryPolicyRevision: ENTRY_REV,
    rolePolicyRevision: ROLE_REV,
    missingPrimitives: ['/etc/passwd'],
    wouldDeny: [],
  }), (e) => /path|Primitive/.test(e.message));

  assert.throws(() => buildResidualRisk({
    guaranteeTier: 'G1',
    hostMode: 'managed-G1',
    entryState: 'ENTRY_READY',
    capabilityProfileRevision: PROFILE_REV,
    entryPolicyRevision: ENTRY_REV,
    rolePolicyRevision: ROLE_REV,
    missingPrimitives: ['tool-surface-hiding'],
    wouldDeny: ['sk-1234abcd'],
  }), (e) => e.code === 'POLICY_DENIED' || /secret/.test(e.message));
});
