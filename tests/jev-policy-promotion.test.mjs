import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decideFallback, cohortMembership } from '../src/jev/policy/policy.mjs';
import { wireFallbackPolicy, runQuery, runJevCli } from '../src/jev/cli.mjs';
import { buildFallback } from '../src/jev/fallback.mjs';
import { validateFallback } from '../src/jev/schemas.mjs';
import { typedError } from '../src/jev/circuit.mjs';

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
