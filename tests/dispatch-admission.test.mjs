import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DISPATCH_ADMISSION_CODES,
  ORCHESTRATION_PROTOCOL,
  TASK_PACKET_PROTOCOL_V1_R2,
  SELECTION_RECEIPT_SCHEMA,
} from '../src/orchestration/constants.mjs';
import {
  DEFAULT_ROLE_POLICY,
  computePolicyDigest,
} from '../src/orchestration/role-policy.mjs';
import {
  MANAGED_BINDING_SCHEMA,
  validateManagedBinding,
} from '../src/orchestration/managed-binding.mjs';
import {
  evaluateDispatchAdmission,
  assertDispatchAdmission,
} from '../src/orchestration/dispatch-admission.mjs';
import {
  validateTaskPacket,
} from '../src/orchestration/contracts.mjs';
import {
  computeContributorDigest,
} from '../src/orchestration/lineage.mjs';
import {
  validateSelectionReceipt,
} from '../src/orchestration/selection-receipt.mjs';
import {
  createSupervisor,
} from '../src/orchestration/supervisor.mjs';
import {
  createTrustedCoordinatorConfig,
} from '../src/orchestration/public-adapters.mjs';
import { requestIpc } from '../src/orchestration/ipc.mjs';
import { readClientCapability } from '../src/orchestration/authority.mjs';
import { resolveOrchestrationRoots } from '../src/orchestration/paths.mjs';

const DUMMY_CALIBRATION_DIGEST = 'sha256:' + '1'.repeat(64); // contentos:allow
const DUMMY_APPROVAL_DIGEST = 'sha256:' + '2'.repeat(64); // contentos:allow
const DUMMY_EXEC_DIGEST = 'sha256:' + '3'.repeat(64); // contentos:allow

function makeBinding(overrides = {}) {
  return {
    schema: MANAGED_BINDING_SCHEMA,
    bindingId: 'bind_test_writer_01',
    adapterId: 'fixture-writer',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    effort: 'high',
    variant: 'thinking',
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

function makeAuditorBinding(overrides = {}) {
  return {
    schema: MANAGED_BINDING_SCHEMA,
    bindingId: 'bind_test_auditor_01',
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

function makeTask(overrides = {}) {
  return {
    packetVersion: TASK_PACKET_PROTOCOL_V1_R2,
    objective: 'Implement admission checks',
    workspace: '/Users/ttcenter/project',
    role: 'writer',
    riskTier: 'medium',
    modelRequirements: {
      minimumAssurance: 'code-bounded',
      requiredCapabilities: ['write-code'],
    },
    rolePolicyRevision: computePolicyDigest(DEFAULT_ROLE_POLICY),
    modelBindingRevision: 1,
    bindingRevision: 1,
    fallbackPolicy: {
      mode: 'explicit-only',
      allowedBindingIds: [],
    },
    independencePolicy: {
      freshSession: false,
      readOnly: false,
      mustNotMatchDispatchIds: [],
      mustNotContributeToLineage: false,
    },
    ...overrides,
  };
}

test('evaluateDispatchAdmission succeeds for matching task, policy, and binding', () => {
  const task = makeTask();
  const binding = makeBinding();
  const result = evaluateDispatchAdmission({
    task,
    policy: DEFAULT_ROLE_POLICY,
    binding,
    selection: { targetProvider: 'anthropic', model: 'claude-3-7-sonnet' },
  });

  assert.equal(result.eligible, true);
  assert.equal(result.canonicalCode, null);
  assert.equal(result.role, 'writer');
  assert.equal(result.assurance, 'code-bounded');
  assert.equal(result.actualModel, 'claude-3-7-sonnet');
  assert.equal(result.violations.length, 0);
});

test('evaluateDispatchAdmission returns AI_ROLE_POLICY_REQUIRED when task is missing or null', () => {
  const result = evaluateDispatchAdmission({ task: null });
  assert.equal(result.eligible, false);
  assert.equal(result.canonicalCode, DISPATCH_ADMISSION_CODES.AI_ROLE_POLICY_REQUIRED);
  assert.equal(result.actualModel, 'indeterminate');
});

test('evaluateDispatchAdmission returns AI_ROLE_POLICY_DIGEST_MISMATCH when rolePolicyRevision mismatches', () => {
  const task = makeTask({ rolePolicyRevision: 999 });
  const binding = makeBinding();
  const policy = { ...DEFAULT_ROLE_POLICY, revision: 1 };
  const result = evaluateDispatchAdmission({
    task,
    policy,
    binding,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.canonicalCode, DISPATCH_ADMISSION_CODES.AI_ROLE_POLICY_DIGEST_MISMATCH);
  assert.ok(result.violations.some((v) => v.code === DISPATCH_ADMISSION_CODES.AI_ROLE_POLICY_DIGEST_MISMATCH));
});

test('evaluateDispatchAdmission returns AI_MODEL_BINDING_UNAVAILABLE when binding is missing for versioned task', () => {
  const task = makeTask();
  const result = evaluateDispatchAdmission({
    task,
    policy: DEFAULT_ROLE_POLICY,
    binding: null,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.canonicalCode, DISPATCH_ADMISSION_CODES.AI_MODEL_BINDING_UNAVAILABLE);
});

test('evaluateDispatchAdmission returns AI_MODEL_ROLE_INELIGIBLE when role is not in eligibleRoles or in deniedRoles', () => {
  const task = makeTask({ role: 'coordinator' });
  const binding = makeBinding({ eligibleRoles: ['writer'], deniedRoles: ['coordinator'] });
  const result = evaluateDispatchAdmission({
    task,
    policy: DEFAULT_ROLE_POLICY,
    binding,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.canonicalCode, DISPATCH_ADMISSION_CODES.AI_MODEL_ROLE_INELIGIBLE);
});

test('evaluateDispatchAdmission returns AI_MODEL_IDENTITY_INDETERMINATE when model is indeterminate', () => {
  const task = makeTask();
  const binding = makeBinding({ model: 'auto' });
  const result = evaluateDispatchAdmission({
    task,
    policy: DEFAULT_ROLE_POLICY,
    binding,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.canonicalCode, DISPATCH_ADMISSION_CODES.AI_MODEL_IDENTITY_INDETERMINATE);
});

test('evaluateDispatchAdmission returns AI_FALLBACK_NOT_AUTHORIZED when fallback is not authorized in policy', () => {
  const task = makeTask({
    fallbackPolicy: {
      allowFallback: false,
    },
  });
  const binding = makeBinding();
  const result = evaluateDispatchAdmission({
    task,
    policy: DEFAULT_ROLE_POLICY,
    binding,
    selection: { isFallback: true },
  });

  assert.equal(result.eligible, false);
  assert.equal(result.canonicalCode, DISPATCH_ADMISSION_CODES.AI_FALLBACK_NOT_AUTHORIZED);
});

test('evaluateDispatchAdmission returns AI_FALLBACK_ASSURANCE_DOWNGRADE when fallback attempts assurance downgrade', () => {
  const task = makeTask({
    modelRequirements: {
      minimumAssurance: 'diagnostic',
    },
    fallbackPolicy: {
      allowFallback: true,
      primaryAssurance: 'code-bounded',
    },
  });
  const binding = makeBinding();
  const result = evaluateDispatchAdmission({
    task,
    policy: DEFAULT_ROLE_POLICY,
    binding,
    selection: { isFallback: true, primaryAssurance: 'code-bounded' },
  });

  assert.equal(result.eligible, false);
  assert.equal(result.canonicalCode, DISPATCH_ADMISSION_CODES.AI_FALLBACK_ASSURANCE_DOWNGRADE);
});

test('evaluateDispatchAdmission returns AI_AUDITOR_NOT_INDEPENDENT when auditor lineage is not disjoint', () => {
  const task = {
    packetVersion: TASK_PACKET_PROTOCOL_V1_R2,
    objective: 'Final audit',
    workspace: '/Users/ttcenter/project',
    role: 'final-auditor',
    riskTier: 'high',
    modelRequirements: {
      minimumAssurance: 'release-final',
      requiredCapabilities: ['audit-release'],
    },
    lineage: ['contributor_writer_01'],
  };
  const binding = makeAuditorBinding({ agent: 'contributor_writer_01' });
  const result = evaluateDispatchAdmission({
    task,
    policy: DEFAULT_ROLE_POLICY,
    binding,
    lineage: ['contributor_writer_01'],
  });

  assert.equal(result.eligible, false);
  assert.equal(result.canonicalCode, DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT);
});

test('evaluateDispatchAdmission returns AI_FINAL_AUDITOR_UNAVAILABLE when final auditor binding is unavailable', () => {
  const task = {
    packetVersion: TASK_PACKET_PROTOCOL_V1_R2,
    objective: 'Final audit',
    workspace: '/Users/ttcenter/project',
    role: 'final-auditor',
    riskTier: 'critical',
    modelRequirements: {
      minimumAssurance: 'release-final',
      requiredCapabilities: ['audit-release'],
    },
  };
  const result = evaluateDispatchAdmission({
    task,
    policy: DEFAULT_ROLE_POLICY,
    binding: null,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.canonicalCode, DISPATCH_ADMISSION_CODES.AI_FINAL_AUDITOR_UNAVAILABLE);
});

test('legacy unversioned task passes on legacy observe path without failing closed', () => {
  const legacyTask = {
    objective: 'Legacy task',
    workspace: '/Users/ttcenter/project',
  };
  const result = evaluateDispatchAdmission({
    task: legacyTask,
    policy: DEFAULT_ROLE_POLICY,
    binding: null,
    selection: { targetProvider: 'fixture-adapter', model: 'fixture-model' },
  });

  assert.equal(result.eligible, true);
  assert.equal(result.isLegacy, true);
  assert.equal(result.role, 'observer');
});

test('validateTaskPacket strictly validates versioned packet and rejects unknown fields', () => {
  const valid = validateTaskPacket(makeTask());
  assert.equal(valid.packetVersion, TASK_PACKET_PROTOCOL_V1_R2);
  assert.equal(valid.role, 'writer');
  assert.equal(valid.riskTier, 'medium');
  assert.equal(valid.assurance, 'code-bounded');

  assert.throws(
    () => validateTaskPacket({ ...makeTask(), unknownField: true }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  assert.throws(
    () => validateTaskPacket({ ...makeTask(), role: 'invalid-role' }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  assert.throws(
    () => validateTaskPacket({ ...makeTask(), riskTier: 'ultra-high' }),
    (err) => err.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});

function makeCompleteFixtureWriter(launchFn) {
  const caps = {
    liveEvents: false,
    explicitResume: false,
    externalAttach: false,
    questionChannel: false,
    permissionControl: false,
    sameTurnSteer: false,
    gracefulInterrupt: false,
    preToolGate: false,
    processOwnership: true,
    fileEvents: false,
    testEvents: false,
  };
  return {
    id: 'fixture-writer',
    maturity: 'fixture-only',
    capabilities: caps,
    probe: async () => ({
      adapterId: 'fixture-writer',
      available: true,
      installedVersion: process.version,
      sdkVersion: null,
      maturity: 'fixture-only',
      capabilities: caps,
    }),
    spawn: async () => ({ ok: true }),
    attach: async () => {},
    subscribe: () => ({ unsubscribe: () => {} }),
    readSession: async () => null,
    sendReply: async () => {},
    sendGuidance: async () => {},
    resolvePermission: async () => {},
    interrupt: async () => ({ ok: true, interrupted: true }),
    close: async () => ({ ok: true }),
    sanitize: (x) => x,
    lifecycle: {
      kind: 'owned-process',
      launch: async (context) => {
        if (launchFn) {
          return launchFn(context);
        }
        await context.dispatch?.onSpawned?.({
          pid: process.pid,
          processGroupId: process.pid,
          startIdentity: 'fixture-start-01',
          identityProven: true,
        });
        return {
          ok: true,
          binding: {
            bindingId: context.dispatch?.bindingId ?? 'worker_bind_01',
            processIdentity: {
              pid: process.pid,
              processGroupId: process.pid,
              startIdentity: 'fixture-start-01',
              identityProven: true,
            },
            guaranteeTier: 'owned-process',
          },
          done: Promise.resolve({
            schema: 'webmcp.ai-worker-outcome/v1',
            status: 'success',
            exitCode: 0,
            stdout: '',
            stderr: '',
          }),
        };
      },
      finalize: async () => ({
        ok: true,
        disposition: 'already-exited',
      }),
    },
  };
}

test('Supervisor barrier: persists admitted selection receipt and validates it at verify', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'webmcp-ai-adm-adm-'));
  const git = (...args) => execFileSync('git', ['-C', tmpDir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@local');
  git('config', 'user.name', 'tester');
  writeFileSync(join(tmpDir, 'README.md'), '# seed\n');
  git('add', '-A');
  git('commit', '-qm', 'seed');

  const binding = makeBinding();
  const policy = DEFAULT_ROLE_POLICY;

  const fixtureAdapter = makeCompleteFixtureWriter();

  const trustedConfig = createTrustedCoordinatorConfig({
    allowFixtureDispatch: true,
    confinement: 'disposable-workspace',
    disposableRoot: tmpDir,
  });

  const supervisor = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: tmpDir },
    adapters: [fixtureAdapter],
    trustedCoordinatorConfig: trustedConfig,
    rolePolicy: policy,
    managedBinding: binding,
    verifyDispatch: async ({ taskId, dispatchId }) => ({
      verdict: 'accepted',
      workerClaimMatched: true,
      tests: [],
    }),
  });

  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: tmpDir } });
  const coordinationId = supervisor.coordinationId;
  const coordinationDir = join(roots.stateRoot, 'coordinations', coordinationId);
  const capability = readClientCapability({ coordinationDir });

  const call = async (operation, input) => {
    const res = await requestIpc(
      supervisor.endpoint,
      {
        protocol: ORCHESTRATION_PROTOCOL,
        requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
        coordinationId,
        fenceEpoch: supervisor.fenceEpoch,
        capability,
        operation,
        input,
      },
      { timeoutMs: 10_000 },
    );
    if (!res.ok) {
      const err = new Error(res.error?.message || 'IPC call failed');
      err.code = res.error?.code;
      err.details = res.error?.details;
      throw err;
    }
    return res.result;
  };

  try {
    const taskInput = {
      ...makeTask(),
      adapterId: 'fixture-writer',
      workspace: tmpDir,
    };

    // 1. Create task
    const taskResult = await call('task.create', { packet: taskInput });
    const taskId = taskResult.taskId;

    // 2. Dispatch start with selection
    const dispatchResult = await call('dispatch.start', {
      taskId,
      adapterId: 'fixture-writer',
      selection: {
        targetProvider: 'anthropic',
        model: 'claude-3-7-sonnet',
      },
    });

    const dispatchId = dispatchResult.dispatchId;
    assert.ok(dispatchId.startsWith('disp_'));

    // Wait for outcome and settlement
    await new Promise((r) => setTimeout(r, 100));

    // Verify selection receipt was persisted
    const receiptPath = join(tmpDir, 'coordinations', supervisor.coordinationId, 'selection-receipts', `${dispatchId}.json`);
    assert.ok(existsSync(receiptPath));
    const rawReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(rawReceipt.decision, 'eligible');
    assert.equal(rawReceipt.fallbackDecision, 'none');
    assert.equal(rawReceipt.taskId, taskId);
    assert.equal(rawReceipt.dispatchId, dispatchId);
    validateSelectionReceipt(rawReceipt);

    // Verify dispatch with supervisor dispatch.verify
    const verifyResult = await call('dispatch.verify', {
      taskId,
      dispatchId,
    });
    assert.equal(verifyResult.verdict, 'accepted');
  } finally {
    await supervisor.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Supervisor barrier: persists denied receipt and throws POLICY_DENIED before dispatch creation or launch', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'webmcp-ai-adm-den-'));

  // Incompatible binding: denied role writer
  const binding = makeBinding({ eligibleRoles: ['observer'], deniedRoles: ['writer'] });
  const policy = DEFAULT_ROLE_POLICY;

  let launchCalled = false;
  const fixtureAdapter = makeCompleteFixtureWriter(async () => {
    launchCalled = true;
    throw new Error('Should not be called');
  });

  const trustedConfig = createTrustedCoordinatorConfig({
    allowFixtureDispatch: true,
  });

  const supervisor = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: tmpDir },
    adapters: [fixtureAdapter],
    trustedCoordinatorConfig: trustedConfig,
    rolePolicy: policy,
    managedBinding: binding,
  });

  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: tmpDir } });
  const coordinationId = supervisor.coordinationId;
  const coordinationDir = join(roots.stateRoot, 'coordinations', coordinationId);
  const capability = readClientCapability({ coordinationDir });

  const call = async (operation, input) => {
    const res = await requestIpc(
      supervisor.endpoint,
      {
        protocol: ORCHESTRATION_PROTOCOL,
        requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
        coordinationId,
        fenceEpoch: supervisor.fenceEpoch,
        capability,
        operation,
        input,
      },
      { timeoutMs: 10_000 },
    );
    if (!res.ok) {
      const err = new Error(res.error?.message || 'IPC call failed');
      err.code = res.error?.code;
      err.details = res.error?.details;
      throw err;
    }
    return res.result;
  };

  try {
    const taskInput = {
      ...makeTask({ role: 'writer' }),
      adapterId: 'fixture-writer',
      workspace: tmpDir,
    };

    const taskResult = await call('task.create', { packet: taskInput });
    const taskId = taskResult.taskId;

    await assert.rejects(
      async () => {
        await call('dispatch.start', {
          taskId,
          adapterId: 'fixture-writer',
        });
      },
      (err) => {
        assert.equal(err.code, 'POLICY_DENIED');
        assert.equal(err.details?.code, DISPATCH_ADMISSION_CODES.AI_MODEL_ROLE_INELIGIBLE);
        return true;
      },
    );

    assert.equal(launchCalled, false);

    // Verify denied receipt was written
    const receiptsDir = join(tmpDir, 'coordinations', supervisor.coordinationId, 'selection-receipts');
    assert.ok(existsSync(receiptsDir));
    // Exactly one receipt exists
    const [file] = readdirSync(receiptsDir);
    const deniedReceipt = JSON.parse(readFileSync(join(receiptsDir, file), 'utf8'));
    assert.equal(deniedReceipt.decision, 'denied');
    assert.equal(deniedReceipt.actualModel, 'indeterminate');
    validateSelectionReceipt(deniedReceipt);
  } finally {
    await supervisor.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R3: evaluateDispatchAdmission enforces final-auditor requirements with trustedLineage', () => {
  const auditorBinding = makeAuditorBinding();
  const validTask = {
    packetVersion: TASK_PACKET_PROTOCOL_V1_R2,
    objective: 'Final audit task',
    workspace: '/Users/ttcenter/project',
    role: 'final-auditor',
    riskTier: 'release',
    modelRequirements: {
      minimumAssurance: 'release-final',
      requiredCapabilities: ['audit-release', 'verify-integrity', 'accept'],
    },
    rolePolicyRevision: computePolicyDigest(DEFAULT_ROLE_POLICY),
    modelBindingRevision: 2,
    bindingRevision: 2,
    fallbackPolicy: {
      mode: 'explicit-only',
      allowedBindingIds: [],
    },
    independencePolicy: {
      readOnly: true,
      freshSession: true,
      mustNotMatchDispatchIds: ['disp_writer_01'],
    },
    allowedWriteRoots: [],
  };

  const writerFacts = {
    role: 'writer',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    agent: 'writer-agent',
    bindingId: 'bind_test_writer_01',
  };
  const trustedWriterRecord = {
    schema: 'webmcp-ai-lineage-record/1',
    taskId: 'task_writer_01',
    dispatchId: 'disp_writer_01',
    role: 'writer',
    riskTier: 'high',
    rolePolicyRevision: 1,
    modelBindingRevision: 1,
    bindingRevision: 1,
    provider: 'anthropic',
    agent: 'writer-agent',
    requestedModel: 'claude-3-7-sonnet',
    model: 'claude-3-7-sonnet',
    bindingId: 'bind_test_writer_01',
    effort: 'high',
    variant: 'thinking',
    sessionFreshness: 'fresh',
    decision: 'eligible',
    contributorDigest: computeContributorDigest(writerFacts),
    receiptDigest: 'sha256:' + 'b'.repeat(64),
    evaluatedAt: '2026-09-02T00:00:00.000Z',
  };

  // 1. Success case: independent auditor with distinct provider/model/binding and explicit fresh session
  const successResult = evaluateDispatchAdmission({
    task: validTask,
    policy: DEFAULT_ROLE_POLICY,
    binding: auditorBinding,
    selection: { targetProvider: 'google-ai', model: 'gemini-2.5-pro', sessionFreshness: 'fresh' },
    trustedLineage: [trustedWriterRecord],
  });
  assert.equal(successResult.eligible, true);
  assert.equal(successResult.canonicalCode, null);
  assert.equal(successResult.role, 'final-auditor');
  assert.equal(successResult.assurance, 'release-final');
  assert.equal(successResult.sessionFreshness, 'fresh');

  // 1b. Reject when task policy freshSession=true but selection sessionFreshness is missing
  const missingAttestationResult = evaluateDispatchAdmission({
    task: validTask,
    policy: DEFAULT_ROLE_POLICY,
    binding: auditorBinding,
    selection: { targetProvider: 'google-ai', model: 'gemini-2.5-pro' },
    trustedLineage: [trustedWriterRecord],
  });
  assert.equal(missingAttestationResult.eligible, false);
  assert.equal(missingAttestationResult.canonicalCode, DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT);

  // 1c. Reject when task policy freshSession=true but selection sessionFreshness is unspecified
  const unspecifiedAttestationResult = evaluateDispatchAdmission({
    task: validTask,
    policy: DEFAULT_ROLE_POLICY,
    binding: auditorBinding,
    selection: { targetProvider: 'google-ai', model: 'gemini-2.5-pro', sessionFreshness: 'unspecified' },
    trustedLineage: [trustedWriterRecord],
  });
  assert.equal(unspecifiedAttestationResult.eligible, false);
  assert.equal(unspecifiedAttestationResult.canonicalCode, DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT);

  // 1d. Reject when task policy freshSession=true but selection sessionFreshness is not-required
  const notRequiredAttestationResult = evaluateDispatchAdmission({
    task: validTask,
    policy: DEFAULT_ROLE_POLICY,
    binding: auditorBinding,
    selection: { targetProvider: 'google-ai', model: 'gemini-2.5-pro', sessionFreshness: 'not-required' },
    trustedLineage: [trustedWriterRecord],
  });
  assert.equal(notRequiredAttestationResult.eligible, false);
  assert.equal(notRequiredAttestationResult.canonicalCode, DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT);

  // 1e. Reject when selection sessionFreshness is reused
  const reusedAttestationResult = evaluateDispatchAdmission({
    task: validTask,
    policy: DEFAULT_ROLE_POLICY,
    binding: auditorBinding,
    selection: { targetProvider: 'google-ai', model: 'gemini-2.5-pro', sessionFreshness: 'reused' },
    trustedLineage: [trustedWriterRecord],
  });
  assert.equal(reusedAttestationResult.eligible, false);
  assert.equal(reusedAttestationResult.canonicalCode, DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT);

  // 2. Reject non-fresh session in policy
  const nonFreshResult = evaluateDispatchAdmission({
    task: { ...validTask, independencePolicy: { ...validTask.independencePolicy, freshSession: false } },
    policy: DEFAULT_ROLE_POLICY,
    binding: auditorBinding,
    selection: { targetProvider: 'google-ai', model: 'gemini-2.5-pro', sessionFreshness: 'fresh' },
    trustedLineage: [trustedWriterRecord],
  });
  assert.equal(nonFreshResult.eligible, false);
  assert.equal(nonFreshResult.canonicalCode, DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT);

  // 3. Reject write roots for final-auditor
  const writeRootResult = evaluateDispatchAdmission({
    task: { ...validTask, allowedWriteRoots: ['/Users/ttcenter/project/src'] },
    policy: DEFAULT_ROLE_POLICY,
    binding: auditorBinding,
    selection: { targetProvider: 'google-ai', model: 'gemini-2.5-pro', sessionFreshness: 'fresh' },
    trustedLineage: [trustedWriterRecord],
  });
  assert.equal(writeRootResult.eligible, false);
  assert.equal(writeRootResult.canonicalCode, DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT);

  // 4. Reject candidate matching prior writer in trustedLineage
  const sharedBindingAuditor = makeAuditorBinding({
    bindingId: 'bind_test_writer_01',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
  });
  const sharedResult = evaluateDispatchAdmission({
    task: validTask,
    policy: DEFAULT_ROLE_POLICY,
    binding: sharedBindingAuditor,
    selection: { targetProvider: 'anthropic', model: 'claude-3-7-sonnet', sessionFreshness: 'fresh' },
    trustedLineage: [trustedWriterRecord],
  });
  assert.equal(sharedResult.eligible, false);
  assert.equal(sharedResult.canonicalCode, DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT);

  // 5. Reject candidate matching mustNotMatchDispatchIds
  const matchDispatchResult = evaluateDispatchAdmission({
    task: validTask,
    policy: DEFAULT_ROLE_POLICY,
    binding: auditorBinding,
    selection: { dispatchId: 'disp_writer_01', sessionFreshness: 'fresh' },
    trustedLineage: [trustedWriterRecord],
  });
  assert.equal(matchDispatchResult.eligible, false);
  assert.equal(matchDispatchResult.canonicalCode, DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT);

  // 6. Regression: caller lineage cannot satisfy final-auditor disjointness when trusted lineage is empty
  const callerLineageResult = evaluateDispatchAdmission({
    task: validTask,
    policy: DEFAULT_ROLE_POLICY,
    binding: auditorBinding,
    selection: { targetProvider: 'google-ai', model: 'gemini-2.5-pro', sessionFreshness: 'fresh' },
    lineage: [{
      role: 'writer',
      model: 'claude-3-7-sonnet',
      provider: 'anthropic',
      bindingId: 'bind_test_writer_01',
      agentId: 'writer-agent',
    }],
    trustedLineage: [],
  });
  assert.equal(callerLineageResult.eligible, false);
  assert.equal(callerLineageResult.canonicalCode, DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT);
});

test('R3: Supervisor maintains lineage-index.json and revalidates it at verify', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'webmcp-ai-r3-sup-'));
  const git = (...args) => execFileSync('git', ['-C', tmpDir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@local');
  git('config', 'user.name', 'tester');
  writeFileSync(join(tmpDir, 'README.md'), '# seed\n');
  git('add', '-A');
  git('commit', '-qm', 'seed');

  const binding = makeBinding();
  const policy = DEFAULT_ROLE_POLICY;
  const fixtureAdapter = makeCompleteFixtureWriter();

  const trustedConfig = createTrustedCoordinatorConfig({
    allowFixtureDispatch: true,
    confinement: 'disposable-workspace',
    disposableRoot: tmpDir,
  });

  const supervisor = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: tmpDir },
    adapters: [fixtureAdapter],
    trustedCoordinatorConfig: trustedConfig,
    rolePolicy: policy,
    managedBinding: binding,
    verifyDispatch: async () => ({
      verdict: 'accepted',
      workerClaimMatched: true,
      tests: [],
    }),
  });

  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: tmpDir } });
  const coordinationId = supervisor.coordinationId;
  const coordinationDir = join(roots.stateRoot, 'coordinations', coordinationId);
  const capability = readClientCapability({ coordinationDir });

  const call = async (operation, input) => {
    const res = await requestIpc(
      supervisor.endpoint,
      {
        protocol: ORCHESTRATION_PROTOCOL,
        requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
        coordinationId,
        fenceEpoch: supervisor.fenceEpoch,
        capability,
        operation,
        input,
      },
      { timeoutMs: 10_000 },
    );
    if (!res.ok) {
      const err = new Error(res.error?.message || 'IPC call failed');
      err.code = res.error?.code;
      err.details = res.error?.details;
      throw err;
    }
    return res.result;
  };

  try {
    const taskInput = {
      ...makeTask(),
      adapterId: 'fixture-writer',
      workspace: tmpDir,
    };

    const taskResult = await call('task.create', { packet: taskInput });
    const taskId = taskResult.taskId;

    const dispatchResult = await call('dispatch.start', {
      taskId,
      adapterId: 'fixture-writer',
      selection: {
        targetProvider: 'anthropic',
        model: 'claude-3-7-sonnet',
      },
    });

    const dispatchId = dispatchResult.dispatchId;
    await new Promise((r) => setTimeout(r, 100));

    // Verify lineage-index.json exists and contains record for this dispatch
    const lineageIndexPath = join(coordinationDir, 'lineage-index.json');
    assert.ok(existsSync(lineageIndexPath), 'lineage-index.json must exist');
    const lineageIndex = JSON.parse(readFileSync(lineageIndexPath, 'utf8'));
    assert.equal(lineageIndex.schema, 'webmcp-ai-lineage-index/1');
    assert.ok(lineageIndex.records.some((r) => r.dispatchId === dispatchId));

    // Verify dispatch.verify revalidates lineage and selection receipt
    const verifyResult = await call('dispatch.verify', { taskId, dispatchId });
    assert.equal(verifyResult.verdict, 'accepted');
  } finally {
    await supervisor.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
