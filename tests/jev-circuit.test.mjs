// M2 circuit-breaker tests. Deterministic: time is an injected counter,
// backoff has no jitter, thresholds are explicit constants.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCircuitBreaker,
  shouldRetry,
  backoffMs,
  retryPolicyFor,
  isRetryableCode,
  codeForHttpStatus,
  FAILURE_THRESHOLD,
  COOLDOWN_MS,
} from '../src/jev/circuit.mjs';

function controlledClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('breaker starts closed and reports constants', () => {
  const clock = controlledClock();
  const breaker = createCircuitBreaker({ now: clock.now });
  assert.equal(breaker.state, 'closed');
  assert.equal(breaker.canTry(), true);
  assert.equal(breaker.isOpen(), false);
  assert.equal(breaker.failureThreshold, FAILURE_THRESHOLD);
  assert.equal(breaker.cooldownMs, COOLDOWN_MS);
});

test('bounded failures open the circuit at the threshold', () => {
  const clock = controlledClock();
  const breaker = createCircuitBreaker({ now: clock.now });
  for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
    breaker.recordFailure({ code: 'JEV_RATE_LIMITED' });
    assert.equal(breaker.state, 'closed', `failure ${i + 1} must stay closed`);
  }
  breaker.recordFailure({ code: 'JEV_RATE_LIMITED' });
  assert.equal(breaker.state, 'open');
  assert.equal(breaker.isOpen(), true);
  assert.equal(breaker.canTry(), false);
});

test('cooldown moves open to half-open, success closes again', () => {
  const clock = controlledClock();
  const breaker = createCircuitBreaker({ now: clock.now });
  for (let i = 0; i < FAILURE_THRESHOLD; i++) breaker.recordFailure({ code: 'JEV_TIMEOUT' });
  assert.equal(breaker.state, 'open');
  clock.advance(COOLDOWN_MS - 1);
  assert.equal(breaker.state, 'open', 'one ms before cooldown must stay open');
  clock.advance(1);
  assert.equal(breaker.state, 'half-open');
  assert.equal(breaker.canTry(), true);
  breaker.recordSuccess();
  assert.equal(breaker.state, 'closed');
  assert.equal(breaker.failures, 0);
});

test('auth failure trips immediately; validation errors never trip', () => {
  const clock = controlledClock();
  const breaker = createCircuitBreaker({ now: clock.now });
  breaker.recordFailure({ code: 'JEV_AUTH_FAILED' });
  assert.equal(breaker.state, 'open');

  const second = createCircuitBreaker({ now: clock.now });
  second.recordFailure({ code: 'JEV_REQUEST_INVALID' });
  second.recordFailure({ code: 'JEV_RESPONSE_INVALID' });
  second.recordFailure({ code: 'JEV_CONFIG_MISSING' });
  assert.equal(second.state, 'closed');
  assert.equal(second.failures, 0);
});

test('half-open failure re-opens deterministically', () => {
  const clock = controlledClock();
  const breaker = createCircuitBreaker({ now: clock.now });
  for (let i = 0; i < FAILURE_THRESHOLD; i++) breaker.recordFailure({ code: 'JEV_OVERLOADED' });
  clock.advance(COOLDOWN_MS);
  assert.equal(breaker.state, 'half-open');
  breaker.recordFailure({ code: 'JEV_OVERLOADED' });
  assert.equal(breaker.state, 'open');
});

test('backoff table is deterministic with no jitter', () => {
  assert.deepEqual([backoffMs(0), backoffMs(1), backoffMs(2), backoffMs(9)], [200, 500, 500, 500]);
});

test('shouldRetry honours frozen semantics and the retry budget', () => {
  assert.equal(shouldRetry('JEV_RATE_LIMITED', 0, 1), true);
  assert.equal(shouldRetry('JEV_RATE_LIMITED', 1, 1), false);
  assert.equal(shouldRetry('JEV_TIMEOUT', 0, 2), true);
  assert.equal(shouldRetry('JEV_AUTH_FAILED', 0, 5), false);
  assert.equal(shouldRetry('JEV_RESPONSE_INVALID', 0, 5), false);
  assert.equal(shouldRetry('JEV_CIRCUIT_OPEN', 0, 5), false);
  assert.equal(shouldRetry('JEV_RATE_LIMITED', 0, 0), false);
});

test('frozen retry semantics cover all 14 taxonomy codes', () => {
  const expected = {
    JEV_CONFIG_MISSING: 'none',
    JEV_AUTH_FAILED: 'none',
    JEV_RATE_LIMITED: 'bounded',
    JEV_OVERLOADED: 'bounded',
    JEV_TIMEOUT: 'bounded',
    JEV_TRANSPORT_FAILED: 'bounded',
    JEV_REQUEST_INVALID: 'none',
    JEV_RESPONSE_INVALID: 'none',
    JEV_MODEL_MISMATCH: 'none',
    JEV_CIRCUIT_OPEN: 'cooldown',
    PROVIDER_STATE_UNINITIALIZED: 'none',
    PROVIDER_NO_ROUTE: 'none',
    PROVIDER_BUSY: 'bounded',
    REVIEW_BLOCKED_PROVIDER_ROUTE: 'none',
  };
  for (const [code, policy] of Object.entries(expected)) {
    assert.equal(retryPolicyFor(code), policy, code);
  }
  assert.equal(isRetryableCode('JEV_RATE_LIMITED'), true);
  assert.equal(isRetryableCode('JEV_AUTH_FAILED'), false);
});

test('http status mapping is indicative per taxonomy', () => {
  assert.equal(codeForHttpStatus(401), 'JEV_AUTH_FAILED');
  assert.equal(codeForHttpStatus(422), 'JEV_REQUEST_INVALID');
  assert.equal(codeForHttpStatus(429), 'JEV_RATE_LIMITED');
  assert.equal(codeForHttpStatus(529), 'JEV_OVERLOADED');
  assert.equal(codeForHttpStatus(504), 'JEV_TIMEOUT');
});

// ---- M2 repair guards ----

// Finding 5: half-open admits exactly one canary probe; later callers wait.
test('finding-5: half-open admits a single probe until it settles', () => {
  const clock = controlledClock();
  const breaker = createCircuitBreaker({ now: clock.now });
  for (let i = 0; i < FAILURE_THRESHOLD; i++) breaker.recordFailure({ code: 'JEV_RATE_LIMITED' });
  assert.equal(breaker.state, 'open');
  clock.advance(COOLDOWN_MS);
  assert.equal(breaker.state, 'half-open');
  assert.equal(breaker.canTry(), true, 'first caller claims the probe');
  assert.equal(breaker.canTry(), false, 'second caller is held back');
  assert.equal(breaker.state, 'half-open', 'held-back callers must not flip the state');
  breaker.recordFailure({ code: 'JEV_TIMEOUT' });
  assert.equal(breaker.state, 'open', 'failed probe re-opens');
  clock.advance(COOLDOWN_MS);
  assert.equal(breaker.canTry(), true, 'a new probe is admitted after the next cooldown');
  breaker.recordSuccess();
  assert.equal(breaker.state, 'closed');
  assert.equal(breaker.canTry(), true);
  assert.equal(breaker.canTry(), true, 'closed circuits admit every caller');
});
