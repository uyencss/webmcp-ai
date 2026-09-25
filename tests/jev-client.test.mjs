// M2 client tests: HTTP/status mapping, fuzz, redaction-on-send, pinning.
// Offline only: every case injects a fake transport. No network, no provider
// binary, no secrets on disk.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJevClient, mapTransportResponse, normalizeTransportError, toInternalResult, toWireBody } from '../src/jev/client.mjs';
import { buildFallback } from '../src/jev/fallback.mjs';
import { createTypesafeTransport, readKeyFile } from '../src/jev/transport.mjs';
import { redactRequest, digestOf, stateDigestOf } from '../src/jev/redact.mjs';
import { createCircuitBreaker } from '../src/jev/circuit.mjs';
import { validateFallback } from '../src/jev/schemas.mjs';
import { jevHelpText, jevQueryHelpText, jevCanaryHelpText, runJevCli } from '../src/jev/cli.mjs';

const DIGEST = `sha256:${'ab'.repeat(32)}`;

function baseRequest(overrides = {}) {
  return {
    schema: 'webmcp-jev-request/1',
    requestId: 'run_1@browser-step-7',
    kind: 'browser-step',
    state: {
      snapshotDigest: DIGEST,
      urlOrigin: 'https://example.test',
      goal: 'Open settings',
      elements: [
        { ref: 'r5', role: 'button', name: 'Settings', value: '', enabled: true, visible: true, operations: ['CLICK'] },
      ],
      recentActions: [],
    },
    questionSet: { id: 'browser-step', version: 1, digest: DIGEST },
    questions: {
      operation: {
        type: 'choice',
        instructions: { goal: 'Open settings', question: 'Choose exactly one next operation.' },
        criteria: { CLICK: null, WAIT: 'Page is loading.' },
      },
    },
    bounds: { maxStateBytes: 32768, maxQuestions: 8, timeoutMs: 2000, maxRetries: 0 },
    caller: { runId: 'run_1', permitId: null },
    fallbackPolicy: 'normal-agent',
    ...overrides,
  };
}

function baseResult(overrides = {}) {
  return {
    model: 'jev-1.13.0',
    answers: {
      operation: { type: 'choice', choice: 'CLICK', probabilities: { CLICK: 0.97, WAIT: 0.03 }, confidence: 0.94 },
    },
    usage: { input_tokens: 12, output_tokens: 4 },
    ...overrides,
  };
}

function clientWith(transport, overrides = {}) {
  return createJevClient({ apiKey: 'test-key-not-a-secret', model: 'jev-1.13.0', transport, ...overrides });
}

test('ordinary login label dispatches without a sensitive value', async () => {
  const request = baseRequest();
  request.state.elements = [{
    ref: 'login', role: 'textbox', name: 'Enter password:', value: '',
    enabled: true, visible: true, operations: ['TYPE_TEXT'],
  }];
  let calls = 0;
  const client = clientWith(async () => { calls += 1; return { status: 200, body: baseResult() }; });
  await client.query(request);
  assert.equal(calls, 1);
});

// status → taxonomy code mapping (+ fallback reason attached where applicable)
for (const [status, code, withFallback] of [
  [401, 'JEV_AUTH_FAILED', true],
  [422, 'JEV_REQUEST_INVALID', true],
  [429, 'JEV_RATE_LIMITED', true],
  [529, 'JEV_OVERLOADED', true],
]) {
  test(`transport status ${status} maps to ${code}`, async () => {
    let calls = 0;
    const client = clientWith(async () => { calls += 1; return { status, body: '{}' }; });
    await assert.rejects(client.query(baseRequest()), (error) => {
      assert.equal(error.code, code);
      assert.equal(calls, 1);
      if (withFallback) {
        assert.equal(error.details?.fallback?.schema, 'webmcp-jev-fallback/1');
        assert.equal(error.details?.fallback?.reason, code);
      }
      return true;
    });
  });
}

test('hanging transport maps to JEV_TIMEOUT with fallback', async () => {
  const request = baseRequest({ bounds: { maxStateBytes: 32768, maxQuestions: 8, timeoutMs: 20, maxRetries: 0 } });
  const client = clientWith(() => new Promise(() => {}));
  await assert.rejects(client.query(request), (error) => {
    assert.equal(error.code, 'JEV_TIMEOUT');
    assert.equal(error.details?.fallback?.reason, 'JEV_TIMEOUT');
    assert.equal(error.details?.fallback?.retryable, true);
    return true;
  });
});

test('network-shaped error maps to JEV_TRANSPORT_FAILED', async () => {
  const client = clientWith(async () => { throw new Error('socket hang up'); });
  await assert.rejects(client.query(baseRequest()), (error) => {
    assert.equal(error.code, 'JEV_TRANSPORT_FAILED');
    assert.equal(error.details?.fallback?.reason, 'JEV_TRANSPORT_FAILED');
    return true;
  });
});

// Fuzz: malformed responses all become JEV_RESPONSE_INVALID, never a crash.
const fuzzCases = [
  ['non-JSON string body', { status: 200, body: 'not json{{{' }],
  ['empty body', { status: 200, body: null }],
  ['missing answers', { status: 200, body: { ...baseResult(), answers: undefined } }],
  ['probabilities sum to 0.5', {
    status: 200,
    body: baseResult({ answers: { operation: { type: 'choice', choice: 'CLICK', probabilities: { CLICK: 0.4, WAIT: 0.1 }, confidence: 0.5 } } }),
  }],
  ['choice not offered', {
    status: 200,
    body: baseResult({ answers: { operation: { type: 'choice', choice: 'DELETE', probabilities: { DELETE: 0.9, WAIT: 0.1 }, confidence: 0.9 } } }),
  }],
  ['noul with fabricated confidence', { answers: { note: { type: 'noul', noul: 'hello', confidence: 0.9 } }, direct: true }],
  ['status ok but advisoryOnly false', { advisoryOnly: false, direct: true }],
];

for (const [label, response] of fuzzCases) {
  test(`fuzz: ${label} -> JEV_RESPONSE_INVALID`, async () => {
    // Cases the wire adapter normalizes away (extra answer keys, envelope
    // flags the live API never sends) are asserted directly against
    // validateResult on an adapter-built envelope instead of through the
    // transport seam.
    if (response.direct) {
      const { validateResult } = await import('../src/jev/schemas.mjs');
      const { toInternalResult } = await import('../src/jev/client.mjs');
      const request = baseRequest();
      if (label.includes('noul')) {
        request.questions.note = { type: 'noul', instructions: { question: 'Say something.' } };
      }
      const redacted = redactRequest(request, { secrets: [] });
      const mapped = toInternalResult(baseResult(), {
        request,
        stateDigest: stateDigestOf(redacted.state),
        requestDigest: digestOf(redacted),
        expectedModel: 'jev-1.13.0',
        expectedSkillDigest: null,
        latencyMs: 5,
        attempts: 1,
      });
      if (label.includes('noul')) mapped.answers.note = response.answers.note;
      else mapped.advisoryOnly = false;
      assert.throws(() => validateResult(mapped, { request }), (error) => {
        assert.equal(error.code, 'JEV_RESPONSE_INVALID');
        return true;
      });
      return;
    }
    const client = clientWith(async () => response);
    // request needs the extra question for the noul case
    const request = baseRequest();
    if (label.includes('noul')) {
      request.questions.note = { type: 'noul', instructions: { question: 'Say something.' } };
    }
    await assert.rejects(client.query(request), (error) => {
      assert.equal(error.code, 'JEV_RESPONSE_INVALID', `${label}: got ${error.code}: ${error.message}`);
      return true;
    });
  });
}

test('invalid request never reaches the transport', async () => {
  let calls = 0;
  const client = clientWith(async () => { calls += 1; return { status: 200, body: baseResult() }; });
  const bad = baseRequest({ kind: 'nope' });
  await assert.rejects(client.query(bad), (error) => {
    assert.equal(error.code, 'JEV_REQUEST_INVALID');
    return true;
  });
  assert.equal(calls, 0);
});

test('missing key fails closed without transport', async () => {
  let calls = 0;
  const client = createJevClient({
    apiKey: null,
    model: 'jev-1.13.0',
    transport: async () => { calls += 1; return { status: 200, body: baseResult() }; },
  });
  await assert.rejects(client.query(baseRequest()), (error) => {
    assert.equal(error.code, 'JEV_CONFIG_MISSING');
    return true;
  });
  assert.equal(calls, 0);
});

test('model mismatch trips JEV_MODEL_MISMATCH and opens the circuit', async () => {
  const client = clientWith(async () => ({ status: 200, body: baseResult({ model: 'jev-9.9.9' }) }));
  await assert.rejects(client.query(baseRequest()), (error) => {
    assert.equal(error.code, 'JEV_MODEL_MISMATCH');
    assert.equal(error.details?.fallback?.reason, 'JEV_MODEL_MISMATCH');
    return true;
  });
  assert.equal(client.getCircuitState(), 'open');
});

test('success pins model version and usage, sends redacted payload', async () => {
  let seen = null;
  const secret = 's3cr3t-value-xyz';
  const request = baseRequest();
  request.state.elements[0].value = `typed ${secret} here`;
  const client = clientWith(async (payload) => { seen = payload; return { status: 200, body: baseResult() }; }, { secrets: [secret] });
  const { result, meta } = await client.query(request, {});
  assert.equal(result.status, 'ok');
  assert.equal(meta.model, 'jev-1.13.0');
  assert.deepEqual(meta.usage, { inputTokens: 12, outputTokens: 4 });
  assert.equal(client.getPinnedModel(), 'jev-1.13.0');
  assert.equal(client.getLastModel(), 'jev-1.13.0');
  const sent = JSON.stringify(seen);
  assert.doesNotMatch(sent, new RegExp(secret), 'secret must not appear in the payload sent');
});

test('circuit open short-circuits to JEV_CIRCUIT_OPEN without transport', async () => {
  let calls = 0;
  const client = clientWith(async () => { calls += 1; return { status: 429, body: '{}' }; });
  const request = baseRequest({ bounds: { maxStateBytes: 32768, maxQuestions: 8, timeoutMs: 50, maxRetries: 5 } });
  // First query retries until the breaker opens (3 bounded failures), then
  // stops spending the budget and surfaces the typed error.
  await assert.rejects(client.query(request), (error) => {
    assert.equal(error.code, 'JEV_RATE_LIMITED');
    assert.equal(error.details?.fallback?.circuit, 'open');
    return true;
  });
  assert.equal(client.getCircuitState(), 'open');
  assert.equal(calls, 3, 'retries stop as soon as the circuit opens');
  const before = calls;
  await assert.rejects(client.query(baseRequest()), (error) => {
    assert.equal(error.code, 'JEV_CIRCUIT_OPEN');
    assert.equal(error.details?.fallback?.reason, 'JEV_CIRCUIT_OPEN');
    assert.equal(error.details?.fallback?.circuit, 'open');
    return true;
  });
  assert.equal(calls, before, 'open circuit must not call the transport');
});

// ---- M2 repair guards: one negative test per finding (brief items 1..17) ----

// Finding 1: the real TypeSafe transport exists — explicit baseUrl + apiKey
// build a bounded fetch transport with no injected `transport` seam.
test('finding-1: explicit baseUrl+apiKey dispatches via the built-in fetch transport', async () => {
  const request = baseRequest();
  let seenUrl = null;
  let seenInit = null;
  const fakeFetch = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return { status: 200, text: async () => JSON.stringify(baseResult()) };
  };
  const client = createJevClient({
    baseUrl: 'https://typesafe.test/jev',
    apiKey: 'explicit-operator-key',
    model: 'jev-1.13.0',
    fetchFn: fakeFetch,
  });
  const { result } = await client.query(request);
  assert.equal(result.status, 'ok');
  assert.equal(seenUrl, 'https://typesafe.test/jev');
  assert.equal(seenInit.method, 'POST');
  assert.equal(seenInit.headers.authorization, 'Bearer explicit-operator-key');
  assert.ok(seenInit.signal instanceof AbortSignal, 'fetch must receive an abort signal');
});

// Finding 1: key arrives explicitly — no transport, no key still fails closed.
test('finding-1: baseUrl without an explicit key still fails closed', async () => {
  const client = createJevClient({ baseUrl: 'https://typesafe.test/jev', model: 'jev-1.13.0' });
  await assert.rejects(client.query(baseRequest()), (error) => {
    assert.equal(error.code, 'JEV_CONFIG_MISSING');
    return true;
  });
});

// Finding 1: mode-0600 key files read; group/other-readable files refused.
test('finding-1: key file must be owner-only (mode 0600)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-key-'));
  const strict = join(dir, 'strict.key');
  writeFileSync(strict, 'file-key-abc\n');
  chmodSync(strict, 0o600);
  assert.equal(readKeyFile(strict), 'file-key-abc');
  const loose = join(dir, 'loose.key');
  writeFileSync(loose, 'file-key-abc\n');
  chmodSync(loose, 0o644);
  assert.throws(() => readKeyFile(loose), (error) => error.code === 'JEV_CONFIG_MISSING');
  assert.throws(() => readKeyFile(join(dir, 'missing.key')), (error) => error.code === 'JEV_CONFIG_MISSING');
});

// Finding 1: the transport constructor itself rejects implicit secrets.
test('finding-1: fetch transport requires explicit baseUrl and apiKey', () => {
  assert.throws(
    () => createTypesafeTransport({ baseUrl: '', apiKey: 'k' }),
    (error) => error.code === 'JEV_CONFIG_MISSING',
  );
  assert.throws(
    () => createTypesafeTransport({ baseUrl: 'https://typesafe.test', apiKey: '' }),
    (error) => error.code === 'JEV_CONFIG_MISSING',
  );
});

// Finding 4: oversized redacted state rejected before transport.
test('finding-4: state larger than maxStateBytes never reaches the transport', async () => {
  let calls = 0;
  const client = clientWith(async () => { calls += 1; return { status: 200, body: baseResult() }; });
  const request = baseRequest({ bounds: { maxStateBytes: 1, maxQuestions: 8, timeoutMs: 50, maxRetries: 0 } });
  await assert.rejects(client.query(request), (error) => {
    assert.equal(error.code, 'JEV_REQUEST_INVALID');
    assert.match(error.message, /maxStateBytes/);
    assert.equal(error.details?.fallback, undefined);
    return true;
  });
  assert.equal(calls, 0);
});

// Finding 4: excess questions rejected before transport.
test('finding-4: more questions than maxQuestions never reach the transport', async () => {
  let calls = 0;
  const client = clientWith(async () => { calls += 1; return { status: 200, body: baseResult() }; });
  const request = baseRequest({ bounds: { maxStateBytes: 32768, maxQuestions: 1, timeoutMs: 50, maxRetries: 0 } });
  request.questions.extra = { type: 'noul', instructions: { question: 'Extra?' } };
  await assert.rejects(client.query(request), (error) => {
    assert.equal(error.code, 'JEV_REQUEST_INVALID');
    assert.match(error.message, /maxQuestions/);
    return true;
  });
  assert.equal(calls, 0);
});

// Finding 5: half-open admits exactly one probe; the loser gets CIRCUIT_OPEN.
test('finding-5: concurrent half-open queries admit a single probe', async () => {
  let t = 1_000_000;
  const clock = { now: () => t };
  const { COOLDOWN_MS } = await import('../src/jev/circuit.mjs');
  const breaker = createCircuitBreaker({ now: clock.now });
  for (let i = 0; i < 3; i++) breaker.recordFailure({ code: 'JEV_RATE_LIMITED' });
  assert.equal(breaker.state, 'open');
  t += COOLDOWN_MS;
  assert.equal(breaker.state, 'half-open');
  let calls = 0;
  const request = baseRequest();
  const transport = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { status: 200, body: baseResult() };
  };
  const client = createJevClient({ apiKey: 'test-key-not-a-secret', model: 'jev-1.13.0', transport, circuit: breaker });
  const [first, second] = await Promise.allSettled([client.query(request), client.query(request)]);
  const codes = [first, second].map((outcome) => (outcome.status === 'fulfilled' ? 'ok' : outcome.reason.code)).sort();
  assert.deepEqual(codes, ['JEV_CIRCUIT_OPEN', 'ok']);
  assert.equal(calls, 1, 'only the admitted probe may call the transport');
});

// Finding 8: exhausted 429/529 budgets trip the circuit; timeout/transport do not.
for (const code of ['JEV_RATE_LIMITED', 'JEV_OVERLOADED']) {
  test(`finding-8: exhausted ${code} budget trips the circuit`, async () => {
    const status = code === 'JEV_RATE_LIMITED' ? 429 : 529;
    const client = clientWith(async () => ({ status, body: '{}' }));
    const request = baseRequest({ bounds: { maxStateBytes: 32768, maxQuestions: 8, timeoutMs: 50, maxRetries: 0 } });
    await assert.rejects(client.query(request), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.details?.fallback?.circuit, 'open');
      return true;
    });
    assert.equal(client.getCircuitState(), 'open');
  });
}

test('finding-8: exhausted JEV_TIMEOUT budget keeps fallback-only semantics', async () => {
  const request = baseRequest({ bounds: { maxStateBytes: 32768, maxQuestions: 8, timeoutMs: 20, maxRetries: 0 } });
  const client = clientWith(() => new Promise(() => {}));
  await assert.rejects(client.query(request), (error) => {
    assert.equal(error.code, 'JEV_TIMEOUT');
    assert.equal(error.details?.fallback?.circuit, 'closed');
    return true;
  });
  assert.equal(client.getCircuitState(), 'closed');
});

test('finding-8: exhausted JEV_TRANSPORT_FAILED budget keeps fallback-only semantics', async () => {
  const client = clientWith(async () => { throw new Error('socket hang up'); });
  const request = baseRequest({ bounds: { maxStateBytes: 32768, maxQuestions: 8, timeoutMs: 50, maxRetries: 0 } });
  await assert.rejects(client.query(request), (error) => {
    assert.equal(error.code, 'JEV_TRANSPORT_FAILED');
    assert.equal(error.details?.fallback?.circuit, 'closed');
    return true;
  });
  assert.equal(client.getCircuitState(), 'closed');
});

// Finding 9 (round 14): the live API returns no lineage — digests are
// constructed locally from the request, so server-side value-mismatch trips
// are unreachable through query. What stays enforced: the model pin trips on
// the server's model (see 'model mismatch trips...' above), digest formats
// are enforced by validateResult, and unknown server fields are ignored
// rather than trusted — never the reverse.
test('finding-9: lineage digests must be sha256-hex shaped', async () => {
  const { validateResult } = await import('../src/jev/schemas.mjs');
  const { toInternalResult } = await import('../src/jev/client.mjs');
  const request = baseRequest();
  const redacted = redactRequest(request, { secrets: [] });
  const good = toInternalResult(baseResult(), {
    request,
    stateDigest: stateDigestOf(redacted.state),
    requestDigest: digestOf(redacted),
    expectedModel: 'jev-1.13.0',
    expectedSkillDigest: null,
    latencyMs: 5,
    attempts: 1,
  });
  for (const key of ['skillDigest', 'questionSetDigest', 'stateDigest', 'requestDigest']) {
    assert.throws(
      () => validateResult({ ...good, lineage: { ...good.lineage, [key]: 'not-a-digest' } }),
      (error) => error.code === 'JEV_RESPONSE_INVALID',
      key,
    );
  }
});

test('finding-9: server-provided lineage is ignored, local lineage wins', async () => {
  const request = baseRequest();
  const body = {
    ...baseResult(),
    lineage: { model: 'jev-9.9.9', skillDigest: `sha256:${'ff'.repeat(32)}` },
  };
  let calls = 0;
  const client = clientWith(async () => { calls += 1; return { status: 200, body }; });
  const { result, meta } = await client.query(request);
  assert.equal(result.status, 'ok');
  assert.equal(meta.model, 'jev-1.13.0');
  assert.equal(calls, 1);
});

// Finding 11: fallback reasons are the frozen 14-code enum, nothing else.
test('finding-11: validateFallback rejects reasons outside the frozen enum', () => {
  const valid = {
    schema: 'webmcp-jev-fallback/1',
    requestId: 'run_1@browser-step-7',
    status: 'fallback-required',
    decisionEngine: 'normal-agent',
    reason: 'JEV_RATE_LIMITED',
    retryable: true,
    circuit: 'open',
    stateDigest: DIGEST,
  };
  assert.equal(validateFallback(valid), valid);
  assert.throws(
    () => validateFallback({ ...valid, reason: 'MADE_UP' }),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
});

// Finding 12: transport errors carry a digest, never the raw secret body.
test('finding-12: raw response bodies never surface in error details', async () => {
  const secretBody = 'token=fixture-secret-xyz';
  const client = clientWith(async () => { throw { status: 500, message: 'boom', body: secretBody }; });
  await assert.rejects(client.query(baseRequest()), (error) => {
    assert.equal(error.code, 'JEV_TRANSPORT_FAILED');
    assert.doesNotMatch(JSON.stringify(error.details), /fixture-secret-xyz/);
    assert.equal(error.details?.body, undefined);
    assert.match(error.details?.bodyDigest ?? '', /^sha256:[0-9a-f]{64}$/);
    return true;
  });
});

// Finding 14: a timed-out attempt aborts the in-flight transport signal.
test('finding-14: timeout aborts the attempt signal', async () => {
  let seen = null;
  const request = baseRequest({ bounds: { maxStateBytes: 32768, maxQuestions: 8, timeoutMs: 20, maxRetries: 0 } });
  const client = clientWith(async (payload, { signal } = {}) => {
    seen = signal;
    return new Promise(() => {});
  });
  await assert.rejects(client.query(request), (error) => {
    assert.equal(error.code, 'JEV_TIMEOUT');
    return true;
  });
  assert.ok(seen instanceof AbortSignal, 'transport must receive an abort signal');
  assert.equal(seen.aborted, true, 'timed-out attempts must abort the transport call');
});

// Finding 15: remote 422 carries a fallback; local validation failures do not.
test('finding-15: remote 422 carries a fallback, local invalid carries none', async () => {
  const remote = clientWith(async () => ({ status: 422, body: '{}' }));
  await assert.rejects(remote.query(baseRequest()), (error) => {
    assert.equal(error.code, 'JEV_REQUEST_INVALID');
    assert.equal(error.details?.fallback?.schema, 'webmcp-jev-fallback/1');
    assert.equal(error.details?.fallback?.reason, 'JEV_REQUEST_INVALID');
    return true;
  });
  let calls = 0;
  const local = clientWith(async () => { calls += 1; return { status: 200, body: baseResult() }; });
  await assert.rejects(local.query(baseRequest({ kind: 'nope' })), (error) => {
    assert.equal(error.code, 'JEV_REQUEST_INVALID');
    assert.equal(error.details?.fallback, undefined);
    return true;
  });
  assert.equal(calls, 0);
});

// Finding 16: a model mismatch records exactly one breaker failure.
test('finding-16: model mismatch records a single breaker failure', async () => {
  const inner = createCircuitBreaker();
  let records = 0;
  const counting = {
    get state() { return inner.state; },
    get failures() { return inner.failures; },
    isOpen(...args) { return inner.isOpen(...args); },
    canTry(...args) { return inner.canTry(...args); },
    recordSuccess(...args) { return inner.recordSuccess(...args); },
    recordFailure(...args) { records += 1; return inner.recordFailure(...args); },
  };
  const request = baseRequest();
  const bad = baseResult();
  bad.model = 'jev-9.9.9';
  const client = createJevClient({
    apiKey: 'test-key-not-a-secret',
    model: 'jev-1.13.0',
    transport: async () => ({ status: 200, body: bad }),
    circuit: counting,
  });
  await assert.rejects(client.query(request), (error) => {
    assert.equal(error.code, 'JEV_MODEL_MISMATCH');
    assert.equal(error.details?.fallback?.reason, 'JEV_MODEL_MISMATCH');
    return true;
  });
  assert.equal(records, 1, 'the catch block owns the single recordFailure');
});

// Finding 17: help advertises only implemented flags.
test('finding-17: help text advertises only flags the CLI reads', () => {
  assert.doesNotMatch(jevQueryHelpText(), /--json/, 'query --json was never read');
  assert.doesNotMatch(jevCanaryHelpText(), /--request/, 'canary --request was never read');
  assert.doesNotMatch(jevHelpText(), /query --request <path> \[--json\]/);
  assert.match(jevQueryHelpText(), /--key-file/, 'the implemented key flag is documented');
  assert.match(jevQueryHelpText(), /--base-url/, 'the implemented endpoint flag is documented');
});

// Finding 3 (spot guard): the validator rejects the headline frozen-schema
// violations. Full validator-vs-ajv parity lives in jev-request-parity.test.mjs.
test('finding-3: validator rejects captcha-next-step without captchaEvidence', async () => {  const { validateRequest } = await import('../src/jev/schemas.mjs');
  const request = baseRequest({ kind: 'captcha-next-step' });
  request.questions = {
    solver: {
      type: 'choice',
      instructions: { question: 'Which solver?' },
      criteria: { slider: null },
    },
    next_step: {
      type: 'choice',
      instructions: { question: 'Next?' },
      criteria: { run_detector: null },
    },
  };
  assert.throws(() => validateRequest(request), (error) => error.code === 'JEV_REQUEST_INVALID');
});

// ---- M2 repair round 2 ----

// Finding 5 wedge (M2-R3): a half-open probe ending in JEV_RESPONSE_INVALID
// must release the probe — the next query has to reach the transport instead
// of getting JEV_CIRCUIT_OPEN forever.
test('m2r3-finding-5: probe ending in JEV_RESPONSE_INVALID releases the probe', async () => {
  let t = 1_000_000;
  const clock = { now: () => t };
  const { COOLDOWN_MS } = await import('../src/jev/circuit.mjs');
  const breaker = createCircuitBreaker({ now: clock.now });
  for (let i = 0; i < 3; i++) breaker.recordFailure({ code: 'JEV_RATE_LIMITED' });
  assert.equal(breaker.state, 'open');
  t += COOLDOWN_MS;
  assert.equal(breaker.state, 'half-open');
  const request = baseRequest();
  let calls = 0;
  const transport = async () => {
    calls += 1;
    if (calls === 1) return { status: 200, body: 'not json{{{' };
    return { status: 200, body: baseResult() };
  };
  const client = createJevClient({ apiKey: 'test-key-not-a-secret', model: 'jev-1.13.0', transport, circuit: breaker });
  await assert.rejects(client.query(request), (error) => {
    assert.equal(error.code, 'JEV_RESPONSE_INVALID');
    assert.equal(error.details?.fallback?.reason, 'JEV_RESPONSE_INVALID');
    return true;
  });
  assert.equal(calls, 1);
  const { result } = await client.query(request);
  assert.equal(result.status, 'ok');
  assert.equal(calls, 2, 'the next query must reach the transport after the failed probe');
});

// Finding 6 (M2-R3): transport error text is arbitrary upstream content —
// public errors use fixed code-based messages and never forward it.
test('m2r3-finding-6: transport error messages never forward embedded secrets', () => {
  const secret = 'fixture-transport-secret';
  const fromStatus = normalizeTransportError({ status: 503, message: `upstream failed token=${secret}` });
  assert.equal(fromStatus.code, 'JEV_TRANSPORT_FAILED');
  assert.doesNotMatch(`${fromStatus.message} ${JSON.stringify(fromStatus.details)}`, new RegExp(secret));
  const fromError = normalizeTransportError(new Error(`socket ${secret} hung up`));
  assert.equal(fromError.code, 'JEV_TRANSPORT_FAILED');
  assert.doesNotMatch(`${fromError.message} ${JSON.stringify(fromError.details)}`, new RegExp(secret));
  const fromString = normalizeTransportError(`plain string ${secret}`);
  assert.equal(fromString.code, 'JEV_TRANSPORT_FAILED');
  assert.doesNotMatch(`${fromString.message} ${JSON.stringify(fromString.details)}`, new RegExp(secret));
});

// Finding 9 (M2-R7): cleartext http is rejected while the bearer key is in
// use; loopback stays allowed for local runs.
test('m2r3-finding-9: non-https baseUrl is rejected, loopback stays allowed', () => {
  assert.throws(
    () => createTypesafeTransport({ baseUrl: 'http://typesafe.test/jev', apiKey: 'k' }),
    (error) => error.code === 'JEV_CONFIG_MISSING',
  );
  assert.doesNotThrow(() => createTypesafeTransport({ baseUrl: 'http://localhost:9999/jev', apiKey: 'k' }));
  assert.doesNotThrow(() => createTypesafeTransport({ baseUrl: 'http://127.0.0.1:9999/jev', apiKey: 'k' }));
  assert.doesNotThrow(() => createTypesafeTransport({ baseUrl: 'https://typesafe.test/jev', apiKey: 'k' }));
});

// Finding 7 (M2-R5): help text is truthful — the file is the only wired key
// source, the broker is an M3 open item.
test('m2r3-finding-7: help text no longer claims a wired vault broker', () => {
  assert.doesNotMatch(jevQueryHelpText(), /vault broker remains the first source/);
  assert.match(jevQueryHelpText(), /M3 open item/);
});

// Finding 8 (M2-R6): the CLI boundary exposes --model and --skill-digest so
// the finding-9 pin runs where M4 consumes it.
test('m2r3-finding-8: query help advertises --model and --skill-digest', () => {
  assert.match(jevQueryHelpText(), /--model/);
  assert.match(jevQueryHelpText(), /--skill-digest/);
  assert.match(jevHelpText(), /--model/);
});

// ---- M2 repair round 4 ----

// Item 1 (Z2): off-wire questionSet.id is not screened, but a question id carrying
// a token or declared secret is rejected before dispatch.
test('r4-item-1: question id carrying a password and token is rejected; questionSet.id is not screened', async () => {
  let calls = 0;
  const client = clientWith(async () => { calls += 1; return { status: 200, body: baseResult() }; }, { secrets: ['rosehip42-rosehip42'] });
  const request = baseRequest();
  request.state.elements = [
    { ref: 'r5', role: 'textbox', name: 'Password', value: 'rosehip42-rosehip42', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  // Off-wire questionSet.id is not sent on the wire and not screened:
  request.questionSet.id = 'browser-step rosehip42-rosehip42 sk-fixture1234567890abcdef';
  const { result } = await client.query(request);
  assert.equal(result.status, 'ok');
  assert.equal(calls, 1);

  // Wire question id carrying token is screened and rejected:
  calls = 0;
  const badReq = baseRequest();
  badReq.questions = {
    'sk-fixture1234567890abcdef': badReq.questions.operation,
  };
  await assert.rejects(client.query(badReq), (error) => {
    assert.equal(error.code, 'JEV_REQUEST_INVALID');
    assert.equal(error.details?.fallback, undefined);
    return true;
  });
  assert.equal(calls, 0);
});

// Item 2: a short typed value echoed in free text rejects the request instead
// of reaching the transport — captured-transport proof, zero calls.
test('r4-item-2: short PIN echoed in instructions.question never reaches the transport', async () => {
  let calls = 0;
  const client = clientWith(async () => { calls += 1; return { status: 200, body: baseResult() }; }, { secrets: ['42'] });
  const request = baseRequest();
  request.state.elements = [
    { ref: 'r5', role: 'textbox', name: 'PIN', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  request.state.recentActions = [{ operation: 'TYPE_TEXT', targetRef: 'r5', text: '42', values: ['42'] }];
  request.questions.operation.instructions.question = 'Use code 42 to log in.';
  await assert.rejects(client.query(request), (error) => {
    assert.equal(error.code, 'JEV_REQUEST_INVALID');
    return true;
  });
  assert.equal(calls, 0, 'a short-value echo must be rejected before dispatch');
});

// Item 4 (over-rejection): an ordinary ref criteria key that merely contains
// typed digits is accepted and dispatched intact, while a PII key is still
// rejected.
test('r4-item-4: ref criteria key with typed digits dispatches, PII key rejected', async () => {
  const request = baseRequest();
  request.state.elements = [
    { ref: 'r7', role: 'textbox', name: 'CVC', value: '', enabled: true, visible: true, operations: ['CLICK'] },
    { ref: 'e123', role: 'button', name: 'Go', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  request.state.recentActions = [{ operation: 'TYPE_TEXT', targetRef: 'r7', text: '123', values: ['123'] }];
  request.questions.operation.criteria = { e123: null, WAIT: 'Page is loading.' };
  let seen = null;
  let calls = 0;
  const okBody = baseResult();
  okBody.answers = {
    operation: { type: 'choice', choice: 'e2', probabilities: { e2: 0.9, WAIT: 0.1 }, confidence: 0.9 },
  };
  const client = clientWith(async (payload) => {
    seen = payload;
    calls += 1;
    return { status: 200, body: okBody };
  });
  const { result } = await client.query(request);
  assert.equal(result.status, 'ok');
  assert.equal(calls, 1, 'the ref-keyed request must dispatch');
  assert.ok('e2' in seen.request.questions.operation.criteria, 'the ref key must be remapped by position to e2');
  assert.equal(result.answers.operation.choice, 'e123', 'choice must be remapped back to caller ref e123');
  assert.equal(seen.request.state.snapshotDigest, DIGEST, 'the digest must go out intact');
  // ...while a PII key on the same shape is still rejected before dispatch.
  const bad = baseRequest();
  bad.questions.operation.criteria = { 'somebody@example.test': null };
  await assert.rejects(client.query(bad), (error) => {
    assert.equal(error.code, 'JEV_REQUEST_INVALID');
    return true;
  });
  assert.equal(calls, 1, 'the PII-keyed request must not dispatch');
});

// Item 6 (Z2): wire-sent question ids carrying secrets or PII are rejected;
// off-wire identifiers (requestId, runId, permitId, questionSet.id) are not screened.
test('r4-item-6: caller-authored question ids carrying secrets or PII are rejected; off-wire ids pass', async () => {
  const sk = 'sk-fixture1234567890abcdef';
  const secrets = ['fixture-caller-secret'];

  // Wire question ids carrying PII or declared secret: rejected
  const badQuestions = [
    () => ({ ...baseRequest(), questions: { 'alice@example.test': baseRequest().questions.operation } }),
    () => ({ ...baseRequest(), questions: { 'fixture-caller-secret': baseRequest().questions.operation } }),
  ];
  for (const [index, shape] of badQuestions.entries()) {
    let calls = 0;
    const client = clientWith(async () => { calls += 1; return { status: 200, body: baseResult() }; }, { secrets });
    await assert.rejects(client.query(shape()), (error) => {
      assert.equal(error.code, 'JEV_REQUEST_INVALID', `question shape ${index} must be rejected`);
      return true;
    });
    assert.equal(calls, 0, `question shape ${index} must not dispatch`);
  }

  // Off-wire identifiers: not screened and dispatch safely
  const offWireShapes = [
    () => baseRequest({ requestId: 'alice@example.test' }),
    () => { const r = baseRequest(); r.caller = { runId: sk, permitId: null }; return r; },
    () => { const r = baseRequest(); r.caller = { runId: 'run_1', permitId: sk }; return r; },
    () => { const r = baseRequest(); r.questionSet = { id: `qs-fixture-caller-secret`, version: 1, digest: DIGEST }; return r; },
  ];
  for (const [index, shape] of offWireShapes.entries()) {
    let calls = 0;
    const client = clientWith(async () => { calls += 1; return { status: 200, body: baseResult() }; }, { secrets });
    const { result } = await client.query(shape());
    assert.equal(result.status, 'ok', `off-wire shape ${index} must dispatch`);
    assert.equal(calls, 1, `off-wire shape ${index} must make 1 transport call`);
  }
});

// Item 7: the loopback exemption is exact — 127.attacker.example is refused,
// real IPv6 loopback is allowed.
test('r4-item-7: lookalike loopback hosts are refused over http', () => {
  assert.throws(
    () => createTypesafeTransport({ baseUrl: 'http://127.attacker.example/jev', apiKey: 'k' }),
    (error) => error.code === 'JEV_CONFIG_MISSING',
  );
  assert.throws(
    () => createTypesafeTransport({ baseUrl: 'http://127.0.0.1.nip.io/jev', apiKey: 'k' }),
    (error) => error.code === 'JEV_CONFIG_MISSING',
  );
  assert.doesNotThrow(() => createTypesafeTransport({ baseUrl: 'http://[::1]:9999/jev', apiKey: 'k' }));
  assert.doesNotThrow(() => createTypesafeTransport({ baseUrl: 'http://127.0.0.1:9999/jev', apiKey: 'k' }));
  assert.doesNotThrow(() => createTypesafeTransport({ baseUrl: 'http://localhost:9999/jev', apiKey: 'k' }));
});

// Item 8: the API key joins the client's secret set, so it cannot leak into
// a payload on paths (like the CLI) that pass no explicit secrets.
test('r4-item-8: the api key never appears in the dispatched payload', async () => {
  const apiKey = 'fixture-api-key-abc';
  const request = baseRequest();
  request.state.goal = `deploy with ${apiKey} now`;
  let seen = null;
  const okBody = baseResult();
  const client = createJevClient({
    apiKey,
    model: 'jev-1.13.0',
    transport: async (payload) => { seen = payload; return { status: 200, body: okBody }; },
  });
  const { result } = await client.query(request);
  assert.equal(result.status, 'ok');
  assert.doesNotMatch(JSON.stringify(seen), new RegExp(apiKey));
});

// ---- M2 repair round 5 ----

// N1: stale ref plus an echo in instructions.question — the class is closed,
// so the request dispatches with a clean payload.
test('r5-n1: stale-ref echo in instructions.question is scrubbed before dispatch', async () => {
  const request = baseRequest();
  request.state.elements = [
    { ref: 'r6', role: 'button', name: 'Submit', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  request.state.recentActions = [{ operation: 'TYPE_TEXT', targetRef: 'r5', text: 'hunter2pw', values: ['hunter2pw'] }];
  request.questions.operation.instructions.question = 'Repeat hunter2pw to confirm.';
  let seen = null;
  let calls = 0;
  const client = clientWith(async (payload) => {
    seen = payload;
    calls += 1;
    return { status: 200, body: baseResult() };
  });
  const { result } = await client.query(request);
  assert.equal(result.status, 'ok');
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(seen.request), /hunter2pw/);
});

// S1: a baseUrl carrying userinfo or a query is rejected before any dispatch.
test('r5-s1: baseUrl with userinfo or query is rejected with JEV_CONFIG_MISSING', async () => {
  assert.throws(
    () => createTypesafeTransport({ baseUrl: 'https://fixture-key-abc@typesafe.test/jev', apiKey: 'k' }),
    (error) => error.code === 'JEV_CONFIG_MISSING',
  );
  for (const baseUrl of [
    'https://fixture-key-abc@typesafe.test/jev',
    'https://typesafe.test/jev?token=fixture-key-abc',
  ]) {
    let calls = 0;
    const withUrl = createJevClient({ apiKey: 'k', model: 'jev-1.13.0', baseUrl, transport: async () => { calls += 1; return { status: 200, body: baseResult() }; } });
    await assert.rejects(withUrl.query(baseRequest()), (error) => {
      assert.equal(error.code, 'JEV_CONFIG_MISSING');
      return true;
    });
    assert.equal(calls, 0, `${baseUrl} must never dispatch`);
  }
});

// S2: secret-bearing validation errors carry static text only — the message
// and details never echo the offending value.
test('r5-s2: secret-bearing requestId leaves no trace in message or details', async () => {
  let calls = 0;
  const client = clientWith(async () => { calls += 1; return { status: 200, body: baseResult() }; });
  const secret = 'hunter2pw-secret-xyz';
  await assert.rejects(client.query(baseRequest({ requestId: `${secret}!` })), (error) => {
    assert.equal(error.code, 'JEV_REQUEST_INVALID');
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error.details)}`, new RegExp(secret));
    return true;
  });
  assert.equal(calls, 0);
  const { validateRequest } = await import('../src/jev/schemas.mjs');
  assert.throws(
    () => validateRequest({ ...baseRequest({ requestId: `${secret}!` }) }),
    (error) => {
      assert.doesNotMatch(`${error.message} ${JSON.stringify(error.details)}`, new RegExp(secret));
      return error.code === 'JEV_REQUEST_INVALID';
    },
  );
});

// N3: a malformed request file prints a fixed message — the Node parser
// excerpt (which quotes the file content) never reaches stderr.
test('r5-n3: malformed request file prints a fixed message without the secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-n3-'));
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{"note": hunter2pw}');
  const chunks = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  let code = null;
  try {
    code = await runJevCli(['query', '--request', bad]);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(code, 1);
  assert.doesNotMatch(chunks.join(''), /hunter2pw/);
});

// ---- M2 repair round 6 ----

// F5: the key in the baseUrl path reaches transport metadata, so any baseUrl
// containing the api key is rejected on both the built-in and the injected
// transport paths.
test('r6-f5: baseUrl containing the api key is rejected on both paths', async () => {
  const apiKey = 'fixture-key-abc';
  const baseUrl = `https://api.example.test/v1/${apiKey}/jev`;
  assert.throws(
    () => createTypesafeTransport({ baseUrl, apiKey }),
    (error) => error.code === 'JEV_CONFIG_MISSING',
  );
  let calls = 0;
  const client = createJevClient({
    apiKey,
    model: 'jev-1.13.0',
    baseUrl,
    transport: async () => { calls += 1; return { status: 200, body: baseResult() }; },
  });
  await assert.rejects(client.query(baseRequest()), (error) => {
    assert.equal(error.code, 'JEV_CONFIG_MISSING');
    return true;
  });
  assert.equal(calls, 0, 'a key-bearing baseUrl must never dispatch');
});

// N-D: a percent-encoded key is the same leak in another encoding — refused
// on the constructor path and on the injected-transport path, while the
// literal-key controls and a clean URL keep working.
test('r8-nd: percent-encoded key is rejected on both paths', async () => {  const apiKey = 'fixture key/abc+xyz';
  const baseUrl = `https://api.example.test/v1/${encodeURIComponent(apiKey)}/jev`;
  assert.ok(!baseUrl.includes(apiKey), 'fixture must exercise the decoded form');
  assert.throws(
    () => createTypesafeTransport({ baseUrl, apiKey }),
    (error) => error.code === 'JEV_CONFIG_MISSING',
  );
  let calls = 0;
  const client = createJevClient({
    apiKey,
    model: 'jev-1.13.0',
    baseUrl,
    transport: async () => { calls += 1; return { status: 200, body: baseResult() }; },
  });
  await assert.rejects(client.query(baseRequest()), (error) => {
    assert.equal(error.code, 'JEV_CONFIG_MISSING');
    return true;
  });
  assert.equal(calls, 0, 'an encoded key-bearing baseUrl must never dispatch');
  // Controls: literal key positions refused, clean URL constructs.
  for (const bad of [
    `https://${apiKey}@typesafe.test/jev`,
    `https://typesafe.test/jev?token=${apiKey}`,
    `https://api.example.test/v1/${apiKey}/jev`,
  ]) {
    assert.throws(
      () => createTypesafeTransport({ baseUrl: bad, apiKey }),
      (error) => error.code === 'JEV_CONFIG_MISSING',
      bad,
    );
  }
  assert.doesNotThrow(() => createTypesafeTransport({ baseUrl: 'https://typesafe.test/jev', apiKey: 'k' }));
});

// Item 3: a stray malformed `%` fails closed on both paths — a decode error
// is a refused baseUrl, never a clean one. A genuinely clean URL constructs.
test('r9-item3: malformed percent-encoding is refused on both paths', async () => {
  const apiKey = 'fixture key/abc+xyz';
  const baseUrl = `https://api.example.test/v1/${encodeURIComponent(apiKey)}/%ZZ/jev`;
  assert.throws(
    () => createTypesafeTransport({ baseUrl, apiKey }),
    (error) => error.code === 'JEV_CONFIG_MISSING',
  );
  let calls = 0;
  const client = createJevClient({
    apiKey,
    model: 'jev-1.13.0',
    baseUrl,
    transport: async () => { calls += 1; return { status: 200, body: baseResult() }; },
  });
  await assert.rejects(client.query(baseRequest()), (error) => {
    assert.equal(error.code, 'JEV_CONFIG_MISSING');
    return true;
  });
  assert.equal(calls, 0, 'a malformed-percent baseUrl must never dispatch');
  assert.doesNotThrow(() => createTypesafeTransport({ baseUrl: 'https://typesafe.test/jev', apiKey }));
});

// ---- M2 repair round 12 ----

// M2-R10-1: the fallback's stateDigest must equal the digest the request
// path computed for the same request — a descriptor value echoed in state
// is scrubbed on both paths, and the envelope carries only the digest.
test('r12-fallback-digest: fallback stateDigest matches the request path', () => {
  const request = baseRequest();
  request.state.goal = 'continue after hunter2fixture';
  request.questions.operation.criteria = {
    r5: { role: 'textbox', name: 'Password', value: 'hunter2fixture' },
  };
  const redacted = redactRequest(request, { secrets: [] });
  const requestDigest = stateDigestOf(redacted.state);
  const fallback = buildFallback({ request, reason: 'JEV_TIMEOUT', circuit: 'closed', secrets: [] });
  assert.equal(fallback.stateDigest, requestDigest);
  const blob = JSON.stringify(fallback);
  assert.doesNotMatch(blob, /hunter2fixture/);
  assert.doesNotMatch(blob, /continue after/);
});

// ---- M2 repair round 14 ----

// Item 1: the outbound body is exactly {state, model, questions} — measured
// through the real built-in transport with a stubbed fetch.
test('r14-wire-body: outbound body has exactly state, model, questions', async () => {
  const request = baseRequest();
  let seenUrl = null;
  let seenBody = null;
  let seenInit = null;
  const fakeFetch = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    seenBody = JSON.parse(init.body);
    return { status: 200, text: async () => JSON.stringify(baseResult()) };
  };
  const client = createJevClient({
    baseUrl: 'https://typesafe.test/jev',
    apiKey: 'explicit-operator-key',
    model: 'jev-1.13.0',
    fetchFn: fakeFetch,
  });
  const { result } = await client.query(request);
  assert.equal(result.status, 'ok');
  assert.equal(seenUrl, 'https://typesafe.test/jev');
  assert.deepEqual(Object.keys(seenBody).sort(), ['model', 'questions', 'state']);
  assert.equal(seenBody.model, 'jev-1.13.0');
  assert.equal(seenInit.method, 'POST');
  assert.equal(seenInit.headers.authorization, 'Bearer explicit-operator-key');
});

// Item 1: the wire body carries the redacted state, never the raw request.
test('r14-redacted-body: outbound body carries redacted state, not raw', async () => {
  const secret = 'rosehip42-fixture';
  const request = baseRequest();
  request.state.goal = `log in with ${secret}`;
  let seenBody = null;
  const fakeFetch = async (url, init) => {
    seenBody = JSON.parse(init.body);
    return { status: 200, text: async () => JSON.stringify(baseResult()) };
  };
  const client = createJevClient({
    baseUrl: 'https://typesafe.test/jev',
    apiKey: 'explicit-operator-key',
    model: 'jev-1.13.0',
    fetchFn: fakeFetch,
    secrets: [secret],
  });
  await client.query(request);
  assert.deepEqual(Object.keys(seenBody).sort(), ['model', 'questions', 'state']);
  assert.equal(seenBody.model, 'jev-1.13.0');
  assert.doesNotMatch(JSON.stringify(seenBody), new RegExp(secret));
  assert.doesNotMatch(seenBody.state.goal, new RegExp(secret));
});

// Item 1: the mapped result satisfies validateResult — the validator stays
// the contract for everything downstream.
test('r14-mapped-result: adapter output satisfies validateResult', async () => {
  const { validateResult } = await import('../src/jev/schemas.mjs');
  const request = baseRequest();
  const redacted = redactRequest(request, { secrets: [] });
  const mapped = toInternalResult(baseResult(), {
    request,
    stateDigest: stateDigestOf(redacted.state),
    requestDigest: digestOf(redacted),
    expectedModel: 'jev-1.13.0',
    expectedSkillDigest: null,
    latencyMs: 178,
    attempts: 1,
  });
  assert.equal(validateResult(mapped, { request }), mapped);
  assert.equal(mapped.schema, 'webmcp-jev-result/1');
  assert.equal(mapped.advisoryOnly, true);
  assert.equal(mapped.lineage.provider, 'typesafe');
  assert.deepEqual(mapped.usage, { inputTokens: 12, outputTokens: 4 });
});

// Item 2: without the attestation the canary never calls the transport.
test('r14-canary-blocked: canary without attestation never calls the transport', async () => {
  let errOut = '';
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => { errOut += String(chunk); return true; };
  let calls = 0;
  const spyFetch = async () => { calls += 1; throw new Error('must not be called'); };
  let bareCode = null;
  let liveCode = null;
  try {
    bareCode = await runJevCli(['canary'], {}, { fetchFn: spyFetch });
    liveCode = await runJevCli(['canary', '--live'], {}, { fetchFn: spyFetch });
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(bareCode, 2);
  assert.equal(liveCode, 1);
  assert.match(errOut, /BLOCKED_BY_GATE0/);
  assert.equal(calls, 0, 'blocked canary must not reach the transport');
});

// Item 2: with the attestation and a key file, the bounded live call runs
// the documented wire body through the injected fetch.
test('r14-canary-live: attested canary dispatches the documented wire body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-canary-'));
  const keyFile = join(dir, 'key');
  writeFileSync(keyFile, 'live-key-abc\n');
  chmodSync(keyFile, 0o600);
  let seenBody = null;
  let calls = 0;
  const fakeFetch = async (url, init) => {
    calls += 1;
    seenBody = JSON.parse(init.body);
    return {
      status: 200,
      text: async () => JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          operation: { type: 'choice', choice: 'CLICK', probabilities: { CLICK: 0.9, WAIT: 0.1 }, confidence: 0.9 },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    };
  };
  // Missing key material still fails closed, attested or not.
  assert.equal(
    await runJevCli(['canary', '--live', '--attest-gate0'], {}, { fetchFn: fakeFetch }),
    1,
  );
  assert.equal(calls, 0);
  const outChunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { outChunks.push(String(chunk)); return true; };
  let code = null;
  try {
    code = await runJevCli(
      ['canary', '--live', '--attest-gate0', '--key-file', keyFile, '--base-url', 'https://typesafe.test/jev'],
      {},
      { fetchFn: fakeFetch },
    );
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(code, 0);
  assert.equal(calls, 1, 'the attested canary dispatches exactly once');
  assert.deepEqual(Object.keys(seenBody).sort(), ['model', 'questions', 'state']);
  const out = JSON.parse(outChunks.join(''));
  assert.equal(out.status, 'ok');
});

// ---- M2 repair round 19 ----

// The wire body sends questions exactly as redacted: echoes hidden under a
// urlOrigin question id or ref/targetRef criteria keys never reach the wire
// raw — they are scrubbed (or the request refused before dispatch).
test('r19-wire-body: name-bypassed question echoes never reach the wire raw', async () => {
  const typed = 'hunter2fixture';
  const request = baseRequest();
  request.state.elements = [
    { ref: 'r5', role: 'textbox', name: 'Password', value: typed, enabled: true, visible: true, operations: ['CLICK'] },
  ];
  request.questions = {
    operation: {
      type: 'choice',
      instructions: { goal: 'Open settings', question: 'Choose exactly one next operation.' },
      criteria: { CLICK: null, WAIT: 'Page is loading.' },
    },
    urlOrigin: {
      type: 'noul',
      instructions: { question: `Type ${typed} into the field.` },
      criteria: { ref: `Press ${typed} now.`, targetRef: { role: 'button', name: 'Go', value: typed } },
    },
  };
  const okBody = baseResult();
  okBody.answers = {
    ...baseResult().answers,
    urlOrigin: { type: 'noul', noul: 'done' },
  };
  let seen = null;
  let calls = 0;
  const client = clientWith(async (payload) => {
    seen = payload;
    calls += 1;
    return { status: 200, body: okBody };
  });
  await client.query(request);
  assert.equal(calls, 1);
  assert.deepEqual(seen.request.questions, redactRequest(request, { secrets: [] }).questions);
  assert.doesNotMatch(JSON.stringify(seen.request.questions), new RegExp(typed));
  assert.doesNotMatch(JSON.stringify(seen.request), new RegExp(typed));
});

// ---- M2 repair round 20 ----

// Scrub-first ordering at the wire: an email-prefixed password echoed in
// goal and instructions dispatches with no fragment left raw.
test('r20-wire-body: email-prefixed password echo never reaches the wire raw', async () => {
  const typed = 'alice@home.net2024!';
  const request = baseRequest();
  request.state.elements = [
    { ref: 'r5', role: 'textbox', name: 'Password', value: typed, enabled: true, visible: true, operations: ['CLICK'] },
  ];
  request.state.goal = `Enter ${typed} to continue`;
  request.questions.operation.instructions.question = `Type ${typed} now.`;
  let seen = null;
  let calls = 0;
  const client = clientWith(async (payload) => {
    seen = payload;
    calls += 1;
    return { status: 200, body: baseResult() };
  });
  const { result } = await client.query(request);
  assert.equal(result.status, 'ok');
  assert.equal(calls, 1);
  const blob = JSON.stringify(seen.request);
  assert.doesNotMatch(blob, /2024!/);
  assert.doesNotMatch(blob, /alice/);
  assert.equal(seen.request.state.elements[0].value, '[REDACTED]');
});

// ---- M2 repair round 22 ----

// Item 3: model as a secret channel is validated against frozen format and secrets (reworked per R3).
test('r22-model-channel-format: format-invalid model rejects with JEV_REQUEST_INVALID before transport', async () => {
  let calls = 0;
  const client = createJevClient({
    apiKey: 'test-key',
    model: 'not-a-valid-model',
    transport: async () => {
      calls += 1;
      return { status: 200, body: baseResult() };
    },
  });
  await assert.rejects(client.query(baseRequest()), (error) => {
    assert.equal(error.code, 'JEV_REQUEST_INVALID');
    assert.equal(error.message, 'model violates the jev format', 'must fail for the model check, not incidentally');
    return true;
  });
  assert.equal(calls, 0, 'transport must never be called');
});

test('r22-model-channel-key: format-valid model carrying apiKey rejects with JEV_REQUEST_INVALID before transport', async () => {
  let calls = 0;
  const client = createJevClient({
    apiKey: '482913',
    model: 'jev-482913',
    transport: async () => {
      calls += 1;
      return { status: 200, body: baseResult() };
    },
  });
  await assert.rejects(client.query(baseRequest()), (error) => {
    assert.equal(error.code, 'JEV_REQUEST_INVALID');
    assert.equal(error.message, 'model carries a secret', 'must fail for the model check, not incidentally');
    return true;
  });
  assert.equal(calls, 0, 'transport must never be called');
});

test('r22-model-channel-short-key-12: short 2-char key in format-valid model rejects before transport', async () => {
  let calls = 0;
  const client = createJevClient({
    apiKey: '12',
    model: 'jev-12',
    transport: async () => {
      calls += 1;
      return { status: 200, body: baseResult() };
    },
  });
  await assert.rejects(client.query(baseRequest()), (error) => {
    assert.equal(error.code, 'JEV_REQUEST_INVALID');
    assert.equal(error.message, 'model carries a secret', 'must fail for the model check, not incidentally');
    return true;
  });
  assert.equal(calls, 0, 'transport must never be called');
});

test('r22-model-channel-short-key-dots: canonical-short key in format-valid model rejects before transport', async () => {
  let calls = 0;
  const client = createJevClient({
    apiKey: '..7',
    model: 'jev-7',
    transport: async () => {
      calls += 1;
      return { status: 200, body: baseResult() };
    },
  });
  await assert.rejects(client.query(baseRequest()), (error) => {
    assert.equal(error.code, 'JEV_REQUEST_INVALID');
    assert.equal(error.message, 'model carries a secret', 'must fail for the model check, not incidentally');
    return true;
  });
  assert.equal(calls, 0, 'transport must never be called');
});

test('r22-model-valid-dispatches: valid model jev-1.13.0 still dispatches to transport', async () => {
  let calls = 0;
  let seen = null;
  const client = createJevClient({
    apiKey: 'test-key-not-a-secret',
    model: 'jev-1.13.0',
    transport: async (payload) => {
      calls += 1;
      seen = payload;
      return { status: 200, body: baseResult({ model: 'jev-1.13.0' }) };
    },
  });
  const { result } = await client.query(baseRequest());
  assert.equal(result.status, 'ok');
  assert.equal(calls, 1, 'transport must be called');
  assert.equal(seen.request.model, 'jev-1.13.0');
});

test('r22-toWireBody-safe-model: toWireBody refuses key-bearing, format-invalid, or missing-secrets option', () => {
  const req = redactRequest(baseRequest(), { secrets: [] });
  // Format-valid model carrying secret refused
  assert.throws(
    () => toWireBody(req, 'jev-482913', { secrets: ['482913'] }),
    (error) => error.code === 'JEV_REQUEST_INVALID' && error.message === 'model carries a secret',
  );
  // Format-invalid model refused
  assert.throws(
    () => toWireBody(req, 'not-a-valid-model', { secrets: [] }),
    (error) => error.code === 'JEV_REQUEST_INVALID' && error.message === 'model violates the jev format',
  );
  // Missing secrets option fails closed (R2b)
  assert.throws(
    () => toWireBody(req, 'jev-1.13.0'),
    (error) => error.code === 'JEV_REQUEST_INVALID' && error.message === 'toWireBody requires an explicit secrets array',
  );
  // Format-valid model with secrets array passes
  const wire = toWireBody(req, 'jev-1.13.0', { secrets: [] });
  assert.equal(wire.model, 'jev-1.13.0');
});

test('r23-model-request-value: request-derived OTP in model rejects before transport', async () => {
  const request = baseRequest();
  request.state.elements.push({ ref: 'otp', role: 'textbox', name: 'OTP', value: '482913', enabled: true, visible: true, operations: ['TYPE_TEXT'] });
  let calls = 0;
  const client = createJevClient({ apiKey: 'test-key', model: 'jev-482913', transport: async () => {
    calls += 1;
    return { status: 200, body: baseResult() };
  } });
  await assert.rejects(client.query(request),
    (error) => error.code === 'JEV_REQUEST_INVALID' && error.message === 'model carries a secret');
  assert.equal(calls, 0);
});

test('r24-split OTP boxes do not reject ordinary pinned model', async () => {
  const request = baseRequest();
  request.state.elements = ['4', '8', '2', '9', '1', '3'].map((value, i) => ({
    ref: `b${i}`, role: 'textbox', name: '', value, parentContext: ['Enter OTP'],
    enabled: true, visible: true, operations: ['TYPE_TEXT'],
  }));
  let calls = 0;
  const client = clientWith(async () => { calls++; return { status: 200, body: baseResult() }; }, { apiKey: 'k' });
  await client.query(request);
  assert.equal(calls, 1);
});

test('r24-declared and request-derived secrets in baseUrl reject before dispatch', async () => {
  for (const [secret, request] of [
    ['hunter22', baseRequest()],
    [null, (() => { const r = baseRequest(); r.state.elements.push({ ref: 'otp', role: 'textbox', name: 'OTP', value: '482913', enabled: true, visible: true, operations: ['TYPE_TEXT'] }); return r; })()],
  ]) {
    let calls = 0;
    const baseUrl = `https://example.test/${secret ?? '482913'}`;
    const client = clientWith(async () => { calls++; return { status: 200, body: baseResult() }; }, { baseUrl, secrets: secret ? [secret] : [] });
    await assert.rejects(client.query(request), (error) => error.code === 'JEV_CONFIG_MISSING' && !error.message.includes(secret ?? '482913'));
    assert.equal(calls, 0);
  }
});

test('r24-model getters refuse a tainted pin after a rejected request', async () => {
  const request = baseRequest();
  request.state.elements.push({ ref: 'otp', role: 'textbox', name: 'OTP', value: '482913', enabled: true, visible: true, operations: ['TYPE_TEXT'] });
  const client = clientWith(async () => ({ status: 200, body: baseResult() }), { apiKey: 'k', model: 'jev-482913' });
  await assert.rejects(client.query(request), (error) => error.code === 'JEV_REQUEST_INVALID');
  assert.throws(() => client.getPinnedModel(), (error) => error.code === 'JEV_REQUEST_INVALID' && error.message === 'model carries a secret');
  assert.throws(() => client.getLastModel(), (error) => error.code === 'JEV_REQUEST_INVALID' && error.message === 'model carries a secret');
});

test('r23-baseUrl-short-key: two-character key in URL rejects before dispatch', async () => {
  let calls = 0;
  const client = createJevClient({ apiKey: '12', baseUrl: 'https://example.test/12', model: 'jev-1.13.0', transport: async () => {
    calls += 1;
    return { status: 200, body: baseResult() };
  } });
  await assert.rejects(client.query(baseRequest()),
    (error) => error.code === 'JEV_CONFIG_MISSING' && error.message === 'typesafe transport refuses a baseUrl containing the api key');
  assert.equal(calls, 0);
});

test('r23-fallback-pattern-parity: question assignment echoed in state uses the request digest', () => {
  const request = baseRequest();
  request.state.goal = 'Use SecretVal123 now';
  request.questions.operation.instructions.question = 'Enter password: SecretVal123';
  const sentDigest = stateDigestOf(redactRequest(request, { secrets: [] }).state);
  const fallback = buildFallback({ request, reason: 'JEV_TIMEOUT', circuit: 'closed', secrets: [] });
  assert.equal(fallback.stateDigest, sentDigest);
});

test('Q2 ref remap: outbound request carries e1..eN and inbound answer maps e2 to original ref', async () => {
  const request = baseRequest();
  request.state.elements = [
    { ref: 'input-user', role: 'textbox', name: 'User', value: '', enabled: true, visible: true, operations: ['TYPE_TEXT'] },
    { ref: 'btn-submit', role: 'button', name: 'Submit', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  request.questions = {
    operation: {
      type: 'choice',
      instructions: { question: 'Choose next element' },
      criteria: { 'input-user': null, 'btn-submit': null, WAIT: null },
    },
    target: {
      type: 'noul',
      instructions: { question: 'Target ref' },
    },
  };

  let capturedPayload = null;
  const client = clientWith(async (payload) => {
    capturedPayload = payload;
    return {
      status: 200,
      body: {
        model: 'jev-1.13.0',
        answers: {
          operation: { type: 'choice', choice: 'e2', probabilities: { e1: 0.1, e2: 0.85, WAIT: 0.05 }, confidence: 0.9 },
          target: { type: 'noul', noul: 'e2' },
        },
        usage: { input_tokens: 12, output_tokens: 4 },
      },
    };
  });

  const { result } = await client.query(request);

  // Outbound request carries e1..eN
  assert.equal(capturedPayload.request.state.elements[0].ref, 'e1');
  assert.equal(capturedPayload.request.state.elements[1].ref, 'e2');
  assert.deepEqual(Object.keys(capturedPayload.request.questions.operation.criteria), ['e1', 'e2', 'WAIT']);

  // Inbound answer referencing e2 comes back to the caller as original ref btn-submit for choice, but noul is NOT rewritten
  assert.equal(result.answers.operation.choice, 'btn-submit');
  assert.equal(result.answers.target.noul, 'e2', 'noul answers must not be remapped even if equal to remapped ref');
  assert.ok('btn-submit' in result.answers.operation.probabilities);
  assert.ok('input-user' in result.answers.operation.probabilities);
  assert.ok('WAIT' in result.answers.operation.probabilities);
});

test('Q2 ref remap: an answer value that is not a ref is unchanged', async () => {
  const request = baseRequest();
  request.state.elements = [
    { ref: 'input-user', role: 'textbox', name: 'User', value: '', enabled: true, visible: true, operations: ['TYPE_TEXT'] },
    { ref: 'btn-submit', role: 'button', name: 'Submit', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  request.questions = {
    operation: {
      type: 'choice',
      instructions: { question: 'Choose next operation' },
      criteria: { 'input-user': null, 'btn-submit': null, WAIT: null },
    },
    target: {
      type: 'noul',
      instructions: { question: 'Target value or text' },
    },
  };

  const client = clientWith(async () => ({
    status: 200,
    body: {
      model: 'jev-1.13.0',
      answers: {
        operation: { type: 'choice', choice: 'WAIT', probabilities: { e1: 0.1, e2: 0.2, WAIT: 0.7 }, confidence: 0.9 },
        target: { type: 'noul', noul: 'not-a-remapped-ref' },
      },
      usage: { input_tokens: 12, output_tokens: 4 },
    },
  }));

  const { result } = await client.query(request);

  assert.equal(result.answers.operation.choice, 'WAIT');
  assert.equal(result.answers.target.noul, 'not-a-remapped-ref');
});

test('Q2 ref remap: answer referencing e99 (not one of the remapped refs) is not mapped', async () => {
  const request = baseRequest();
  request.state.elements = [
    { ref: 'btn-back', role: 'button', name: 'Back', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  request.questions = {
    operation: {
      type: 'choice',
      instructions: { question: 'Choose next operation' },
      criteria: { CLICK: null, WAIT: null },
    },
    target: {
      type: 'noul',
      instructions: { question: 'Target ref' },
    },
  };

  const client = clientWith(async () => ({
    status: 200,
    body: {
      model: 'jev-1.13.0',
      answers: {
        operation: { type: 'choice', choice: 'CLICK', probabilities: { CLICK: 0.9, WAIT: 0.1 }, confidence: 0.9 },
        target: { type: 'noul', noul: 'e99' },
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  }));

  const { result } = await client.query(request);
  assert.equal(result.answers.target.noul, 'e99');
});

test('W3 & W6: mixing e<N> refs on answer path maps choice correctly, leaves noul untouched', async () => {
  const request = baseRequest();
  request.state.elements = [
    { ref: 'e2', role: 'button', name: 'go', value: '', enabled: true, visible: true, operations: ['CLICK'] },
    { ref: 'bar', role: 'button', name: 'stop', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  request.questions = {
    operation: {
      type: 'choice',
      instructions: { question: 'Pick button' },
      criteria: { e2: null, bar: null },
    },
    literal: {
      type: 'noul',
      instructions: { question: 'Literal token' },
    },
  };

  let capturedPayload = null;
  const client = clientWith(async (payload) => {
    capturedPayload = payload;
    return {
      status: 200,
      body: {
        model: 'jev-1.13.0',
        answers: {
          operation: { type: 'choice', choice: 'e1', probabilities: { e1: 0.8, e2: 0.2 }, confidence: 0.8 },
          literal: { type: 'noul', noul: 'e1' },
        },
        usage: { input_tokens: 10, output_tokens: 4 },
      },
    };
  });

  const { result } = await client.query(request);

  // Wire outbound: e2 -> e1, bar -> e2
  assert.equal(capturedPayload.request.state.elements[0].ref, 'e1');
  assert.equal(capturedPayload.request.state.elements[1].ref, 'e2');
  assert.deepEqual(Object.keys(capturedPayload.request.questions.operation.criteria).sort(), ['e1', 'e2']);

  // Wire inbound choice e1 maps back to caller ref e2 (NOT confused with e1!)
  assert.equal(result.answers.operation.choice, 'e2');
  assert.ok('e2' in result.answers.operation.probabilities);
  assert.ok('bar' in result.answers.operation.probabilities);

  // W6: noul answer equal to remapped ref 'e1' is NOT rewritten
  assert.equal(result.answers.literal.noul, 'e1');
});

test('X1: duplicate caller refs reverse e1 and e2 to same caller ref, non-ref unchanged', async () => {
  const request = baseRequest();
  request.state.elements = [
    { ref: 'x', role: 'button', name: 'Submit', value: '', enabled: true, visible: true, operations: ['CLICK'] },
    { ref: 'x', role: 'button', name: 'Confirm', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  request.questions = {
    operation: {
      type: 'choice',
      instructions: { question: 'Pick first' },
      criteria: { CLICK: null, x: null },
    },
    second: {
      type: 'choice',
      instructions: { question: 'Pick second' },
      criteria: { CLICK: null, x: null },
    },
    nonRef: {
      type: 'choice',
      instructions: { question: 'Pick op' },
      criteria: { CLICK: null },
    },
  };

  const client = clientWith(async () => ({
    status: 200,
    body: {
      model: 'jev-1.13.0',
      answers: {
        operation: { type: 'choice', choice: 'e1', probabilities: { CLICK: 0.1, e1: 0.9 }, confidence: 0.9 },
        second: { type: 'choice', choice: 'e2', probabilities: { CLICK: 0.1, e2: 0.9 }, confidence: 0.9 },
        nonRef: { type: 'choice', choice: 'CLICK', probabilities: { CLICK: 1.0 }, confidence: 1.0 },
      },
      usage: { input_tokens: 10, output_tokens: 6 },
    },
  }));

  const { result } = await client.query(request);
  // Both e1 and e2 reverse to caller's duplicate ref 'x'
  assert.equal(result.answers.operation.choice, 'x');
  assert.equal(result.answers.second.choice, 'x');
  // Probabilities are also remapped
  assert.equal(result.answers.operation.probabilities.x, 0.9);
  assert.equal(result.answers.second.probabilities.x, 0.9);
  // Non-ref answer value is unchanged
  assert.equal(result.answers.nonRef.choice, 'CLICK');
});

// ---------------------------------------------------------------------------
// M2 Round 22 Revision 35: Y1 Client Regression Test
// ---------------------------------------------------------------------------

test('Y1: mixed aliased elements and questions round trip correctly', async () => {
  const a = { ref: 'btn', role: 'button', name: 'Action', value: '', enabled: true, visible: true, operations: ['CLICK'] };
  const q = {
    type: 'choice',
    instructions: { question: 'Select' },
    criteria: { btn: null, CLICK: null },
  };
  const request = baseRequest();
  request.state.elements = [a, a];
  request.questions = { operation: q, second: q };

  let capturedPayload = null;
  const client = clientWith(async (payload) => {
    capturedPayload = payload;
    return {
      status: 200,
      body: {
        model: 'jev-1.13.0',
        answers: {
          operation: { type: 'choice', choice: 'e1', probabilities: { e1: 0.9, CLICK: 0.1 }, confidence: 0.9 },
          second: { type: 'choice', choice: 'e2', probabilities: { e2: 0.8, CLICK: 0.2 }, confidence: 0.8 },
        },
        usage: { input_tokens: 15, output_tokens: 6 },
      },
    };
  });

  const { result } = await client.query(request);

  // Outbound wire body has unique refs e1 and e2
  assert.equal(capturedPayload.request.state.elements[0].ref, 'e1');
  assert.equal(capturedPayload.request.state.elements[1].ref, 'e2');
  assert.ok('e1' in capturedPayload.request.questions.operation.criteria);
  assert.ok('e1' in capturedPayload.request.questions.second.criteria);

  // Inbound answers e1 and e2 both map back to caller ref 'btn'
  assert.equal(result.answers.operation.choice, 'btn');
  assert.equal(result.answers.second.choice, 'btn');
  assert.equal(result.answers.operation.probabilities.btn, 0.9);
  assert.equal(result.answers.second.probabilities.btn, 0.8);
});
