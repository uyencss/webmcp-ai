// M2 fallback directive builder. Shape is webmcp-jev-fallback/1 exactly.
// This module NEVER touches a browser: no browser imports, no spawn, no
// fetch. It only packages the typed directive so the caller (normal agent,
// deterministic solver, human) can take over with a fresh snapshot.
import { isRetryableCode } from './circuit.mjs';
import { validateFallback } from './schemas.mjs';
import { redactRequest, redactState, stateDigestOf, collectRequestSensitiveValues } from './redact.mjs';

export const FALLBACK_REASONS = Object.freeze([
  'JEV_CONFIG_MISSING',
  'JEV_AUTH_FAILED',
  'JEV_RATE_LIMITED',
  'JEV_OVERLOADED',
  'JEV_TIMEOUT',
  'JEV_TRANSPORT_FAILED',
  'JEV_REQUEST_INVALID',
  'JEV_RESPONSE_INVALID',
  'JEV_MODEL_MISMATCH',
  'JEV_CIRCUIT_OPEN',
  'PROVIDER_STATE_UNINITIALIZED',
  'PROVIDER_NO_ROUTE',
  'PROVIDER_BUSY',
  'REVIEW_BLOCKED_PROVIDER_ROUTE',
]);

// OQ3: fallback reuses the caller-declared fallbackPolicy only — no second
// policy, no silent fallback. abort maps to the frozen `blocked` engine.
export function engineForPolicy(fallbackPolicy) {
  switch (fallbackPolicy) {
    case 'normal-agent':
      return 'normal-agent';
    case 'deterministic':
      return 'deterministic';
    case 'human':
      return 'human';
    case 'abort':
      return 'blocked';
    default:
      return 'blocked';
  }
}

export function reasonToRetryable(reason) {
  return isRetryableCode(reason);
}

export function normalizeErrorToReason(error) {
  const code = error?.code;
  if (typeof code === 'string' && FALLBACK_REASONS.includes(code)) return code;
  return 'JEV_TRANSPORT_FAILED';
}

export function buildFallback({ request, reason, circuit = 'closed', secrets = [] } = {}) {
  if (!request || typeof request !== 'object') throw new Error('buildFallback requires the originating request');
  if (!FALLBACK_REASONS.includes(reason)) throw new Error(`unknown fallback reason ${JSON.stringify(reason)}`);
  if (!['open', 'closed', 'half-open'].includes(circuit)) throw new Error(`unknown circuit state ${JSON.stringify(circuit)}`);
  // Totality claim: buildFallback never throws on a request that passed validateRequest
  // (a malformed requestId still makes validateFallback throw, unreachable from the client).
  // Compute stateDigest on a total path: the page-state projection is total on JSON-shaped input;
  // when the full request projection refuses, no request was sent and digest
  // parity is moot, so project the state and digest that.
  let redactedState;
  try {
    redactedState = redactRequest(request, { secrets }).state;
  } catch {
    const { sensitiveValues } = collectRequestSensitiveValues(request, { secrets });
    const allSecrets = [...new Set([...secrets, ...(sensitiveValues ?? [])])];
    redactedState = redactState(request?.state, { secrets: allSecrets });
  }
  const directive = {
    schema: 'webmcp-jev-fallback/1',
    requestId: request.requestId,
    status: 'fallback-required',
    decisionEngine: engineForPolicy(request.fallbackPolicy),
    reason,
    retryable: reasonToRetryable(reason),
    circuit,
    stateDigest: stateDigestOf(redactedState),
  };
  return validateFallback(directive);
}
