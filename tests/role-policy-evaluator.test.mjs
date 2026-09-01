import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_ROLE_POLICY,
  computePolicyDigest,
} from '../src/orchestration/role-policy.mjs';
import {
  MANAGED_BINDING_SCHEMA,
} from '../src/orchestration/managed-binding.mjs';
import {
  EVALUATION_VIOLATIONS,
  assertModelRoleEligibility,
  evaluateModelRoleEligibility,
} from '../src/orchestration/role-policy-evaluator.mjs';

const DUMMY_CALIBRATION_DIGEST = 'sha256:' + '1'.repeat(64); // contentos:allow
const DUMMY_APPROVAL_DIGEST = 'sha256:' + '2'.repeat(64); // contentos:allow
const DUMMY_EXEC_DIGEST = 'sha256:' + '3'.repeat(64); // contentos:allow

function makeBinding(overrides = {}) {
  return {
    schema: MANAGED_BINDING_SCHEMA,
    bindingId: 'bind_eval_writer_01',
    adapterId: 'adapter_writer_01',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    effort: 'high',
    variant: 'thinking',
    agent: 'writer-subagent',
    capabilityTier: ['write-code', 'execute-tests', 'inspect'],
    eligibleRoles: ['writer', 'task-reviewer'],
    deniedRoles: ['coordinator'],
    expiresAt: Date.now() + 3600_000,
    calibrationEvidenceDigest: DUMMY_CALIBRATION_DIGEST,
    approvalDigest: DUMMY_APPROVAL_DIGEST,
    revision: 1,
    executableIdentityDigest: DUMMY_EXEC_DIGEST,
    ...overrides,
  };
}

function makeAuditorBinding(overrides = {}) {
  return {
    schema: MANAGED_BINDING_SCHEMA,
    bindingId: 'bind_eval_auditor_01',
    adapterId: 'adapter_auditor_01',
    provider: 'google-ai',
    model: 'gemini-2.5-pro',
    effort: 'high',
    variant: 'default',
    agent: 'auditor-agent',
    capabilityTier: ['audit-release', 'verify-integrity', 'accept'],
    eligibleRoles: ['final-auditor'],
    deniedRoles: ['writer', 'coordinator'],
    expiresAt: Date.now() + 3600_000,
    calibrationEvidenceDigest: 'sha256:' + '4'.repeat(64), // contentos:allow
    approvalDigest: 'sha256:' + '5'.repeat(64), // contentos:allow
    revision: 2,
    executableIdentityDigest: 'sha256:' + '6'.repeat(64), // contentos:allow
    ...overrides,
  };
}

test('evaluator: positive evaluation for valid writer and coordinator tasks', () => {
  const writerTask = {
    role: 'writer',
    assurance: 'code-bounded',
    requiredCapabilities: ['write-code'],
  };
  const writerBinding = makeBinding();

  const writerResult = evaluateModelRoleEligibility({
    task: writerTask,
    binding: writerBinding,
  });

  assert.equal(writerResult.eligible, true);
  assert.equal(writerResult.role, 'writer');
  assert.equal(writerResult.assurance, 'code-bounded');
  assert.equal(writerResult.bindingId, 'bind_eval_writer_01');
  assert.deepEqual(writerResult.violations, []);
  assert.ok(Object.isFrozen(writerResult));

  // Coordinator task
  const coordBinding = makeBinding({
    bindingId: 'bind_coord_01',
    eligibleRoles: ['coordinator'],
    deniedRoles: ['final-auditor'],
  });
  const coordTask = {
    role: 'coordinator',
    assurance: 'reasoning-high',
    isFinalAcceptance: false,
  };
  const coordResult = evaluateModelRoleEligibility({
    task: coordTask,
    binding: coordBinding,
  });
  assert.equal(coordResult.eligible, true);
  assert.equal(coordResult.violations.length, 0);
});

test('evaluator: positive evaluation for final-auditor with release-final and disjoint lineage', () => {
  const auditorBinding = makeAuditorBinding();
  const auditorTask = {
    role: 'final-auditor',
    assurance: 'release-final',
    readOnly: true,
    writeRoot: false,
    freshSession: true,
  };
  const priorLineage = [
    { role: 'coordinator', model: 'claude-3-7-sonnet', provider: 'anthropic', bindingId: 'bind_coord_01' },
    { role: 'writer', model: 'claude-3-7-sonnet', provider: 'anthropic', bindingId: 'bind_writer_01' },
  ];

  const result = evaluateModelRoleEligibility({
    task: auditorTask,
    binding: auditorBinding,
    lineage: priorLineage,
  });

  assert.equal(result.eligible, true);
  assert.equal(result.role, 'final-auditor');
  assert.equal(result.assurance, 'release-final');
  assert.deepEqual(result.violations, []);
});

test('evaluator: invalid binding cannot pass downstream checks or remain usable', () => {
  // Binding with unauthorized field fails validation
  const badBinding = makeBinding({ unauthorizedField: 'bad-field' });
  const task = {
    role: 'writer',
    assurance: 'code-bounded',
    requiredCapabilities: ['write-code'],
  };

  const result = evaluateModelRoleEligibility({
    task,
    binding: badBinding,
    selection: { expectedBindingId: 'bind_eval_writer_01' },
  });

  assert.equal(result.eligible, false);
  // bindingId must be null for invalid bindings to never remain usable
  assert.equal(result.bindingId, null);
  assert.ok(result.violations.some((v) => v.code === EVALUATION_VIOLATIONS.INVALID_BINDING));
  // Downstream selection or capability checks should not have executed on unvalidated binding
  assert.equal(result.violations.some((v) => v.code === EVALUATION_VIOLATIONS.SELECTION_BINDING_MISMATCH), false);
});

test('evaluator: invalid policy fails closed and is marked invalid', () => {
  const badPolicy = { ...DEFAULT_ROLE_POLICY, unknownTopField: 123 };
  const task = { role: 'writer', assurance: 'code-bounded' };
  const binding = makeBinding();

  const result = evaluateModelRoleEligibility({
    task,
    policy: badPolicy,
    binding,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.policyDigest, null);
  assert.ok(result.violations.some((v) => v.code === EVALUATION_VIOLATIONS.INVALID_ROLE_POLICY));
});

test('evaluator: rejects invalid closed roles and assurances', () => {
  const binding = makeBinding();

  // Invalid role
  const res1 = evaluateModelRoleEligibility({
    task: { role: 'super-user', assurance: 'code-bounded' },
    binding,
  });
  assert.equal(res1.eligible, false);
  assert.equal(res1.role, null);
  assert.ok(res1.violations.some((v) => v.code === EVALUATION_VIOLATIONS.INVALID_ROLE));

  // Invalid assurance
  const res2 = evaluateModelRoleEligibility({
    task: { role: 'writer', assurance: 'maximum-power' },
    binding,
  });
  assert.equal(res2.eligible, false);
  assert.equal(res2.assurance, null);
  assert.ok(res2.violations.some((v) => v.code === EVALUATION_VIOLATIONS.INVALID_ASSURANCE));

  // Role-assurance mismatch (writer cannot use diagnostic)
  const res3 = evaluateModelRoleEligibility({
    task: { role: 'writer', assurance: 'diagnostic' },
    binding,
  });
  assert.equal(res3.eligible, false);
  assert.ok(res3.violations.some((v) => v.code === EVALUATION_VIOLATIONS.ROLE_ASSURANCE_MISMATCH));
});

test('evaluator: rejects bindings when role is denied or not eligible', () => {
  const binding = makeBinding({
    eligibleRoles: ['writer'],
    deniedRoles: ['observer'],
  });

  // Role not eligible
  const res1 = evaluateModelRoleEligibility({
    task: { role: 'task-reviewer', assurance: 'code-bounded' },
    binding,
  });
  assert.equal(res1.eligible, false);
  assert.ok(res1.violations.some((v) => v.code === EVALUATION_VIOLATIONS.ROLE_NOT_ELIGIBLE));

  // Role explicitly denied
  const res2 = evaluateModelRoleEligibility({
    task: { role: 'observer', assurance: 'code-bounded' },
    binding,
  });
  assert.equal(res2.eligible, false);
  assert.ok(res2.violations.some((v) => v.code === EVALUATION_VIOLATIONS.ROLE_EXPLICITLY_DENIED));
});

test('evaluator: rejects indeterminate models and expired bindings', () => {
  // Indeterminate model in binding
  const indeterminateBinding = makeBinding({ model: 'auto' });
  const res1 = evaluateModelRoleEligibility({
    task: { role: 'writer', assurance: 'code-bounded' },
    binding: indeterminateBinding,
  });
  assert.equal(res1.eligible, false);
  assert.ok(res1.violations.some((v) => v.code === EVALUATION_VIOLATIONS.INDETERMINATE_MODEL || v.code === EVALUATION_VIOLATIONS.INVALID_BINDING));

  // Expired binding
  const expiredBinding = makeBinding({ expiresAt: 1000 });
  const res2 = evaluateModelRoleEligibility({
    task: { role: 'writer', assurance: 'code-bounded' },
    binding: expiredBinding,
    now: 5000,
  });
  assert.equal(res2.eligible, false);
  assert.ok(res2.violations.some((v) => v.code === EVALUATION_VIOLATIONS.BINDING_EXPIRED));
});

test('evaluator: rejects missing capabilities or insufficient assurance for risk', () => {
  const binding = makeBinding({
    capabilityTier: ['inspect'],
  });

  // Missing write-code capability
  const res1 = evaluateModelRoleEligibility({
    task: { role: 'writer', assurance: 'code-bounded', requiredCapabilities: ['write-code'] },
    binding,
  });
  assert.equal(res1.eligible, false);
  assert.ok(res1.violations.some((v) => v.code === EVALUATION_VIOLATIONS.INSUFFICIENT_CAPABILITIES));

  // Critical risk with low assurance
  const res2 = evaluateModelRoleEligibility({
    task: { role: 'writer', assurance: 'code-bounded', riskTier: 'critical' },
    binding: makeBinding(),
  });
  assert.equal(res2.eligible, false);
  assert.ok(res2.violations.some((v) => v.code === EVALUATION_VIOLATIONS.INSUFFICIENT_ASSURANCE_FOR_RISK));
});

test('evaluator: enforces exact selection criteria, effort/variant, and digest/revision parity', () => {
  const binding = makeBinding();
  const task = { role: 'writer', assurance: 'code-bounded' };
  const policyDigest = computePolicyDigest(DEFAULT_ROLE_POLICY);

  // Exact match passes
  const validRes = evaluateModelRoleEligibility({
    task,
    binding,
    selection: {
      expectedBindingId: binding.bindingId,
      targetProvider: 'anthropic',
      targetModel: 'claude-3-7-sonnet',
      expectedEffort: 'high',
      expectedVariant: 'thinking',
      expectedAgent: 'writer-subagent',
      expectedRevision: 1,
      expectedApprovalDigest: DUMMY_APPROVAL_DIGEST,
      expectedCalibrationEvidenceDigest: DUMMY_CALIBRATION_DIGEST,
      expectedExecutableIdentityDigest: DUMMY_EXEC_DIGEST,
      expectedPolicyDigest: policyDigest,
    },
  });
  assert.equal(validRes.eligible, true);

  // Selection mismatches
  const badModel = evaluateModelRoleEligibility({
    task,
    binding,
    selection: { targetModel: 'gpt-4o' },
  });
  assert.equal(badModel.eligible, false);
  assert.ok(badModel.violations.some((v) => v.code === EVALUATION_VIOLATIONS.SELECTION_MODEL_MISMATCH));

  const badEffort = evaluateModelRoleEligibility({
    task,
    binding,
    selection: { expectedEffort: 'low' },
  });
  assert.equal(badEffort.eligible, false);
  assert.ok(badEffort.violations.some((v) => v.code === EVALUATION_VIOLATIONS.SELECTION_EFFORT_MISMATCH));

  const badVariant = evaluateModelRoleEligibility({
    task,
    binding,
    selection: { expectedVariant: 'standard' },
  });
  assert.equal(badVariant.eligible, false);
  assert.ok(badVariant.violations.some((v) => v.code === EVALUATION_VIOLATIONS.SELECTION_VARIANT_MISMATCH));

  const badAgent = evaluateModelRoleEligibility({
    task,
    binding,
    selection: { expectedAgent: 'other-agent' },
  });
  assert.equal(badAgent.eligible, false);
  assert.ok(badAgent.violations.some((v) => v.code === EVALUATION_VIOLATIONS.SELECTION_AGENT_MISMATCH));

  const badRevision = evaluateModelRoleEligibility({
    task,
    binding,
    selection: { expectedRevision: 99 },
  });
  assert.equal(badRevision.eligible, false);
  assert.ok(badRevision.violations.some((v) => v.code === EVALUATION_VIOLATIONS.SELECTION_REVISION_MISMATCH));

  const badApprovalDigest = evaluateModelRoleEligibility({
    task,
    binding,
    selection: { expectedApprovalDigest: 'sha256:' + '9'.repeat(64) }, // contentos:allow
  });
  assert.equal(badApprovalDigest.eligible, false);
  assert.ok(badApprovalDigest.violations.some((v) => v.code === EVALUATION_VIOLATIONS.DIGEST_APPROVAL_MISMATCH));
});

test('evaluator: handles explicit ordered fallback, chain index, and forbids downgrade', () => {
  const task = { role: 'writer', assurance: 'code-bounded' };
  const binding = makeBinding();

  // Unapproved fallback
  const unapprovedRes = evaluateModelRoleEligibility({
    task,
    binding,
    selection: { isFallback: true, allowFallback: false },
  });
  assert.equal(unapprovedRes.eligible, false);
  assert.ok(unapprovedRes.violations.some((v) => v.code === EVALUATION_VIOLATIONS.UNAPPROVED_FALLBACK));

  // Approved fallback with assurance downgrade (primary was reasoning-high, candidate is code-bounded)
  const downgradeRes = evaluateModelRoleEligibility({
    task: { role: 'writer', assurance: 'code-bounded' },
    binding,
    selection: {
      isFallback: true,
      allowFallback: true,
      primaryAssurance: 'reasoning-high',
      fallbackChain: ['bind_eval_writer_01'],
    },
  });
  assert.equal(downgradeRes.eligible, false);
  assert.ok(downgradeRes.violations.some((v) => v.code === EVALUATION_VIOLATIONS.FALLBACK_DOWNGRADE_FORBIDDEN));

  // Fallback candidate not in fallbackChain
  const wrongChainRes = evaluateModelRoleEligibility({
    task: { role: 'writer', assurance: 'reasoning-high' },
    binding,
    selection: {
      isFallback: true,
      allowFallback: true,
      primaryAssurance: 'reasoning-high',
      fallbackChain: ['bind_other_01', 'bind_other_02'],
    },
  });
  assert.equal(wrongChainRes.eligible, false);
  assert.ok(wrongChainRes.violations.some((v) => v.code === EVALUATION_VIOLATIONS.UNAPPROVED_FALLBACK));

  // Fallback candidate matches chain and position
  const validFallback = evaluateModelRoleEligibility({
    task: { role: 'writer', assurance: 'reasoning-high' },
    binding,
    selection: {
      isFallback: true,
      allowFallback: true,
      primaryAssurance: 'reasoning-high',
      fallbackChain: ['bind_other_01', 'bind_eval_writer_01'],
      fallbackIndex: 1,
    },
  });
  assert.equal(validFallback.eligible, true);
});

test('evaluator: strictly denies coordinator self-accept', () => {
  const binding = makeBinding({
    eligibleRoles: ['coordinator'],
    deniedRoles: [],
  });

  const task = {
    role: 'coordinator',
    assurance: 'reasoning-high',
    isFinalAcceptance: true,
  };

  const res = evaluateModelRoleEligibility({ task, binding });
  assert.equal(res.eligible, false);
  assert.ok(res.violations.some((v) => v.code === EVALUATION_VIOLATIONS.COORDINATOR_SELF_ACCEPT_FORBIDDEN));
});

test('evaluator: enforces fresh read-only release-final no-write-root for final-auditor', () => {
  const auditorBinding = makeAuditorBinding();
  const priorLineage = [
    { role: 'coordinator', model: 'claude-3-7-sonnet', provider: 'anthropic', bindingId: 'bind_coord_01' },
    { role: 'writer', model: 'claude-3-7-sonnet', provider: 'anthropic', bindingId: 'bind_writer_01' },
  ];

  // Non-release-final assurance
  const res1 = evaluateModelRoleEligibility({
    task: { role: 'final-auditor', assurance: 'code-bounded', readOnly: true, writeRoot: false, freshSession: true },
    binding: auditorBinding,
    lineage: priorLineage,
  });
  assert.equal(res1.eligible, false);
  assert.ok(res1.violations.some((v) => v.code === EVALUATION_VIOLATIONS.FINAL_AUDITOR_ASSURANCE_REQUIRED));

  // Write root requested
  const res2 = evaluateModelRoleEligibility({
    task: { role: 'final-auditor', assurance: 'release-final', writeRoot: true, readOnly: true, freshSession: true },
    binding: auditorBinding,
    lineage: priorLineage,
  });
  assert.equal(res2.eligible, false);
  assert.ok(res2.violations.some((v) => v.code === EVALUATION_VIOLATIONS.FINAL_AUDITOR_WRITE_ROOT_FORBIDDEN));

  // Reused dirty session
  const res3 = evaluateModelRoleEligibility({
    task: { role: 'final-auditor', assurance: 'release-final', readOnly: true, writeRoot: false, freshSession: false },
    binding: auditorBinding,
    lineage: priorLineage,
  });
  assert.equal(res3.eligible, false);
  assert.ok(res3.violations.some((v) => v.code === EVALUATION_VIOLATIONS.FINAL_AUDITOR_FRESH_SESSION_REQUIRED));
});

test('evaluator: enforces contributor-disjoint lineage and fails closed on empty or missing lineage', () => {
  const auditorBinding = makeAuditorBinding({
    bindingId: 'bind_shared_01',
    model: 'claude-3-7-sonnet',
    provider: 'anthropic',
  });

  const task = {
    role: 'final-auditor',
    assurance: 'release-final',
    readOnly: true,
    writeRoot: false,
    freshSession: true,
  };

  // Missing lineage must not prove final-auditor independence
  const resEmpty = evaluateModelRoleEligibility({
    task,
    binding: auditorBinding,
    lineage: [],
  });
  assert.equal(resEmpty.eligible, false);
  assert.ok(resEmpty.violations.some((v) => v.code === EVALUATION_VIOLATIONS.FINAL_AUDITOR_LINEAGE_NOT_DISJOINT));

  // Prior writer used the same model/binding
  const dirtyLineage = [
    { role: 'writer', bindingId: 'bind_shared_01', model: 'claude-3-7-sonnet', provider: 'anthropic' },
  ];

  const resDirty = evaluateModelRoleEligibility({
    task,
    binding: auditorBinding,
    lineage: dirtyLineage,
  });

  assert.equal(resDirty.eligible, false);
  assert.ok(resDirty.violations.some((v) => v.code === EVALUATION_VIOLATIONS.FINAL_AUDITOR_LINEAGE_NOT_DISJOINT));
});

test('evaluator: redaction safety ensures violation messages do not echo secrets or raw digests', () => {
  const binding = makeBinding();
  const badSecretDigest = 'sha256:' + 'e'.repeat(64); // contentos:allow

  const res = evaluateModelRoleEligibility({
    task: { role: 'writer', assurance: 'code-bounded' },
    binding,
    selection: {
      expectedApprovalDigest: badSecretDigest,
    },
  });

  assert.equal(res.eligible, false);
  for (const violation of res.violations) {
    assert.equal(violation.message.includes(badSecretDigest), false);
    assert.equal(violation.message.includes('/Users/'), false);
    assert.equal(violation.message.includes('password'), false);
  }
});

test('evaluator: assertModelRoleEligibility throws typed AiCliError on failure', () => {
  const task = { role: 'coordinator', assurance: 'reasoning-high', isFinalAcceptance: true };
  const binding = makeBinding({ eligibleRoles: ['coordinator'], deniedRoles: [] });

  assert.throws(
    () => assertModelRoleEligibility({ task, binding }),
    (err) => {
      assert.equal(err.name, 'AiCliError');
      assert.equal(err.code, 'POLICY_DENIED');
      assert.ok(Array.isArray(err.details?.violations));
      return true;
    },
  );
});

test('evaluator: inputs are immutable and evaluation has no side-effects', () => {
  const task = { role: 'writer', assurance: 'code-bounded' };
  const binding = makeBinding();
  const selection = { targetModel: 'claude-3-7-sonnet' };
  const lineage = [{ role: 'coordinator', model: 'claude-3-7-sonnet', provider: 'anthropic' }];

  const taskCopy = structuredClone(task);
  const bindingCopy = structuredClone(binding);
  const selectionCopy = structuredClone(selection);
  const lineageCopy = structuredClone(lineage);

  evaluateModelRoleEligibility({ task, binding, selection, lineage });

  assert.deepEqual(task, taskCopy);
  assert.deepEqual(binding, bindingCopy);
  assert.deepEqual(selection, selectionCopy);
  assert.deepEqual(lineage, lineageCopy);
});
