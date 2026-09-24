// M2 retry policy + circuit breaker. Only the retry semantics
// (none|bounded|cooldown) are frozen (error-taxonomy proposedDefaults are
// proposals); numeric thresholds below are explicit M2 choices and logged.
// Deterministic by construction: time comes from an injected `now` function,
// backoff has no jitter. Engine states mirror plan §4.2:
// JEV_READY / JEV_TRANSIENT_FAILURE / JEV_CIRCUIT_OPEN.
import { AiCliError } from '../errors.mjs';

export const FAILURE_THRESHOLD = 3;
export const COOLDOWN_MS = 30_000;
// Deterministic bounded-retry backoff table (no jitter).
export const BACKOFF_MS = [200, 500];

// Frozen retry semantics per code (taxonomy retryPolicy column).
export const RETRY_POLICY = Object.freeze({
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
});

export const RETRYABLE_CODES = Object.freeze(
  Object.entries(RETRY_POLICY)
    .filter(([, policy]) => policy === 'bounded')
    .map(([code]) => code),
);

export function retryPolicyFor(code) {
  return RETRY_POLICY[code] ?? 'none';
}

export function isRetryableCode(code) {
  return retryPolicyFor(code) === 'bounded';
}

export function backoffMs(attempt) {
  if (!Number.isInteger(attempt) || attempt < 0) return BACKOFF_MS[0];
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

export function shouldRetry(code, attempt, maxRetries) {
  if (retryPolicyFor(code) !== 'bounded') return false;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) return false;
  return attempt < maxRetries;
}

// HTTP/status → taxonomy mapping (indicative per taxonomy httpStatusMapping).
export function codeForHttpStatus(status) {
  if (status === 401) return 'JEV_AUTH_FAILED';
  if (status === 422) return 'JEV_REQUEST_INVALID';
  if (status === 429) return 'JEV_RATE_LIMITED';
  if (status === 529) return 'JEV_OVERLOADED';
  if (status === 504 || status === 408) return 'JEV_TIMEOUT';
  if (typeof status === 'number' && status >= 500) return 'JEV_TRANSPORT_FAILED';
  return 'JEV_TRANSPORT_FAILED';
}

export function typedError(code, message, details) {
  return new AiCliError(code, message, { retryable: isRetryableCode(code), details });
}

export function createCircuitBreaker({ failureThreshold = FAILURE_THRESHOLD, cooldownMs = COOLDOWN_MS, now = () => Date.now() } = {}) {
  let failures = 0;
  let state = 'closed'; // closed | open | half-open
  let openedAt = 0;
  // Half-open admits exactly one canary probe (plan §4.2): the first caller
  // claims the flag via canTry(); later callers see an open circuit until the
  // probe records success or failure, which clears the claim.
  let probeInFlight = false;

  function refresh() {
    if (state === 'open' && now() - openedAt >= cooldownMs) state = 'half-open';
    return state;
  }

  return {
    get state() {
      return refresh();
    },
    get failures() {
      return failures;
    },
    get failureThreshold() {
      return failureThreshold;
    },
    get cooldownMs() {
      return cooldownMs;
    },
    isOpen() {
      return refresh() === 'open';
    },
    // Probe gate: closed always allows; half-open admits exactly one canary
    // probe — the first caller claims it, later callers see an open circuit.
    canTry() {
      if (refresh() === 'open') return false;
      if (refresh() === 'half-open') {
        if (probeInFlight) return false;
        probeInFlight = true;
        return true;
      }
      return true;
    },
    recordSuccess() {
      failures = 0;
      state = 'closed';
      openedAt = 0;
      probeInFlight = false;
    },
    recordFailure(errorOrCode) {
      probeInFlight = false;
      const code = typeof errorOrCode === 'string' ? errorOrCode : errorOrCode?.code;
      // Auth and model-pin violations trip immediately (taxonomy action).
      if (code === 'JEV_AUTH_FAILED' || code === 'JEV_MODEL_MISMATCH') {
        failures = failureThreshold;
        state = 'open';
        openedAt = now();
        return state;
      }
      if (retryPolicyFor(code) === 'bounded') {
        failures += 1;
        if (failures >= failureThreshold) {
          state = 'open';
          openedAt = now();
        }
        return refresh();
      }
      if (code === 'JEV_CIRCUIT_OPEN') {
        state = 'open';
        if (!openedAt) openedAt = now();
        return refresh();
      }
      // Non-retryable validation/config errors do not trip the circuit.
      return refresh();
    },
  };
}
