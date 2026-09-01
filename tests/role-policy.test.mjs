import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ALLOWED_POLICY_TOP_LEVEL_FIELDS,
  ALLOWED_ROLE_CONFIG_FIELDS,
  ASSURANCE_RANK,
  CLOSED_ASSURANCES,
  CLOSED_CAPABILITIES,
  CLOSED_ROLES,
  CLOSED_RULES,
  DEFAULT_ROLE_POLICY,
  ROLE_POLICY_SCHEMA,
  canonicalJson,
  computeCanonicalDigest,
  computePolicyDigest,
  deepFreeze,
  isClosedAssurance,
  isClosedCapability,
  isClosedRole,
  validateRolePolicy,
} from '../src/orchestration/role-policy.mjs';
import {
  ALLOWED_AGENT_FIELDS,
  ALLOWED_BINDING_FIELDS,
  MANAGED_BINDING_SCHEMA,
  computeBindingDigest,
  isModelDeterminate,
  isValidDigest,
  validateManagedBinding,
} from '../src/orchestration/managed-binding.mjs';

// Standard mock digests for tests
const DUMMY_CALIBRATION_DIGEST = 'sha256:' + 'a'.repeat(64); // contentos:allow
const DUMMY_APPROVAL_DIGEST = 'sha256:' + 'b'.repeat(64); // contentos:allow
const DUMMY_EXEC_DIGEST = 'sha256:' + 'c'.repeat(64); // contentos:allow

function createValidBinding(overrides = {}) {
  return {
    schema: MANAGED_BINDING_SCHEMA,
    bindingId: 'bind_test_writer_01',
    adapterId: 'adapter_gemini_01',
    provider: 'google-ai',
    model: 'gemini-2.5-pro',
    effort: 'high',
    variant: 'default',
    agent: 'writer-agent',
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

test('role-policy: closed roles, assurances, capabilities and rules are strictly defined', () => {
  assert.equal(ROLE_POLICY_SCHEMA, 'webmcp-ai-role-policy/1');
  assert.deepEqual(CLOSED_ROLES, [
    'coordinator',
    'writer',
    'task-reviewer',
    'final-auditor',
    'observer',
  ]);
  assert.deepEqual(CLOSED_ASSURANCES, [
    'diagnostic',
    'code-bounded',
    'reasoning-high',
    'release-final',
  ]);
  assert.equal(ASSURANCE_RANK['diagnostic'], 0);
  assert.equal(ASSURANCE_RANK['code-bounded'], 1);
  assert.equal(ASSURANCE_RANK['reasoning-high'], 2);
  assert.equal(ASSURANCE_RANK['release-final'], 3);

  // Closed predicates
  for (const role of CLOSED_ROLES) {
    assert.equal(isClosedRole(role), true);
  }
  assert.equal(isClosedRole('admin'), false);
  assert.equal(isClosedRole('root'), false);
  assert.equal(isClosedRole(''), false);
  assert.equal(isClosedRole(null), false);

  for (const assurance of CLOSED_ASSURANCES) {
    assert.equal(isClosedAssurance(assurance), true);
  }
  assert.equal(isClosedAssurance('sudo'), false);
  assert.equal(isClosedAssurance('low'), false);
  assert.equal(isClosedAssurance(null), false);

  for (const cap of CLOSED_CAPABILITIES) {
    assert.equal(isClosedCapability(cap), true);
  }
  assert.equal(isClosedCapability('arbitrary-exec'), false);
});

test('role-policy: canonical JSON stringifier is deterministic regardless of key insertion order', () => {
  const obj1 = { b: 2, a: 1, c: { z: 26, y: 25 } };
  const obj2 = { c: { y: 25, z: 26 }, a: 1, b: 2 };
  assert.equal(canonicalJson(obj1), '{"a":1,"b":2,"c":{"y":25,"z":26}}');
  assert.equal(canonicalJson(obj2), '{"a":1,"b":2,"c":{"y":25,"z":26}}');
  assert.equal(canonicalJson(obj1), canonicalJson(obj2));

  // Arrays preserve defined sequence
  const arr1 = { list: [3, 1, 2] };
  const arr2 = { list: [3, 1, 2] };
  assert.equal(canonicalJson(arr1), '{"list":[3,1,2]}');
  assert.equal(canonicalJson(arr1), canonicalJson(arr2));

  // Primitives
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(true), 'true');
  assert.equal(canonicalJson(123), '123');
  assert.equal(canonicalJson('hello'), '"hello"');
});

test('role-policy: canonical digest produces deterministic lowercase sha256: hash', () => {
  const digest1 = computeCanonicalDigest({ b: 'test', a: 123 });
  const digest2 = computeCanonicalDigest({ a: 123, b: 'test' });
  assert.equal(digest1, digest2);
  assert.match(digest1, /^sha256:[0-9a-f]{64}$/);

  const policyDigest1 = computePolicyDigest(DEFAULT_ROLE_POLICY);
  const policyDigest2 = computePolicyDigest(structuredClone(DEFAULT_ROLE_POLICY));
  assert.equal(policyDigest1, policyDigest2);
  assert.match(policyDigest1, /^sha256:[0-9a-f]{64}$/);
});

test('role-policy: validates DEFAULT_ROLE_POLICY and role-policy.json parity', () => {
  const validated = validateRolePolicy(DEFAULT_ROLE_POLICY);
  assert.ok(validated);
  assert.ok(Object.isFrozen(validated));

  const jsonRaw = readFileSync(new URL('../src/orchestration/role-policy.json', import.meta.url), 'utf8');
  const jsonParsed = JSON.parse(jsonRaw);
  const validatedJson = validateRolePolicy(jsonParsed);
  assert.ok(validatedJson);

  // Both should have matching digests
  assert.equal(computePolicyDigest(validated), computePolicyDigest(validatedJson));
});

test('role-policy: policy metadata digest rules exclude only digest/revision and preserve other fields', () => {
  const basePolicy = structuredClone(DEFAULT_ROLE_POLICY);
  const baseDigest = computePolicyDigest(basePolicy);

  // Policy with digest, policyDigest, and revision metadata
  const policyWithMetadata = {
    ...basePolicy,
    digest: DUMMY_CALIBRATION_DIGEST,
    policyDigest: DUMMY_APPROVAL_DIGEST,
    revision: 2,
  };

  const validatedWithMetadata = validateRolePolicy(policyWithMetadata);
  const digestWithMetadata = computePolicyDigest(validatedWithMetadata);

  // Digest must be identical because metadata is excluded from policy digest calculation
  assert.equal(digestWithMetadata, baseDigest);

  // Malformed metadata throws validation error
  assert.throws(
    () => validateRolePolicy({ ...basePolicy, digest: 'sha256:MALFORMED_UPPERCASE' + '0'.repeat(44) }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  assert.throws(
    () => validateRolePolicy({ ...basePolicy, revision: -5 }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});

test('role-policy: rejects unknown top-level, role, capability, assurance, and rule fields', () => {
  // Unknown top-level field
  assert.throws(
    () => validateRolePolicy({ ...DEFAULT_ROLE_POLICY, unknownTopLevel: 'invalid' }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  // Unknown role config field
  assert.throws(
    () => validateRolePolicy({
      ...DEFAULT_ROLE_POLICY,
      roles: {
        ...DEFAULT_ROLE_POLICY.roles,
        writer: { ...DEFAULT_ROLE_POLICY.roles.writer, unauthorizedRoleField: true },
      },
    }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  // Unknown capability in role
  assert.throws(
    () => validateRolePolicy({
      ...DEFAULT_ROLE_POLICY,
      roles: {
        ...DEFAULT_ROLE_POLICY.roles,
        writer: { ...DEFAULT_ROLE_POLICY.roles.writer, capabilities: ['write-code', 'unauthorized-capability'] },
      },
    }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  // Duplicate capabilities in role
  assert.throws(
    () => validateRolePolicy({
      ...DEFAULT_ROLE_POLICY,
      roles: {
        ...DEFAULT_ROLE_POLICY.roles,
        writer: { ...DEFAULT_ROLE_POLICY.roles.writer, capabilities: ['write-code', 'write-code'] },
      },
    }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  // Duplicate assurances in role
  assert.throws(
    () => validateRolePolicy({
      ...DEFAULT_ROLE_POLICY,
      roles: {
        ...DEFAULT_ROLE_POLICY.roles,
        writer: { ...DEFAULT_ROLE_POLICY.roles.writer, allowedAssurances: ['code-bounded', 'code-bounded'] },
      },
    }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  // Unknown assurance config field
  assert.throws(
    () => validateRolePolicy({
      ...DEFAULT_ROLE_POLICY,
      assurances: {
        ...DEFAULT_ROLE_POLICY.assurances,
        diagnostic: { ...DEFAULT_ROLE_POLICY.assurances.diagnostic, extraField: 'bad' },
      },
    }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  // Unknown rule
  assert.throws(
    () => validateRolePolicy({
      ...DEFAULT_ROLE_POLICY,
      rules: {
        ...DEFAULT_ROLE_POLICY.rules,
        unknownRuleName: true,
      },
    }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});

test('role-policy: rejects non-portable material (providers, models, accounts, paths, credentials, prompts)', () => {
  // Prohibited key: provider
  assert.throws(
    () => validateRolePolicy({ ...DEFAULT_ROLE_POLICY, provider: 'openai' }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  // Prohibited key: model
  assert.throws(
    () => validateRolePolicy({ ...DEFAULT_ROLE_POLICY, model: 'gpt-4' }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  // Prohibited key: account
  assert.throws(
    () => validateRolePolicy({ ...DEFAULT_ROLE_POLICY, account: 'org-123' }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  // Prohibited key: credential
  assert.throws(
    () => validateRolePolicy({ ...DEFAULT_ROLE_POLICY, credential: 'secret-val' }), // contentos:allow
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  // Prohibited key: prompt
  assert.throws(
    () => validateRolePolicy({ ...DEFAULT_ROLE_POLICY, prompt: 'You are an agent' }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  // Prohibited value: absolute file path
  assert.throws(
    () => validateRolePolicy({
      ...DEFAULT_ROLE_POLICY,
      roles: {
        ...DEFAULT_ROLE_POLICY.roles,
        writer: {
          ...DEFAULT_ROLE_POLICY.roles.writer,
          notes: '/Users/test/workspace/policy.md',
        },
      },
    }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  // Prohibited value: prompt template
  assert.throws(
    () => validateRolePolicy({
      ...DEFAULT_ROLE_POLICY,
      roles: {
        ...DEFAULT_ROLE_POLICY.roles,
        writer: {
          ...DEFAULT_ROLE_POLICY.roles.writer,
          template: 'Hello {{user_prompt}}',
        },
      },
    }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});

test('managed-binding: validates valid binding and enforces immutability', () => {
  const binding = createValidBinding();
  const validated = validateManagedBinding(binding);
  assert.ok(validated);
  assert.equal(validated.bindingId, 'bind_test_writer_01');
  assert.equal(validated.model, 'gemini-2.5-pro');
  assert.ok(Object.isFrozen(validated));

  const digest = computeBindingDigest(validated);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
});

test('managed-binding: rejects unknown or disallowed fields (strict allowlist)', () => {
  assert.ok(ALLOWED_BINDING_FIELDS.has('bindingId'));
  assert.ok(ALLOWED_BINDING_FIELDS.has('executableIdentityDigest'));

  const badBinding = createValidBinding({ unauthorizedSecretKey: 'should-fail' }); // contentos:allow
  assert.throws(
    () => validateManagedBinding(badBinding),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT' && err.message.includes('unauthorized fields'),
  );
});

test('managed-binding: rejects indeterminate models', () => {
  assert.equal(isModelDeterminate('gemini-2.5-pro'), true);
  assert.equal(isModelDeterminate('claude-3-7-sonnet'), true);
  assert.equal(isModelDeterminate('auto'), false);
  assert.equal(isModelDeterminate('*'), false);
  assert.equal(isModelDeterminate('indeterminate'), false);
  assert.equal(isModelDeterminate(''), false);
  assert.equal(isModelDeterminate(null), false);

  assert.throws(
    () => validateManagedBinding(createValidBinding({ model: 'auto' })),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT' && err.message.includes('determinate non-empty model identifier'),
  );
});

test('managed-binding: fails closed on expired bindings', () => {
  const pastTime = Date.now() - 5000;
  const expiredBinding = createValidBinding({ expiresAt: pastTime });
  assert.throws(
    () => validateManagedBinding(expiredBinding, { now: Date.now() }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT' && err.details?.expired === true,
  );
});

test('managed-binding: rejects malformed and null/zero digests', () => {
  assert.equal(isValidDigest(DUMMY_CALIBRATION_DIGEST), true);
  assert.equal(isValidDigest('sha256:' + '0'.repeat(64)), false); // all-zeros / null digest rejected
  assert.equal(isValidDigest('md5:123'), false);
  assert.equal(isValidDigest('sha256:UPPERCASE' + '0'.repeat(55)), false);

  assert.throws(
    () => validateManagedBinding(createValidBinding({ calibrationEvidenceDigest: 'md5:123' })),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => validateManagedBinding(createValidBinding({ approvalDigest: 'sha256:' + '0'.repeat(64) })),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => validateManagedBinding(createValidBinding({ executableIdentityDigest: 'sha256:UPPERCASE' + '0'.repeat(55) })),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});

test('managed-binding: rejects invalid roles, duplicates, and overlapping eligible/denied roles', () => {
  // Invalid eligible role
  assert.throws(
    () => validateManagedBinding(createValidBinding({ eligibleRoles: ['writer', 'super-admin'] })),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  // Duplicate in eligibleRoles
  assert.throws(
    () => validateManagedBinding(createValidBinding({ eligibleRoles: ['writer', 'writer'] })),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT' && err.message.includes('duplicate'),
  );

  // Duplicate in deniedRoles
  assert.throws(
    () => validateManagedBinding(createValidBinding({ deniedRoles: ['coordinator', 'coordinator'] })),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT' && err.message.includes('duplicate'),
  );

  // Overlapping role in both eligible and denied
  assert.throws(
    () => validateManagedBinding(createValidBinding({
      eligibleRoles: ['writer', 'observer'],
      deniedRoles: ['writer'],
    })),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT' && err.message.includes('disjoint'),
  );
});

test('managed-binding: rejects arbitrary nested agent, capabilities, paths, credentials and prompt material', () => {
  // Structured agent with unauthorized fields
  assert.throws(
    () => validateManagedBinding(createValidBinding({
      agent: { id: 'agent-1', secretToken: 'secret' }, // contentos:allow
    })),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  // Binding with path material
  assert.throws(
    () => validateManagedBinding(createValidBinding({
      agent: { id: 'agent-1', description: '/Users/admin/secret.txt' },
    })),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  // Duplicate capabilities
  assert.throws(
    () => validateManagedBinding(createValidBinding({
      capabilityTier: ['write-code', 'write-code'],
    })),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT' && err.message.includes('duplicate'),
  );
});

test('managed-binding: error messages never interpolate raw untrusted values or secrets', () => {
  const badModel = 'SUPER_SECRET_MODEL_NAME_DO_NOT_LEAK';
  try {
    validateManagedBinding(createValidBinding({ model: 'auto' }));
    assert.fail('Should have thrown');
  } catch (err) {
    assert.equal(err.message.includes('auto'), false);
  }

  try {
    validateManagedBinding(createValidBinding({ schema: 'untrusted-schema-string' }));
    assert.fail('Should have thrown');
  } catch (err) {
    assert.equal(err.message.includes('untrusted-schema-string'), false);
  }
});
