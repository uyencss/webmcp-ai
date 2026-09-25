import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decideFallback, cohortMembership } from '../src/jev/policy/policy.mjs';
import { wireFallbackPolicy, wireSuccessPolicy, runQuery, runJevCli } from '../src/jev/cli.mjs';
import { resolveRolloutConfig } from '../src/jev/policy/rollout.mjs';
import { buildFallback } from '../src/jev/fallback.mjs';
import { validateFallback, validateResult } from '../src/jev/schemas.mjs';
import { typedError } from '../src/jev/circuit.mjs';
import { AiCliError } from '../src/errors.mjs';

function baseQueryRequest(overrides = {}) {
  const digest = `sha256:${'00'.repeat(32)}`;
  return {
    schema: 'webmcp-jev-request/1',
    requestId: 'test-query-req-1',
    kind: 'query',
    state: {
      snapshotDigest: digest,
      urlOrigin: 'https://example.test',
      goal: 'Direct query test goal',
      elements: [],
      recentActions: [],
    },
    questionSet: { id: 'query-test', version: 1, digest },
    questions: {
      q1: {
        type: 'choice',
        instructions: { question: 'Is this a test question?' },
        criteria: { yes: null, no: null },
      },
    },
    bounds: { maxStateBytes: 32768, maxQuestions: 8, timeoutMs: 15000, maxRetries: 0 },
    caller: { runId: 'test-run', permitId: null },
    fallbackPolicy: 'normal-agent',
    ...overrides,
  };
}

function baseQueryResult(overrides = {}) {
  const digest = `sha256:${'00'.repeat(32)}`;
  return {
    schema: 'webmcp-jev-result/1',
    requestId: 'test-query-req-1',
    status: 'ok',
    advisoryOnly: true,
    answers: {
      q1: {
        type: 'choice',
        choice: 'yes',
        probabilities: { yes: 1.0, no: 0.0 },
        confidence: 1.0,
      },
    },
    lineage: {
      provider: 'typesafe',
      model: 'jev-1.13.0',
      skillDigest: `sha256:${'00'.repeat(32)}`,
      questionSetDigest: digest,
      stateDigest: digest,
      requestDigest: digest,
    },
    timing: { latencyMs: 15, attempts: 1 },
    usage: { inputTokens: 10, outputTokens: 5 },
    ...overrides,
  };
}

function baseBrowserStepRequest(overrides = {}) {
  const digest = `sha256:${'00'.repeat(32)}`;
  return {
    schema: 'webmcp-jev-request/1',
    requestId: 'test-browser-step-1',
    kind: 'browser-step',
    state: {
      snapshotDigest: digest,
      urlOrigin: 'https://example.test',
      goal: 'Click the submit button',
      elements: [],
      recentActions: [],
    },
    questionSet: { id: 'browser-step', version: 1, digest },
    questions: {
      operation: {
        type: 'choice',
        instructions: { question: 'Choose operation' },
        criteria: { CLICK: null, DONE: null, WAIT: null },
      },
    },
    bounds: { maxStateBytes: 32768, maxQuestions: 8, timeoutMs: 15000, maxRetries: 0 },
    caller: { runId: 'test-run', permitId: 'permit-123' },
    fallbackPolicy: 'normal-agent',
    ...overrides,
  };
}

function baseBrowserStepResult(operation = 'CLICK', overrides = {}) {
  const digest = `sha256:${'00'.repeat(32)}`;
  const probs = { CLICK: 0.0, DONE: 0.0, WAIT: 0.0 };
  if (operation in probs) {
    probs[operation] = 1.0;
  }
  return {
    schema: 'webmcp-jev-result/1',
    requestId: 'test-browser-step-1',
    status: 'ok',
    advisoryOnly: true,
    answers: {
      operation: {
        type: 'choice',
        choice: operation,
        probabilities: probs,
        confidence: 1.0,
      },
    },
    lineage: {
      provider: 'typesafe',
      model: 'jev-1.13.0',
      skillDigest: `sha256:${'00'.repeat(32)}`,
      questionSetDigest: digest,
      stateDigest: digest,
      requestDigest: digest,
    },
    timing: { latencyMs: 20, attempts: 1 },
    usage: { inputTokens: 20, outputTokens: 10 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Identity spot-checks
// ---------------------------------------------------------------------------

test('spot-check: origin deny produces ORIGIN_NOT_ALLOWLISTED', () => {
  const res = decideFallback({
    kind: 'browser-step',
    fallbackPolicy: 'normal-agent',
    flags: { origins: { 'https://allowed.test': true } },
    urlOrigin: 'https://disallowed.test',
  });
  assert.equal(res.engine, 'normal-agent');
  assert.equal(res.reason, 'ORIGIN_NOT_ALLOWLISTED');
  assert.equal(res.state, 'FALLBACK_NORMAL_AGENT');
});

test('spot-check: tiktok clamp escalates to human with tiktok-hitl risk cause', () => {
  const res = decideFallback({
    kind: 'captcha-next-step',
    fallbackPolicy: 'deterministic',
    captchaKind: 'tiktok',
    failure: 'JEV_AUTH_FAILED',
  });
  assert.equal(res.engine, 'human');
  assert.equal(res.reason, 'POLICY_CAPTCHA_HUMAN_REQUIRED');
  assert.equal(res.state, 'HUMAN_REQUIRED');
  assert.equal(res.policy.riskCause, 'tiktok-hitl');
  assert.equal(res.policy.humanRequired, true);
});

test('spot-check: cross-kind mismatch with solverKindMap raises SOLVER_KIND_MISMATCH', () => {
  const solverKindMapFixture = {
    recaptcha_v2: ['recaptcha_v2'],
    turnstile: ['turnstile'],
  };
  const res = decideFallback({
    kind: 'captcha-next-step',
    fallbackPolicy: 'deterministic',
    captchaKind: 'turnstile',
    solverId: 'recaptcha_v2',
    policy: { solverKindMap: solverKindMapFixture },
    failure: 'JEV_AUTH_FAILED',
  });
  assert.equal(res.engine, 'human');
  assert.equal(res.reason, 'SOLVER_KIND_MISMATCH');
  assert.equal(res.state, 'HUMAN_REQUIRED');
});

test('spot-check: cohort out-of-scope routes to COHORT_OUT_OF_SCOPE', () => {
  const membership = cohortMembership({
    key: 'user-out-of-scope-1',
    config: { environment: 'local', percent: 5 },
  });
  assert.equal(membership.inCohort, false);
  const res = decideFallback({
    kind: 'browser-step',
    fallbackPolicy: 'normal-agent',
    cohort: { key: 'user-out-of-scope-1', config: { environment: 'local', percent: 5 } },
  });
  assert.equal(res.engine, 'normal-agent');
  assert.equal(res.reason, 'COHORT_OUT_OF_SCOPE');
  assert.equal(res.state, 'FALLBACK_NORMAL_AGENT');
});

// ---------------------------------------------------------------------------
// 2. Env kill-switch and disabled flag wiring
// ---------------------------------------------------------------------------

test('env wiring: JEV_FAST_PATH_DISABLED=1 activates kill switch', () => {
  const req = baseQueryRequest();
  const rawFallback = buildFallback({ request: req, reason: 'JEV_TIMEOUT', circuit: 'closed' });
  const error = typedError('JEV_TIMEOUT', 'timeout expired', { fallback: rawFallback });

  const { typed, policyEvaluation } = wireFallbackPolicy({
    request: req,
    error,
    circuit: 'closed',
    env: { JEV_FAST_PATH_DISABLED: '1' },
  });

  assert.equal(policyEvaluation.reason, 'JEV_FAST_PATH_DISABLED');
  assert.equal(policyEvaluation.engine, 'blocked');
  assert.equal(typed.details.policyEvaluation.reason, 'JEV_FAST_PATH_DISABLED');
});

test('env wiring: JEV_ENABLED=false disables jev fast path', () => {
  const req = baseQueryRequest();
  const rawFallback = buildFallback({ request: req, reason: 'JEV_TIMEOUT', circuit: 'closed' });
  const error = typedError('JEV_TIMEOUT', 'timeout expired', { fallback: rawFallback });

  const { typed, policyEvaluation } = wireFallbackPolicy({
    request: req,
    error,
    circuit: 'closed',
    env: { JEV_ENABLED: 'false' },
  });

  assert.equal(policyEvaluation.reason, 'JEV_DISABLED_BY_FLAG');
  assert.equal(policyEvaluation.engine, 'blocked');
  assert.equal(typed.details.policyEvaluation.reason, 'JEV_DISABLED_BY_FLAG');
});

// ---------------------------------------------------------------------------
// 3. M6-over-M2 override
// ---------------------------------------------------------------------------

test('override: M6 verdict overrides M2 directive decisionEngine when they disagree', () => {
  const req = baseQueryRequest({ fallbackPolicy: 'normal-agent' });
  const m2Fallback = buildFallback({ request: req, reason: 'JEV_TIMEOUT', circuit: 'closed' });
  assert.equal(m2Fallback.decisionEngine, 'normal-agent');

  const error = typedError('JEV_TIMEOUT', 'timeout expired', { fallback: { ...m2Fallback } });

  // With kill switch, M6 returns engine 'blocked'
  const { typed, policyEvaluation } = wireFallbackPolicy({
    request: req,
    error,
    circuit: 'closed',
    env: { JEV_FAST_PATH_DISABLED: '1' },
  });

  assert.equal(policyEvaluation.engine, 'blocked');
  // M6 verdict MUST win for the emitted decisionEngine
  assert.equal(typed.details.fallback.decisionEngine, 'blocked');
  assert.equal(typed.details.policyEvaluation.engine, 'blocked');
});

test('override: agreement leaves decisionEngine intact', () => {
  const req = baseQueryRequest({ fallbackPolicy: 'normal-agent' });
  const m2Fallback = buildFallback({ request: req, reason: 'JEV_CIRCUIT_OPEN', circuit: 'open' });
  assert.equal(m2Fallback.decisionEngine, 'normal-agent');

  const error = typedError('JEV_CIRCUIT_OPEN', 'circuit open', { fallback: { ...m2Fallback } });

  const { typed, policyEvaluation } = wireFallbackPolicy({
    request: req,
    error,
    circuit: 'open',
    env: {},
  });

  assert.equal(policyEvaluation.engine, 'normal-agent');
  assert.equal(typed.details.fallback.decisionEngine, 'normal-agent');
});

// ---------------------------------------------------------------------------
// 4. Frozen-shape preservation of the emitted directive
// ---------------------------------------------------------------------------

test('frozen shape: emitted fallback strictly preserves webmcp-jev-fallback/1 schema', () => {
  const req = baseQueryRequest();
  const m2Fallback = buildFallback({ request: req, reason: 'JEV_TIMEOUT', circuit: 'closed' });
  const error = typedError('JEV_TIMEOUT', 'timeout expired', { fallback: { ...m2Fallback } });

  const { typed, policyEvaluation } = wireFallbackPolicy({
    request: req,
    error,
    circuit: 'closed',
    env: { JEV_FAST_PATH_DISABLED: '1' },
  });

  // Must validate with the frozen M2 validator without error
  assert.doesNotThrow(() => validateFallback(typed.details.fallback));

  // Exactly the 8 frozen fields, no extra fields
  const frozenFields = ['circuit', 'decisionEngine', 'reason', 'requestId', 'retryable', 'schema', 'stateDigest', 'status'];
  assert.deepEqual(Object.keys(typed.details.fallback).sort(), frozenFields);

  // Schema name unchanged
  assert.equal(typed.details.fallback.schema, 'webmcp-jev-fallback/1');

  // policyEvaluation diagnostic attached to error.details, NOT polluting fallback
  assert.ok(typed.details.policyEvaluation);
  assert.equal(typed.details.fallback.policyEvaluation, undefined);
  assert.equal(policyEvaluation.schema, 'webmcp-runner-jev-fallback/1');
});

// ---------------------------------------------------------------------------
// 5. End-to-end query failure execution via CLI
// ---------------------------------------------------------------------------

test('cli query e2e: failure path outputs error and policyEvaluation to stderr', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'jev-m6-e2e-'));
  const reqFile = join(tempDir, 'req.json');
  const keyFile = join(tempDir, 'key.txt');
  try {
    writeFileSync(reqFile, JSON.stringify(baseQueryRequest()));
    writeFileSync(keyFile, 'test-secret-key-12345\n', { mode: 0o600 });

    const stderrChunks = [];
    const origStderr = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    };

    let exitCode;
    try {
      exitCode = await runQuery(
        ['--request', reqFile, '--key-file', keyFile, '--base-url', 'https://typesafe.test/jev'],
        {
          env: { JEV_FAST_PATH_DISABLED: '1' },
          transport: async () => ({ status: 504, body: '{}' }),
        }
      );
    } finally {
      process.stderr.write = origStderr;
    }

    assert.equal(exitCode, 1);
    const combinedStderr = stderrChunks.join('');
    assert.match(combinedStderr, /JEV_TIMEOUT:/);
    assert.match(combinedStderr, /"policyEvaluation":/);
    assert.match(combinedStderr, /"JEV_FAST_PATH_DISABLED"/);

    // Verify JSON line parseability
    const jsonLine = stderrChunks.map((c) => c.trim()).find((c) => c.startsWith('{"policyEvaluation":'));
    assert.ok(jsonLine, 'must emit a JSON line on stderr for policyEvaluation');
    const parsed = JSON.parse(jsonLine);
    assert.equal(parsed.policyEvaluation.reason, 'JEV_FAST_PATH_DISABLED');
    assert.equal(parsed.policyEvaluation.engine, 'blocked');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Rollout config resolution, precedence & defaults
// ---------------------------------------------------------------------------

test('rollout config: defaults applied when file and env are absent', () => {
  const { flags, cohort } = resolveRolloutConfig({ env: {} });
  assert.equal(flags.enabled, true);
  assert.equal(flags.killSwitch, false);
  assert.equal(flags.capabilities, undefined);
  assert.equal(flags.origins, undefined);
  assert.equal(cohort, null);
});

test('rollout config: env vars take effect when file is absent', () => {
  const disabled = resolveRolloutConfig({ env: { JEV_FAST_PATH_DISABLED: '1' } });
  assert.equal(disabled.flags.killSwitch, true);
  assert.equal(disabled.flags.enabled, true);

  const notEnabled = resolveRolloutConfig({ env: { JEV_ENABLED: 'false' } });
  assert.equal(notEnabled.flags.enabled, false);
  assert.equal(notEnabled.flags.killSwitch, false);
});

test('rollout config: file at JEV_ROLLOUT_CONFIG loads flags and cohort', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'jev-rollout-'));
  const configFile = join(tempDir, 'rollout.json');
  try {
    writeFileSync(configFile, JSON.stringify({
      flags: {
        enabled: true,
        killSwitch: false,
        origins: { 'https://allowed.test': true },
        capabilities: { query: true, 'browser-step': false },
      },
      cohort: {
        key: 'user-cohort-1',
        config: { environment: 'local', percent: 25, authorizationId: 'auth-123' },
      },
    }));

    const { flags, cohort } = resolveRolloutConfig({ env: { JEV_ROLLOUT_CONFIG: configFile } });
    assert.equal(flags.enabled, true);
    assert.equal(flags.killSwitch, false);
    assert.deepEqual(flags.origins, { 'https://allowed.test': true });
    assert.deepEqual(flags.capabilities, { query: true, 'browser-step': false });
    assert.equal(cohort.key, 'user-cohort-1');
    assert.equal(cohort.config.percent, 25);
    assert.equal(cohort.config.authorizationId, 'auth-123');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rollout precedence: explicit file overrides env vars', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'jev-rollout-prec-'));
  const configFile = join(tempDir, 'rollout.json');
  try {
    writeFileSync(configFile, JSON.stringify({
      flags: {
        enabled: true,
        killSwitch: false,
      },
    }));

    // File says killSwitch: false, env says JEV_FAST_PATH_DISABLED: 1 -> file precedence wins!
    const res = resolveRolloutConfig({
      env: {
        JEV_ROLLOUT_CONFIG: configFile,
        JEV_FAST_PATH_DISABLED: '1',
      },
    });
    assert.equal(res.flags.killSwitch, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rollout precedence: file omitting a flag allows env var to govern', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'jev-rollout-prec2-'));
  const configFile = join(tempDir, 'rollout.json');
  try {
    writeFileSync(configFile, JSON.stringify({
      flags: {
        enabled: true,
        origins: { 'https://example.test': true },
      },
    }));

    // File omitted killSwitch, so JEV_FAST_PATH_DISABLED governs
    const res = resolveRolloutConfig({
      env: {
        JEV_ROLLOUT_CONFIG: configFile,
        JEV_FAST_PATH_DISABLED: '1',
      },
    });
    assert.equal(res.flags.killSwitch, true);
    assert.equal(res.flags.enabled, true);
    assert.deepEqual(res.flags.origins, { 'https://example.test': true });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Rollout config strict validation
// ---------------------------------------------------------------------------

test('rollout validation: non-existent file throws typed JEV_CONFIG_INVALID', () => {
  assert.throws(
    () => resolveRolloutConfig({ env: { JEV_ROLLOUT_CONFIG: '/nonexistent/path/rollout.json' } }),
    (err) => {
      assert.ok(err instanceof AiCliError);
      assert.equal(err.code, 'JEV_CONFIG_INVALID');
      return true;
    },
  );
});

test('rollout validation: malformed JSON throws typed JEV_CONFIG_INVALID', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'jev-bad-json-'));
  const configFile = join(tempDir, 'bad.json');
  try {
    writeFileSync(configFile, '{ not valid json');
    assert.throws(
      () => resolveRolloutConfig({ env: { JEV_ROLLOUT_CONFIG: configFile } }),
      (err) => {
        assert.ok(err instanceof AiCliError);
        assert.equal(err.code, 'JEV_CONFIG_INVALID');
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rollout validation: invalid values and unknown keys throw typed JEV_CONFIG_INVALID', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'jev-invalid-cfg-'));
  try {
    const badCases = [
      { content: '[]', name: 'array at top-level' },
      { content: JSON.stringify({ unknownTopKey: 123 }), name: 'unknown top-level key' },
      { content: JSON.stringify({ flags: { unknownFlag: true } }), name: 'unknown flag' },
      { content: JSON.stringify({ flags: { enabled: 'not-bool' } }), name: 'non-boolean enabled' },
      { content: JSON.stringify({ flags: { capabilities: { bogus: true } } }), name: 'unknown capability' },
      { content: JSON.stringify({ flags: { capabilities: { query: 'yes' } } }), name: 'non-boolean capability' },
      { content: JSON.stringify({ flags: { origins: { 'not an origin': true } } }), name: 'invalid origin format' },
      { content: JSON.stringify({ flags: { origins: { 'https://example.test?token=secret': true } } }), name: 'forbidden origin query' },
      { content: JSON.stringify({ cohort: { environment: 'invalid-env', percent: 5 } }), name: 'invalid cohort environment' },
      { content: JSON.stringify({ cohort: { environment: 'local', percent: 50 } }), name: 'invalid cohort percent' },
    ];

    for (const { content, name } of badCases) {
      const file = join(tempDir, 'test.json');
      writeFileSync(file, content);
      assert.throws(
        () => resolveRolloutConfig({ env: { JEV_ROLLOUT_CONFIG: file } }),
        (err) => {
          assert.ok(err instanceof AiCliError, `Expected AiCliError for ${name}`);
          assert.equal(err.code, 'JEV_CONFIG_INVALID', `Expected JEV_CONFIG_INVALID for ${name}`);
          return true;
        },
        `Should throw JEV_CONFIG_INVALID for ${name}`,
      );
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. Success-path guard wiring & fail-safe override
// ---------------------------------------------------------------------------

test('success-path: query success with enabled policy allows execution', () => {
  const req = baseQueryRequest();
  const res = baseQueryResult();
  const { allowed, result, policyEvaluation } = wireSuccessPolicy({
    request: req,
    result: res,
    circuit: 'closed',
    env: {},
  });

  assert.equal(allowed, true);
  assert.equal(result.status, 'ok');
  assert.ok(policyEvaluation);
  assert.equal(policyEvaluation.engine, 'jev');
  assert.equal(policyEvaluation.completionClaim, false);
});

test('success-path override: kill switch blocks execution even if model returned result', () => {
  const req = baseBrowserStepRequest();
  const res = baseBrowserStepResult('CLICK');

  const { allowed, typed, policyEvaluation } = wireSuccessPolicy({
    request: req,
    result: res,
    circuit: 'closed',
    env: { JEV_FAST_PATH_DISABLED: '1' },
  });

  // Policy verdict MUST win
  assert.equal(allowed, false);
  assert.equal(policyEvaluation.engine, 'normal-agent');
  assert.equal(policyEvaluation.reason, 'JEV_FAST_PATH_DISABLED');
  assert.equal(typed.code, 'JEV_FAST_PATH_DISABLED');
  assert.equal(typed.details.policyEvaluation.engine, 'normal-agent');
});

test('success-path override: query kind with kill switch blocks execution as blocked engine', () => {
  const req = baseQueryRequest();
  const res = baseQueryResult();

  const { allowed, typed, policyEvaluation } = wireSuccessPolicy({
    request: req,
    result: res,
    circuit: 'closed',
    env: { JEV_FAST_PATH_DISABLED: '1' },
  });

  assert.equal(allowed, false);
  assert.equal(policyEvaluation.engine, 'blocked');
  assert.equal(policyEvaluation.reason, 'JEV_FAST_PATH_DISABLED');
  assert.equal(typed.code, 'JEV_FAST_PATH_DISABLED');
  assert.equal(typed.details.policyEvaluation.engine, 'blocked');
});

test('success-path override: unpermitted operation class escalates to human and refuses', () => {
  const req = baseBrowserStepRequest();
  const res = baseBrowserStepResult('EVAL_JS');

  const { allowed, typed, policyEvaluation } = wireSuccessPolicy({
    request: req,
    result: res,
    circuit: 'closed',
    env: {},
  });

  assert.equal(allowed, false);
  assert.equal(policyEvaluation.guard.action, 'human');
  assert.equal(policyEvaluation.guard.reason, 'OPERATION_CLASS_NOT_PERMITTED');
  assert.equal(typed.code, 'OPERATION_CLASS_NOT_PERMITTED');
});

test('success-path override: permit denied blocks execution', () => {
  const req = baseBrowserStepRequest();
  const res = baseBrowserStepResult('CLICK');

  const { allowed, typed, policyEvaluation } = wireSuccessPolicy({
    request: req,
    result: res,
    circuit: 'closed',
    env: {},
    permit: { allowed: false, permitId: 'denied-permit' },
  });

  assert.equal(allowed, false);
  assert.equal(policyEvaluation.guard.action, 'blocked');
  assert.equal(policyEvaluation.guard.reason, 'PERMIT_DENIED');
  assert.equal(typed.code, 'PERMIT_DENIED');
});

test('success-path override: origin not allowlisted routes away from jev', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'jev-origin-'));
  const configFile = join(tempDir, 'rollout.json');
  try {
    writeFileSync(configFile, JSON.stringify({
      flags: {
        origins: { 'https://other-allowed.test': true },
      },
    }));

    const req = baseBrowserStepRequest(); // urlOrigin is https://example.test
    const res = baseBrowserStepResult('CLICK');

    const { allowed, typed, policyEvaluation } = wireSuccessPolicy({
      request: req,
      result: res,
      circuit: 'closed',
      env: { JEV_ROLLOUT_CONFIG: configFile },
    });

    assert.equal(allowed, false);
    assert.equal(policyEvaluation.reason, 'ORIGIN_NOT_ALLOWLISTED');
    assert.equal(policyEvaluation.engine, 'normal-agent');
    assert.equal(typed.code, 'ORIGIN_NOT_ALLOWLISTED');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. Completion-signal hook & invariant
// ---------------------------------------------------------------------------

test('completion-signal: DONE stays advisory: diagnostic claim reflects guard (false)', () => {
  const req = baseBrowserStepRequest();
  const res = baseBrowserStepResult('DONE');

  const { allowed, policyEvaluation } = wireSuccessPolicy({
    request: req,
    result: res,
    circuit: 'closed',
    env: {},
  });

  assert.equal(allowed, true);
  // Gate 10 regression: DONE is advisory only; a DONE advisory can never produce
  // completionClaim: true from wireSuccessPolicy. Emitted diagnostic reflects guard (false).
  assert.equal(policyEvaluation.completionClaim, false);
  assert.notEqual(policyEvaluation.completionClaim, true);
  // Hard invariant: guardAction result completionClaim is ALWAYS false
  assert.equal(policyEvaluation.guard.completionClaim, false);
  assert.equal(policyEvaluation.guard.action, 'no-command');
  assert.equal(policyEvaluation.guard.zeroBrowserAction, true);
});

test('completion-signal: non-DONE operations record completionClaim: false', () => {
  const req = baseBrowserStepRequest();
  const resClick = baseBrowserStepResult('CLICK');
  const resWait = baseBrowserStepResult('WAIT');

  const clickEval = wireSuccessPolicy({ request: req, result: resClick, circuit: 'closed', env: {} }).policyEvaluation;
  assert.equal(clickEval.completionClaim, false);
  assert.equal(clickEval.guard.completionClaim, false);

  const waitEval = wireSuccessPolicy({ request: req, result: resWait, circuit: 'closed', env: {} }).policyEvaluation;
  assert.equal(waitEval.completionClaim, false);
  assert.equal(waitEval.guard.completionClaim, false);
});

// ---------------------------------------------------------------------------
// 10. Frozen-shape preservation on success path
// ---------------------------------------------------------------------------

test('frozen shape: success result strictly preserves webmcp-jev-result/1 schema', () => {
  const req = baseQueryRequest();
  const res = baseQueryResult();

  const { allowed, result, policyEvaluation } = wireSuccessPolicy({
    request: req,
    result: res,
    circuit: 'closed',
    env: {},
  });

  assert.equal(allowed, true);
  assert.doesNotThrow(() => validateResult(result, { request: req }));

  // Schema name unchanged
  assert.equal(result.schema, 'webmcp-jev-result/1');

  // Exactly the 8 frozen fields, no extra fields polluting result
  const frozenResultFields = ['advisoryOnly', 'answers', 'lineage', 'requestId', 'schema', 'status', 'timing', 'usage'];
  assert.deepEqual(Object.keys(result).sort(), frozenResultFields);
  assert.equal(result.policyEvaluation, undefined);

  // Diagnostic is attached on policyEvaluation
  assert.ok(policyEvaluation);
  assert.equal(policyEvaluation.guard.schema, 'webmcp-runner-jev-guard/1');
});

// ---------------------------------------------------------------------------
// 11. End-to-end CLI success-path query execution
// ---------------------------------------------------------------------------

test('cli query e2e: success path outputs result to stdout and policyEvaluation to stderr', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'jev-m6-e2e-success-'));
  const reqFile = join(tempDir, 'req.json');
  const keyFile = join(tempDir, 'key.txt');
  try {
    writeFileSync(reqFile, JSON.stringify(baseQueryRequest()));
    writeFileSync(keyFile, 'test-secret-key-12345\n', { mode: 0o600 });

    const stdoutChunks = [];
    const stderrChunks = [];
    const origStdout = process.stdout.write;
    const origStderr = process.stderr.write;
    process.stdout.write = (chunk) => { stdoutChunks.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };

    let exitCode;
    try {
      exitCode = await runQuery(
        ['--request', reqFile, '--key-file', keyFile, '--base-url', 'https://typesafe.test/jev'],
        {
          env: {},
          transport: async () => ({
            status: 200,
            body: JSON.stringify({
              model: 'jev-1.13.0',
              answers: {
                q1: {
                  type: 'choice',
                  choice: 'yes',
                  probabilities: { yes: 1.0, no: 0.0 },
                  confidence: 1.0,
                },
              },
              usage: { input_tokens: 10, output_tokens: 5 },
            }),
          }),
        }
      );
    } finally {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    }

    assert.equal(exitCode, 0);

    // Stdout has valid result JSON
    const parsedStdout = JSON.parse(stdoutChunks.join(''));
    assert.equal(parsedStdout.schema, 'webmcp-jev-result/1');
    assert.equal(parsedStdout.answers.q1.choice, 'yes');

    // Stderr has policyEvaluation diagnostic line
    const jsonLine = stderrChunks.map((c) => c.trim()).find((c) => c.startsWith('{"policyEvaluation":'));
    assert.ok(jsonLine, 'must emit a JSON line on stderr for policyEvaluation');
    const parsed = JSON.parse(jsonLine);
    assert.equal(parsed.policyEvaluation.engine, 'jev');
    assert.equal(parsed.policyEvaluation.completionClaim, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cli query e2e: success path override blocks execution when kill switch is set', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'jev-m6-e2e-kill-'));
  const reqFile = join(tempDir, 'req.json');
  const keyFile = join(tempDir, 'key.txt');
  try {
    writeFileSync(reqFile, JSON.stringify(baseBrowserStepRequest()));
    writeFileSync(keyFile, 'test-secret-key-12345\n', { mode: 0o600 });

    const stdoutChunks = [];
    const stderrChunks = [];
    const origStdout = process.stdout.write;
    const origStderr = process.stderr.write;
    process.stdout.write = (chunk) => { stdoutChunks.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };

    let exitCode;
    try {
      exitCode = await runQuery(
        ['--request', reqFile, '--key-file', keyFile, '--base-url', 'https://typesafe.test/jev'],
        {
          env: { JEV_FAST_PATH_DISABLED: '1' },
          transport: async () => ({
            status: 200,
            body: JSON.stringify({
              model: 'jev-1.13.0',
              answers: {
                operation: {
                  type: 'choice',
                  choice: 'CLICK',
                  probabilities: { CLICK: 1.0, DONE: 0.0, WAIT: 0.0 },
                  confidence: 1.0,
                },
              },
              usage: { input_tokens: 15, output_tokens: 5 },
            }),
          }),
        }
      );
    } finally {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    }

    assert.equal(exitCode, 1);
    // Nothing written to stdout
    assert.equal(stdoutChunks.join('').trim(), '');

    // Stderr contains error and policyEvaluation
    const combinedStderr = stderrChunks.join('');
    assert.match(combinedStderr, /JEV_FAST_PATH_DISABLED:/);
    const jsonLine = stderrChunks.map((c) => c.trim()).find((c) => c.startsWith('{"policyEvaluation":'));
    assert.ok(jsonLine);
    const parsed = JSON.parse(jsonLine);
    assert.equal(parsed.policyEvaluation.engine, 'normal-agent');
    assert.equal(parsed.policyEvaluation.reason, 'JEV_FAST_PATH_DISABLED');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cli query e2e: success path stays advisory: diagnostic claim reflects guard (false) when DONE is selected', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'jev-m6-e2e-done-'));
  const reqFile = join(tempDir, 'req.json');
  const keyFile = join(tempDir, 'key.txt');
  try {
    writeFileSync(reqFile, JSON.stringify(baseBrowserStepRequest()));
    writeFileSync(keyFile, 'test-secret-key-12345\n', { mode: 0o600 });

    const stdoutChunks = [];
    const stderrChunks = [];
    const origStdout = process.stdout.write;
    const origStderr = process.stderr.write;
    process.stdout.write = (chunk) => { stdoutChunks.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };

    let exitCode;
    try {
      exitCode = await runQuery(
        ['--request', reqFile, '--key-file', keyFile, '--base-url', 'https://typesafe.test/jev'],
        {
          env: {},
          transport: async () => ({
            status: 200,
            body: JSON.stringify({
              model: 'jev-1.13.0',
              answers: {
                operation: {
                  type: 'choice',
                  choice: 'DONE',
                  probabilities: { CLICK: 0.0, DONE: 1.0, WAIT: 0.0 },
                  confidence: 1.0,
                },
              },
              usage: { input_tokens: 15, output_tokens: 5 },
            }),
          }),
        }
      );
    } finally {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    }

    assert.equal(exitCode, 0);

    const parsedStdout = JSON.parse(stdoutChunks.join(''));
    assert.equal(parsedStdout.answers.operation.choice, 'DONE');

    const jsonLine = stderrChunks.map((c) => c.trim()).find((c) => c.startsWith('{"policyEvaluation":'));
    assert.ok(jsonLine);
    const parsed = JSON.parse(jsonLine);
    // Gate 10: emitted diagnostic claim reflects guard's verified claim (false); raw DONE is advisory only
    assert.equal(parsed.policyEvaluation.completionClaim, false);
    assert.notEqual(parsed.policyEvaluation.completionClaim, true);
    assert.equal(parsed.policyEvaluation.guard.completionClaim, false);
    assert.equal(parsed.policyEvaluation.guard.action, 'no-command');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
