// M2 TypeSafe HTTP client. Server-side key only (OQ2): the key MUST be
// passed explicitly (mode-0600 file content read by the caller today; a
// vault-broker source is NOT wired in M2 — recorded as an M3 open item).
// This module never reads process.env for secrets — inherited env
// is rejected as a secret channel. Transport is injectable; tests never hit
// the network and no provider binary is ever spawned here.
import { AiCliError } from '../errors.mjs';
import { validateRequest, validateResult, JEV_RESULT_SCHEMA, MODEL_RE } from './schemas.mjs';
import {
  redactRequest,
  collectRequestSensitiveValues,
  digestOf,
  stateDigestOf,
  canonicalJson,
  sha256Hex,
  containsSecret,
  canonicalForMatch,
} from './redact.mjs';
import { createTypesafeTransport, assertSafeBaseUrl, assertKeyNotInBaseUrl } from './transport.mjs';
import {
  createCircuitBreaker,
  shouldRetry,
  backoffMs,
  codeForHttpStatus,
  typedError,
  isRetryableCode,
} from './circuit.mjs';
import { buildFallback, normalizeErrorToReason } from './fallback.mjs';

export const JEV_PROVIDER = 'typesafe';

// Unpinned skill marker: the live API returns no skill digest, so lineage
// carries a format-valid zero digest when no pin is configured. The pin
// check in assertLineage only compares when a digest was configured.
export const JEV_UNPINNED_SKILL_DIGEST = `sha256:${'00'.repeat(32)}`;

// Model validator (round 22): pinned model is a secret channel. It must
// conform to the frozen lineage pattern (^jev-[0-9.]+$) and must not contain
export function assertSafeModel(model, secrets = []) {
  if (typeof model !== 'string' || model.length === 0) {
    throw typedError('JEV_REQUEST_INVALID', 'wire body needs an explicit model');
  }
  if (!MODEL_RE.test(model)) {
    throw typedError('JEV_REQUEST_INVALID', 'model violates the jev format');
  }
  if (containsSecret(model, secrets)) {
    throw typedError('JEV_REQUEST_INVALID', 'model carries a secret');
  }
  const compactModel = canonicalForMatch(model);
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    if (model.includes(secret)) {
      throw typedError('JEV_REQUEST_INVALID', 'model carries a secret');
    }
    const compactSecret = canonicalForMatch(secret);
    if (compactSecret.length > 0 && compactModel.includes(compactSecret)) {
      throw typedError('JEV_REQUEST_INVALID', 'model carries a secret');
    }
  }
}

// Outbound wire adapter (round 14 item 1, round 22 item 3, round 22 revision 2 R2b):
// the live API takes exactly {state, model, questions} and rejects extras.
// It MUST take the redacted envelope — reaching for the raw request would undo
// the redaction rounds. `model` is the pinned model, validated against format
// and secrets before building the body. The secrets option is REQUIRED so the
// caller cannot default to an empty set and bypass secret assertion.
export function toWireBody(redacted, model, options) {
  if (!redacted || typeof redacted !== 'object' || !redacted.state || !redacted.questions) {
    throw typedError('JEV_REQUEST_INVALID', 'wire body needs a redacted state and questions');
  }
  if (!options || !Array.isArray(options.secrets)) {
    throw typedError('JEV_REQUEST_INVALID', 'toWireBody requires an explicit secrets array');
  }
  assertSafeModel(model, options.secrets);
  return { state: redacted.state, model, questions: redacted.questions };
}

function responseInvalid(message) {
  return typedError('JEV_RESPONSE_INVALID', message);
}

function mapApiAnswer(id, answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    throw responseInvalid('typesafe returned a malformed answer envelope');
  }
  // Whitelist per variant: the live API returns fields the frozen internal
  // envelope forbids (score legend/probabilities, noul confidence), so the
  // mapping normalizes shape here and validateResult still enforces values.
  if (answer.type === 'choice') {
    return { type: 'choice', choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence };
  }
  if (answer.type === 'score') {
    return { type: 'score', score: answer.score, confidence: answer.confidence };
  }
  if (answer.type === 'noul') {
    if (typeof answer.noul !== 'string' && typeof answer.noul !== 'number') {
      throw responseInvalid('typesafe noul answer carries no usable value');
    }
    return { type: 'noul', noul: String(answer.noul) };
  }
  throw responseInvalid('typesafe returned an unknown answer type');
}

export function remapAnswers(answers, refMap, newRefToOld = null) {
  if (!answers || typeof answers !== 'object') {
    return answers;
  }
  const reverseMap = (newRefToOld instanceof Map)
    ? newRefToOld
    : ((refMap && refMap.newRefToOld instanceof Map) ? refMap.newRefToOld : null);

  const lookup = reverseMap ?? (() => {
    if (!refMap || !(refMap instanceof Map) || refMap.size === 0) return null;
    const rev = new Map();
    for (const [orig, remapped] of refMap.entries()) {
      if (typeof remapped === 'string' && typeof orig === 'string') {
        rev.set(remapped, orig);
      }
    }
    return rev;
  })();

  if (!lookup || lookup.size === 0) {
    return answers;
  }
  for (const answer of Object.values(answers)) {
    if (!answer || typeof answer !== 'object') continue;
    if (answer.type === 'choice') {
      if (typeof answer.choice === 'string' && lookup.has(answer.choice)) {
        answer.choice = lookup.get(answer.choice);
      }
      if (answer.probabilities && typeof answer.probabilities === 'object' && !Array.isArray(answer.probabilities)) {
        const remappedProbabilities = {};
        for (const [k, v] of Object.entries(answer.probabilities)) {
          const mappedKey = lookup.has(k) ? lookup.get(k) : k;
          remappedProbabilities[mappedKey] = v;
        }
        answer.probabilities = remappedProbabilities;
      }
    }
  }
  return answers;
}

// Inbound wire adapter (round 14 item 1): {model, answers, usage} from the
// live API becomes the internal result envelope. requestId comes from the
// request, lineage digests that the server never echoes are computed
// locally, and timing comes from the client's own measurement. The mapped
// result must pass validateResult — that validator stays the contract for
// everything downstream.
export function toInternalResult(apiBody, {
  request,
  stateDigest,
  requestDigest,
  expectedModel,
  expectedSkillDigest = null,
  latencyMs = 0,
  attempts = 1,
  refMap = null,
  newRefToOld = null,
} = {}) {
  if (!apiBody || typeof apiBody !== 'object' || Array.isArray(apiBody)) {
    throw responseInvalid('typesafe returned a malformed result envelope');
  }
  if (typeof apiBody.model !== 'string' || apiBody.model.length === 0) {
    throw responseInvalid('typesafe result is missing its model');
  }
  if (!apiBody.answers || typeof apiBody.answers !== 'object' || Array.isArray(apiBody.answers)) {
    throw responseInvalid('typesafe result answers must be an object');
  }
  const ids = Object.keys(apiBody.answers);
  if (ids.length === 0) throw responseInvalid('typesafe result answers must not be empty');
  const answers = {};
  for (const [id, answer] of Object.entries(apiBody.answers)) answers[id] = mapApiAnswer(id, answer);
  if (refMap || newRefToOld) remapAnswers(answers, refMap, newRefToOld);
  const inputTokens = apiBody.usage?.input_tokens;
  const outputTokens = apiBody.usage?.output_tokens;
  if (!Number.isInteger(inputTokens) || inputTokens < 0 || !Number.isInteger(outputTokens) || outputTokens < 0) {
    throw responseInvalid('typesafe result usage must carry integer token counts');
  }
  return {
    schema: JEV_RESULT_SCHEMA,
    requestId: request.requestId,
    status: 'ok',
    advisoryOnly: true,
    answers,
    lineage: {
      provider: 'typesafe',
      model: apiBody.model,
      skillDigest: expectedSkillDigest ?? JEV_UNPINNED_SKILL_DIGEST,
      questionSetDigest: request.questionSet.digest,
      stateDigest,
      requestDigest,
    },
    timing: { latencyMs: Math.max(0, latencyMs), attempts },
    usage: { inputTokens, outputTokens },
  };
}

function configMissing(message) {
  return new AiCliError('JEV_CONFIG_MISSING', message, { retryable: false });
}

function timeoutError(timeoutMs) {
  return typedError('JEV_TIMEOUT', `jev request exceeded ${timeoutMs}ms`, { timeoutMs });
}

function withTimeout(promise, ms, { onTimeout = null } = {}) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(timeoutError(ms));
      }
    }, ms);
  });
  // The timeout controller aborts the attempt (finding 14): a dead transport
  // stops spending quota instead of lingering while retries start.
  return Promise.race([promise, timeout]).then(
    (value) => {
      clearTimeout(timer);
      return value;
    },
    (error) => {
      clearTimeout(timer);
      throw error;
    },
  );
}

export function normalizeTransportError(error) {
  if (!error || typeof error !== 'object') return typedError('JEV_TRANSPORT_FAILED', 'jev transport failed');
  if (error instanceof AiCliError) return error;
  const status = error.status ?? error.statusCode;
  if (typeof status === 'number') {
    // Never copy the raw body into surfaced details (finding 12): a
    // `token=...` payload would leak. Keep a digest for lineage audits.
    // Never forward the transport's message either (M2-R3): it is arbitrary
    // upstream text and may carry a token. Code-based public message only.
    const rawBody = typeof error.body === 'string' ? error.body.slice(0, 500) : '';
    return typedError(codeForHttpStatus(status), `jev transport failed with status ${status}`, {
      status,
      bodyDigest: rawBody.length > 0 ? `sha256:${sha256Hex(rawBody)}` : undefined,
    });
  }
  if (error.code === 'ETIMEDOUT' || error.code === 'TIMEOUT' || /timeout/i.test(error.message ?? '')) {
    return typedError('JEV_TIMEOUT', 'jev request timed out');
  }
  if (error.code === 'JEV_TIMEOUT') return typedError('JEV_TIMEOUT', 'jev request timed out');
  return typedError('JEV_TRANSPORT_FAILED', 'jev transport failed');
}

export function createJevClient({
  transport = null,
  baseUrl = null,
  apiKey = null,
  model,
  skillDigest = null,
  circuit = null,
  secrets = [],
  fetchFn = null,
  now = () => Date.now(),
  sleep = () => Promise.resolve(),
} = {}) {
  if (typeof model !== 'string' || model.length === 0) throw configMissing('jev client requires an explicit pinned model');
  const breaker = circuit ?? createCircuitBreaker({ now });
  // The server-side key is part of the redaction secret set (round 4 item
  // 8): on paths like the CLI the caller passes no `secrets`, and the key
  // itself must never leak into a payload it authorizes.
  const effectiveSecrets = typeof apiKey === 'string' && apiKey.length > 0 ? [...secrets, apiKey] : [...secrets];
  let modelError = null;
  try {
    assertSafeModel(model, effectiveSecrets);
  } catch (err) {
    modelError = err;
  }
  let lastModel = null;
  let lastUsage = null;
  let lastRequestModelSecrets = effectiveSecrets;
  // The real TypeSafe transport (finding 1): built lazily from an explicitly
  // supplied baseUrl + apiKey (mode-0600 file content today; the vault
  // broker is not wired in M2 — M3 open item, never process.env). An
  // injected `transport` still wins, so tests stay offline and the seam
  // stays intact.
  let resolvedTransport = typeof transport === 'function' ? transport : null;

  function requireTransport(modelSecrets) {
    if (typeof baseUrl === 'string' && baseUrl.length > 0) {
      assertSafeBaseUrl(baseUrl);
      assertKeyNotInBaseUrl(baseUrl, apiKey, modelSecrets);
    }
    if (typeof resolvedTransport !== 'function') {
      if (typeof baseUrl === 'string' && baseUrl.length > 0) {
        resolvedTransport = createTypesafeTransport({ baseUrl, apiKey, fetchFn });
      } else {
        throw configMissing('jev client requires an explicit transport (no default network path)');
      }
    }
  }

  // OQ2: env-inherited secrets are rejected — key must arrive explicitly.
  function requireKey() {
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      throw configMissing('jev api key is missing: provide it explicitly via a mode-0600 key file (vault broker is an M3 open item)');
    }
  }

  async function query(request, { signal = null } = {}) {
    if (modelError) throw modelError;
    validateRequest(request);
    // The model reaches both wire and metadata. Check values discovered in
    // this request before any redaction/circuit/transport work can mask the
    // reason for refusal.
    const derived = collectRequestSensitiveValues(request, { secrets: effectiveSecrets });
    // Deliberate inputs (apiKey and caller-declared secrets) have no length
    // gate. Request-derived values use the redaction policy gate: raw >= 3
    // AND canonical >= 2, so split OTP box digits cannot reject a model.
    const derivedModelSecrets = [...derived.sensitiveValues, ...derived.shortSensitiveValues]
      .filter((value) => typeof value === 'string' && value.length >= 3 && canonicalForMatch(value).length >= 2);
    const modelSecrets = [...effectiveSecrets, ...derivedModelSecrets];
    lastRequestModelSecrets = modelSecrets;
    assertSafeModel(model, modelSecrets);
    const refMap = new Map();
    const newRefToOld = new Map();
    const redacted = redactRequest(request, { secrets: effectiveSecrets, refMap, newRefToOld });
    // Bounds are enforced on the redacted canonical state, before any
    // transport call (finding 4). Oversized states never reach the provider.
    if (Buffer.byteLength(canonicalJson(redacted.state), 'utf8') > request.bounds.maxStateBytes) {
      throw typedError('JEV_REQUEST_INVALID', 'redacted state exceeds bounds.maxStateBytes', {
        maxStateBytes: request.bounds.maxStateBytes,
      });
    }
    if (Object.keys(request.questions).length > request.bounds.maxQuestions) {
      throw typedError('JEV_REQUEST_INVALID', 'question count exceeds bounds.maxQuestions', {
        maxQuestions: request.bounds.maxQuestions,
      });
    }
    requireKey();
    requireTransport(modelSecrets);
    // Half-open admits exactly one canary probe: canTry() claims the probe
    // for the first caller; later callers route to fallback (finding 5).
    if (!breaker.canTry()) {
      const error = typedError('JEV_CIRCUIT_OPEN', 'jev circuit is open; request bypassed to fallback');
      error.details = {
        ...(error.details ?? {}),
        fallback: buildFallback({ request, reason: 'JEV_CIRCUIT_OPEN', circuit: breaker.state, secrets: effectiveSecrets }),
      };
      throw error;
    }
    const stateDigest = stateDigestOf(redacted.state);
    const requestDigest = digestOf(redacted);
    // The wire body is built from the redacted envelope (round 14 item 1):
    // {state, model, questions} and nothing else. The internal envelope
    // never leaves the process.
    const wireBody = toWireBody(redacted, model, { secrets: modelSecrets });
    const timeoutMs = request.bounds.timeoutMs;
    const maxRetries = Math.min(request.bounds.maxRetries, 3);
    const startedAt = now();
    let attempt = 0;
    let lastError = null;
    for (;;) {
      const payload = {
        request: wireBody,
        auth: { scheme: 'server-key' },
        meta: { baseUrl, model, stateDigest, requestDigest, attempt },
      };
      // One AbortController per attempt (finding 14): the timeout aborts the
      // in-flight transport call, and the caller's signal composes with it.
      const attemptCtrl = new AbortController();
      const attemptSignal = signal ? AbortSignal.any([attemptCtrl.signal, signal]) : attemptCtrl.signal;
      try {
        const response = await withTimeout(
          resolvedTransport(payload, { signal: attemptSignal, apiKey, baseUrl, model }),
          timeoutMs,
          { onTimeout: () => attemptCtrl.abort() },
        );
        const apiBody = mapTransportResponse(response);
        const latencyMs = Math.max(0, now() - startedAt);
        const mapped = toInternalResult(apiBody, {
          request,
          stateDigest,
          requestDigest,
          expectedModel: model,
          expectedSkillDigest: skillDigest,
          latencyMs,
          attempts: attempt + 1,
          refMap,
          newRefToOld,
        });
        const result = validateResult(mapped, { request });
        assertLineage(result.lineage, {
          request,
          stateDigest,
          requestDigest,
          expectedModel: model,
          expectedSkillDigest: skillDigest,
        });
        breaker.recordSuccess();
        lastModel = result.lineage.model;
        lastUsage = result.usage;
        return {
          result,
          meta: {
            model: result.lineage.model,
            usage: result.usage,
            attempts: attempt + 1,
            latencyMs: Math.max(0, now() - startedAt),
            stateDigest,
            requestDigest,
          },
        };
      } catch (error) {
        const typed = error instanceof AiCliError ? error : normalizeTransportError(error);
        // Local validation failures (bad request shape, malformed result)
        // never retry and never trip the breaker — they are deterministic.
        // A remote 422 (details.remote) is the exception: it crossed the
        // transport, so it carries a fallback like every other remote code.
        if (typed.code === 'JEV_REQUEST_INVALID' || typed.code === 'JEV_RESPONSE_INVALID') {
          if (!typed.details?.fallback && (typed.code === 'JEV_RESPONSE_INVALID' || typed.details?.remote === true)) {
            typed.details = {
              ...(typed.details ?? {}),
              fallback: buildFallback({ request, reason: typed.code, circuit: breaker.state, secrets: effectiveSecrets }),
            };
          }
          // Release a claimed half-open probe (M2-R3): this branch used to
          // throw without recordSuccess/recordFailure, wedging probeInFlight
          // so every later query got JEV_CIRCUIT_OPEN. For these codes
          // recordFailure only clears the flag and never trips.
          breaker.recordFailure(typed);
          throw typed;
        }
        lastError = typed;
        // Taxonomy action for 429/529: "if exhausted, trip circuit" (finding
        // 8). Timeout/transport failures keep fallback-only semantics.
        if (
          (typed.code === 'JEV_RATE_LIMITED' || typed.code === 'JEV_OVERLOADED')
          && attempt >= maxRetries
        ) {
          breaker.recordFailure('JEV_CIRCUIT_OPEN');
        }
        breaker.recordFailure(typed);
        // Once the breaker opens mid-retry, stop spending the retry budget:
        // further attempts would bypass the open circuit.
        if (!breaker.isOpen() && shouldRetry(typed.code, attempt, maxRetries)) {
          attempt += 1;
          await sleep(backoffMs(attempt - 1));
          continue;
        }
        const reason = normalizeErrorToReason(typed);
        const final = typed.code === reason ? typed : typedError(reason, typed.message, typed.details);
        final.details = {
          ...(final.details ?? {}),
          retryable: isRetryableCode(reason),
          fallback: buildFallback({ request, reason, circuit: breaker.state, secrets: effectiveSecrets }),
        };
        throw final;
      }
    }
  }

  return {
    query,
    getPinnedModel: () => {
      if (modelError) throw modelError;
      assertSafeModel(model, lastRequestModelSecrets);
      return model;
    },
    getLastModel: () => {
      if (modelError) throw modelError;
      assertSafeModel(model, lastRequestModelSecrets);
      return lastModel;
    },
    getLastUsage: () => lastUsage,
    getCircuitState: () => breaker.state,
    getProvider: () => JEV_PROVIDER,
    getSkillDigest: () => skillDigest,
  };
}

// Full digest pinning (finding 9): the model pin covers the model plus the
// configured skill digest and the question-set digest; the digests the client
// computes itself (state, request) must round-trip. Thrown errors carry no
// fallback and record no breaker failure here — the catch block owns both
// (finding 16).
function assertLineage(lineage, { request, stateDigest, requestDigest, expectedModel, expectedSkillDigest }) {
  if (lineage.model !== expectedModel) {
    throw typedError(
      'JEV_MODEL_MISMATCH',
      'returned model violates the pin',
    );
  }
  if (expectedSkillDigest !== null && lineage.skillDigest !== expectedSkillDigest) {
    throw typedError('JEV_MODEL_MISMATCH', 'returned skillDigest violates the pinned skill digest');
  }
  if (lineage.questionSetDigest !== request.questionSet.digest) {
    throw typedError('JEV_MODEL_MISMATCH', 'returned questionSetDigest does not match the request question set');
  }
  if (lineage.stateDigest !== stateDigest) {
    throw typedError('JEV_RESPONSE_INVALID', 'returned stateDigest does not match the redacted request state');
  }
  if (lineage.requestDigest !== requestDigest) {
    throw typedError('JEV_RESPONSE_INVALID', 'returned requestDigest does not match the redacted request');
  }
}
// Maps a transport envelope {status, body} to a result object (or throws the
// typed error for the status). Transport never throws typed codes itself —
// mapping stays in one place for the 401/422/429/529/timeout tests.
export function mapTransportResponse(response) {
  if (!response || typeof response !== 'object') {
    throw typedError('JEV_RESPONSE_INVALID', 'empty transport response');
  }
  const status = response.status ?? 200;
  if (status === 401) throw typedError('JEV_AUTH_FAILED', 'typesafe rejected the server key (401)');
  if (status === 422) {
    // Remote 422 crossed the transport, so it carries a fallback like every
    // other remote code (finding 15). `remote: true` distinguishes it from
    // local validation failures, which stay fallback-free.
    throw new AiCliError('JEV_REQUEST_INVALID', 'typesafe rejected the request shape (422)', {
      retryable: false,
      details: { remote: true },
    });
  }
  if (status === 429) throw typedError('JEV_RATE_LIMITED', 'typesafe rate limit reached (429)');
  if (status === 529) throw typedError('JEV_OVERLOADED', 'typesafe overloaded (529)');
  if (typeof status === 'number' && status !== 200) {
    throw typedError(codeForHttpStatus(status), `typesafe transport failed with status ${status}`, { status });
  }
  const body = response.body;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      throw typedError('JEV_RESPONSE_INVALID', 'typesafe returned non-JSON body');
    }
  }
  if (body && typeof body === 'object') return body;
  throw typedError('JEV_RESPONSE_INVALID', 'typesafe returned an empty result body');
}
