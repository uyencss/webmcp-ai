// M2 redaction tests: DESIGN D closed-alphabet projection.
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readKeyFile } from '../src/jev/transport.mjs';
import {
  redactState,
  redactRequest,
  redactQuestions,
  redactString,
  containsSecret,
  toOriginOnly,
  digestOf,
  stateDigestOf,
  normLabel,
  canonicalForMatch,
  canonicalJson,
  sha256Hex,
  fragmentScan,
  assertSafeKey,
  assertNoPayloadReassembly,
  isStandardRole,
  projectFreeText,
  V,
  NON_VALUE_HINT_WORDS,
  REDACTED,
} from '../src/jev/redact.mjs';
import { buildFallback } from '../src/jev/fallback.mjs';
import { DETECTOR_KINDS } from '../src/jev/schemas.mjs';

const SECRET = 'fixture-secret-abc123';
const DIGEST = `sha256:${'ab'.repeat(32)}`;

function baseState() {
  return {
    snapshotDigest: DIGEST,
    urlOrigin: 'https://example.test',
    goal: 'Open settings',
    elements: [
      { ref: 'r5', role: 'button', name: 'Settings', value: 'my-value', enabled: true, visible: true, operations: ['CLICK'] },
    ],
    recentActions: [],
  };
}

function baseRequest() {
  return {
    schema: 'webmcp-jev-request/1',
    requestId: 'run_1@browser-step-7',
    kind: 'browser-step',
    state: baseState(),
    questionSet: { id: 'browser-step', version: 1, digest: DIGEST },
    questions: {
      operation: {
        type: 'choice',
        instructions: { goal: 'Open settings', question: 'Choose exactly one next operation.' },
        criteria: { CLICK: null, WAIT: 'Page is loading.' },
      },
    },
    bounds: { maxStateBytes: 32768, maxQuestions: 8, timeoutMs: 2000, maxRetries: 0 },
    caller: { runId: 'run-1', permitId: null },
    fallbackPolicy: 'normal-agent',
  };
}

// ---------------------------------------------------------------------------
// P1 Rule 1 — Page free text tokenization & closed vocabulary V
// ---------------------------------------------------------------------------

test('P1 Rule 1: V contains no digits and no single-character tokens, sorted and stable', () => {
  assert.ok(Array.isArray(V) && V.length > 100, 'V must be published with non-trivial size');
  assert.ok(Object.isFrozen(V), 'V must be frozen');
  for (const word of V) {
    assert.ok(word.length >= 2, `word "${word}" must have length >= 2`);
    assert.doesNotMatch(word, /\d/, `word "${word}" must contain no digits`);
    assert.equal(word, word.normalize('NFKC').toLowerCase(), `word "${word}" must be NFKC lowercased`);
  }
  const copy = [...V];
  copy.sort();
  assert.deepEqual(V, copy, 'V must be kept sorted and stable');
});

test('P1 Rule 1: projectFreeText NFKC-normalizes, lowercases, maps to V or …/#', () => {
  // Known V words stay as lowercase V words
  assert.equal(projectFreeText('Settings'), 'settings');
  assert.equal(projectFreeText('Password:'), 'password');
  assert.equal(projectFreeText('Sign in'), 'sign in');
  assert.equal(projectFreeText('Mật khẩu:'), 'mật khẩu');

  // Unknown tokens become …
  assert.equal(projectFreeText('hunter22'), '…');
  assert.equal(projectFreeText('Password: hunter22'), 'password …');
  assert.equal(projectFreeText('Show password Password1!'), 'show password …');

  // Numerals become #
  assert.equal(projectFreeText('1234'), '#');
  assert.equal(projectFreeText('Code 482913'), 'code #');
  assert.equal(projectFreeText('PIN: -4821'), 'pin #');
  assert.equal(projectFreeText('Phone: +84'), 'phone #');

  // Look-alikes and zero-width / fullwidth normalization
  assert.equal(projectFreeText('Ｐａｓｓｗｏｒｄ'), 'password');
  assert.equal(projectFreeText('Pass\u200bword'), 'password');

  // Empty or punctuation-only returns empty string
  assert.equal(projectFreeText(''), '');
  assert.equal(projectFreeText(':::'), '');
  assert.equal(projectFreeText('   '), '');
});

test('P1 Rule 1: element.name, parentContext, criteria descriptor name, and captchaEvidence projected', () => {
  const req = baseRequest();
  req.state.elements[0].name = 'Password: hunter22';
  req.state.elements[0].parentContext = ['Authentication code: 482913', 'Step 2 of 3'];
  req.state.captchaEvidence = {
    detectorKind: 'turnstile',
    sitekey: '0x4AAAAAA',
    evidence: 'Token data abc123def',
    fingerprint: 'fp-777-secret',
    action: 'submit',
    interactive: false,
    solvableByPackage: true,
  };
  req.questions.operation.criteria.CLICK = { role: 'button', name: 'Show password Password1!' };

  const redacted = redactRequest(req, { secrets: [] });

  assert.equal(redacted.state.elements[0].name, 'password …');
  assert.deepEqual(redacted.state.elements[0].parentContext, ['… code #', 'step # of #']);
  assert.equal(redacted.state.captchaEvidence.evidence, 'token data …');
  assert.equal(redacted.state.captchaEvidence.fingerprint, '… # secret');
  assert.equal(redacted.state.captchaEvidence.action, 'submit');
  assert.equal(redacted.questions.operation.criteria.CLICK.name, 'show password …');
});

// ---------------------------------------------------------------------------
// P1 Rule 2 — Values → [REDACTED]
// ---------------------------------------------------------------------------

test('P1 Rule 2: non-empty values become [REDACTED], empty stay empty, booleans untouched', () => {
  const req = baseRequest();
  req.state.elements[0].value = 'hunter22';
  req.state.elements.push({
    ref: 'r6',
    role: 'checkbox',
    name: 'Remember me',
    value: '',
    checked: true,
    selected: false,
    expanded: true,
    enabled: true,
    visible: true,
    operations: ['CLICK'],
  });
  req.state.recentActions = [
    { operation: 'TYPE_TEXT', targetRef: 'r5', text: 'my-typed-pass', values: ['val1', '', 'val2'] },
  ];
  req.questions.operation.criteria = {
    CLICK: { role: 'button', name: 'Submit', value: 'secret-val' },
    WAIT: 'waiting-value',
    options: ['arr-val-1', '', 'arr-val-2'],
  };

  const redacted = redactRequest(req, { secrets: [] });

  assert.equal(redacted.state.elements[0].value, REDACTED);
  assert.equal(redacted.state.elements[1].value, '');
  assert.equal(redacted.state.elements[1].checked, true);
  assert.equal(redacted.state.elements[1].selected, false);
  assert.equal(redacted.state.elements[1].expanded, true);
  assert.equal(redacted.state.elements[1].enabled, true);
  assert.equal(redacted.state.elements[1].visible, true);

  assert.equal(redacted.state.recentActions[0].text, REDACTED);
  assert.deepEqual(redacted.state.recentActions[0].values, [REDACTED, '', REDACTED]);

  assert.equal(redacted.questions.operation.criteria.CLICK.value, REDACTED);
  assert.equal(redacted.questions.operation.criteria.WAIT, REDACTED);
  assert.deepEqual(redacted.questions.operation.criteria.options, [REDACTED, '', REDACTED]);
});

// ---------------------------------------------------------------------------
// P1 Rule 3 — Roles
// ---------------------------------------------------------------------------

test('P1 Rule 3: standard roles kept (lowercased), non-standard become generic', () => {
  const req = baseRequest();
  req.state.elements[0].role = 'BUTTON';
  req.state.elements.push({
    ref: 'r6',
    role: 'custom-widget-secret',
    name: 'Custom',
    value: '',
    enabled: true,
    visible: true,
    operations: ['CLICK'],
  });
  req.questions.operation.criteria = {
    CLICK: { role: 'textbox', name: 'Input' },
    WAIT: { role: 'malicious-role-hunter22', name: 'Wait' },
  };

  const redacted = redactRequest(req, { secrets: [] });

  assert.equal(redacted.state.elements[0].role, 'button');
  assert.equal(redacted.state.elements[1].role, 'generic');
  assert.equal(redacted.questions.operation.criteria.CLICK.role, 'textbox');
  assert.equal(redacted.questions.operation.criteria.WAIT.role, 'generic');
});

// ---------------------------------------------------------------------------
// P1 Rule 4 — Criteria keys
// ---------------------------------------------------------------------------

test('P1 Rule 4: frozen enum, remapped ref, and V* word string criteria keys pass', () => {
  const req = baseRequest();
  req.questions.operation.criteria = {
    CLICK: null,
    answer: 'Done',
    r5: null,
    'sign in': null,
    'password': null,
  };

  const redacted = redactRequest(req, { secrets: [] });
  assert.ok('CLICK' in redacted.questions.operation.criteria);
  assert.ok('answer' in redacted.questions.operation.criteria);
  assert.ok('e1' in redacted.questions.operation.criteria);
  assert.ok('sign in' in redacted.questions.operation.criteria);
  assert.ok('password' in redacted.questions.operation.criteria);
});

test('P1 Rule 4: criteria key outside allowed set throws JEV_REQUEST_INVALID', () => {
  for (const badKey of ['hunter22', '482913', 'Password hunter22', 'SecretKey1', '']) {
    const req = baseRequest();
    req.questions.operation.criteria = { [badKey]: null };
    assert.throws(
      () => redactRequest(req, { secrets: [] }),
      (err) => err.code === 'JEV_REQUEST_INVALID',
      `key "${badKey}" must be rejected`,
    );
  }
});

test('M2 amendment 2026-09-24: captcha-classify criteria keys are the frozen detector-kind vocabulary', () => {
  const req = baseRequest();
  req.kind = 'captcha-classify';
  req.questions = {
    captcha_kind: {
      type: 'choice',
      instructions: { goal: 'Classify captcha on page', question: 'Identify detector kind.' },
      criteria: Object.fromEntries(DETECTOR_KINDS.map((kind) => [kind, null])),
    },
  };
  const redacted = redactRequest(req, { secrets: [] });
  for (const kind of DETECTOR_KINDS) {
    assert.ok(kind in redacted.questions.captcha_kind.criteria, `detector kind "${kind}" must survive the projection`);
  }

  const bad = baseRequest();
  bad.kind = 'captcha-classify';
  bad.questions = {
    captcha_kind: {
      type: 'choice',
      instructions: { goal: 'Classify captcha on page', question: 'Identify detector kind.' },
      criteria: { hunter22: null },
    },
  };
  assert.throws(
    () => redactRequest(bad, { secrets: [] }),
    (err) => err.code === 'JEV_REQUEST_INVALID',
    'a non-vocabulary classify key must still be refused',
  );
});

// ---------------------------------------------------------------------------
// P1 Rule 5 — Sitekey digest & urlOrigin
// ---------------------------------------------------------------------------

test('P1 Rule 5: sitekey replaced with stable sha256 digest, urlOrigin kept toOriginOnly', () => {
  const req = baseRequest();
  req.state.urlOrigin = 'https://example.test:8443/app/path?query=token123#fragment';
  req.state.captchaEvidence = {
    detectorKind: 'turnstile',
    sitekey: 'my-site-key-12345',
    evidence: 'evidence',
    fingerprint: 'fp',
    interactive: false,
    solvableByPackage: true,
  };

  const redacted = redactRequest(req, { secrets: [] });

  assert.equal(redacted.state.urlOrigin, 'https://example.test:8443');
  assert.equal(
    redacted.state.captchaEvidence.sitekey,
    `sha256:${sha256Hex('my-site-key-12345')}`,
  );
});

// ---------------------------------------------------------------------------
// P1 Rule 6 — Caller prose
// ---------------------------------------------------------------------------

test('P1 Rule 6: state.goal and questions.*.instructions.* pass through redactString', () => {
  const req = baseRequest();
  req.state.goal = `Log in with ${SECRET} and bearer sk-1234567890abcdef`;
  req.questions.operation.instructions.question = `Send to admin@example.test with ${SECRET}`;

  const redacted = redactRequest(req, { secrets: [SECRET] });

  assert.doesNotMatch(redacted.state.goal, new RegExp(SECRET));
  assert.doesNotMatch(redacted.state.goal, /sk-1234567890abcdef/);
  assert.doesNotMatch(redacted.questions.operation.instructions.question, new RegExp(SECRET));
  assert.doesNotMatch(redacted.questions.operation.instructions.question, /admin@example\.test/);
});

// ---------------------------------------------------------------------------
// P1 Rule 7 — Declared secret layer and assertNoPayloadReassembly
// ---------------------------------------------------------------------------

test('P1 Rule 7: declared secrets are scrubbed across payload', () => {
  const req = baseRequest();
  req.state.goal = `Goal with ${SECRET}`;
  req.state.elements[0].name = `Settings ${SECRET}`;
  const redacted = redactRequest(req, { secrets: [SECRET] });
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(SECRET));
});

test('P1 Rule 7: assertNoPayloadReassembly throws when declared secret is split across fields', () => {
  const sec = 'submitbutton';
  const req = baseRequest();
  req.state.goal = 'submit';
  req.questions.operation.instructions = { question: 'button' };
  assert.throws(
    () => redactRequest(req, { secrets: [sec] }),
    (err) => err.code === 'JEV_REQUEST_INVALID',
  );
});

// ---------------------------------------------------------------------------
// Total projection: page-state projection never throws
// ---------------------------------------------------------------------------

test('Total projection: redactState never throws on arbitrary malformed inputs', () => {
  const nastyStates = [
    null,
    undefined,
    {},
    { elements: null },
    { elements: [null, undefined, 123, 'str', {}] },
    { elements: [{ ref: '!invalid-ref!', role: 999, name: null, value: undefined }] },
    { recentActions: [null, { operation: 'UNKNOWN', text: null, values: [null, 123] }] },
    { captchaEvidence: { sitekey: null, fingerprint: 123 } },
    { urlOrigin: 'not-a-valid-url-at-all' },
  ];

  for (const s of nastyStates) {
    assert.doesNotThrow(() => redactState(s, { secrets: [] }));
  }
});

test('Total projection: buildFallback can always compute stateDigest', () => {
  const req = baseRequest();
  req.state.elements[0].name = 'Password 48291357';
  req.state.elements[0].value = 'hunter22';

  const fb = buildFallback({ request: req, reason: 'JEV_TIMEOUT', circuit: 'closed', secrets: [] });
  assert.equal(fb.status, 'fallback-required');
  assert.match(fb.stateDigest, /^sha256:[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// P2 — Falsification Test (Required)
// ---------------------------------------------------------------------------

test('P2 Falsification: fuzz page fields with Unicode, digits, look-alikes, N-way splits', () => {
  const fuzzStrings = [
    'hunter22',
    '482913',
    'Password1!',
    'PIN-4821',
    'CVV: 123',
    'Mật khẩu: Password123',
    'Ｐａｓｓｗｏｒｄ',
    'Pass\u200bword\u200d123',
    'عربى1234',
    'русский_пароль',
    '密码123',
    '🔑✨🔒',
    '--4829--',
    'foo.bar@baz.com',
    'A',
    '1',
    '9999999999999999',
    'Mixed123Words And Valid Settings Here',
  ];

  for (const str of fuzzStrings) {
    const req = baseRequest();
    req.state.elements = [
      {
        ref: 'e1',
        role: `button_${str}`,
        name: `Name ${str}`,
        value: str,
        enabled: true,
        visible: true,
        operations: ['CLICK'],
        parentContext: [`Context ${str}`, str],
      },
    ];
    req.state.recentActions = [
      { operation: 'TYPE_TEXT', targetRef: 'e1', text: str, values: [str, ''] },
    ];
    req.state.captchaEvidence = {
      detectorKind: 'turnstile',
      sitekey: str,
      evidence: `Evidence ${str}`,
      fingerprint: `Fingerprint ${str}`,
      action: str,
      interactive: false,
      solvableByPackage: true,
    };
    req.questions.operation.criteria = {
      CLICK: { role: `role_${str}`, name: `DescName ${str}`, value: str },
      WAIT: str,
      options: [str, ''],
    };

    let redacted;
    assert.doesNotThrow(() => {
      redacted = redactRequest(req, { secrets: [] });
    }, `redactRequest must never throw on fuzz input "${str}"`);

    // Schema path verification:
    const vSet = new Set(V);
    const assertTokens = (text, path) => {
      if (!text) return;
      const tokens = text.split(/\s+/).filter(Boolean);
      for (const t of tokens) {
        assert.ok(
          vSet.has(t) || t === '…' || t === '#',
          `Token "${t}" at ${path} must be in V or …/# (full text: "${text}")`,
        );
      }
    };

    // 1. Elements
    for (let i = 0; i < redacted.state.elements.length; i++) {
      const el = redacted.state.elements[i];
      assertTokens(el.name, `elements[${i}].name`);
      assert.ok(el.value === '' || el.value === REDACTED, `elements[${i}].value must be '' or [REDACTED]`);
      assert.ok(isStandardRole(el.role), `elements[${i}].role "${el.role}" must be standard role`);
      assert.match(el.ref, /^e\d+$/, `elements[${i}].ref "${el.ref}" must match e\\d+`);
      if (Array.isArray(el.parentContext)) {
        for (let j = 0; j < el.parentContext.length; j++) {
          assertTokens(el.parentContext[j], `elements[${i}].parentContext[${j}]`);
        }
      }
    }

    // 2. RecentActions
    for (let i = 0; i < redacted.state.recentActions.length; i++) {
      const act = redacted.state.recentActions[i];
      assert.ok(act.text === '' || act.text === REDACTED, `recentActions[${i}].text must be '' or [REDACTED]`);
      if (Array.isArray(act.values)) {
        for (let j = 0; j < act.values.length; j++) {
          assert.ok(act.values[j] === '' || act.values[j] === REDACTED, `recentActions[${i}].values[${j}]`);
        }
      }
    }

    // 3. CaptchaEvidence
    const ce = redacted.state.captchaEvidence;
    assertTokens(ce.evidence, 'captchaEvidence.evidence');
    assertTokens(ce.fingerprint, 'captchaEvidence.fingerprint');
    assertTokens(ce.action, 'captchaEvidence.action');
    assert.match(ce.sitekey, /^sha256:[0-9a-f]{64}$/, 'captchaEvidence.sitekey must be a sha256 digest');

    // 4. Criteria
    const crit = redacted.questions.operation.criteria;
    assert.ok(isStandardRole(crit.CLICK.role), 'criteria.CLICK.role must be standard role');
    assertTokens(crit.CLICK.name, 'criteria.CLICK.name');
    assert.ok(crit.CLICK.value === '' || crit.CLICK.value === REDACTED, 'criteria.CLICK.value');
    assert.ok(crit.WAIT === '' || crit.WAIT === REDACTED, 'criteria.WAIT');
    assert.ok(crit.options[0] === '' || crit.options[0] === REDACTED, 'criteria.options[0]');
  }
});

// ---------------------------------------------------------------------------
// Existing essential guards kept green
// ---------------------------------------------------------------------------

test('builtin patterns catch bearer-like tokens without a list', () => {
  const token = 'sk-fixture1234567890abcdef';
  assert.equal(containsSecret(`key ${token}`, []), true);
  assert.doesNotMatch(redactString(`key ${token}`, []), new RegExp(token));
});

test('toOriginOnly strips paths, queries and credentials', () => {
  assert.equal(toOriginOnly('https://example.test/path?q=1#frag'), 'https://example.test');
  assert.equal(toOriginOnly('http://user:pass@example.test:8080/'), 'http://user:pass@example.test:8080/');
  assert.equal(toOriginOnly('https://example.test:8443'), 'https://example.test:8443');
});

test('canonicalJson and digests are stable across key order', () => {
  const a = digestOf({ z: 1, a: 2 });
  const b = digestOf({ a: 2, z: 1 });
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test('assertSafeKey rejects keys carrying declared secrets or PII', () => {
  assert.throws(
    () => assertSafeKey('key-secret123', { secrets: ['secret123'] }),
    (err) => err.code === 'JEV_REQUEST_INVALID',
  );
  assert.throws(
    () => assertSafeKey('alice@example.test', {}),
    (err) => err.code === 'JEV_REQUEST_INVALID',
  );
  assert.doesNotThrow(() => assertSafeKey('clean-key', { secrets: ['other'] }));
});

test('r6-sol2: key file errors carry static wording without the path', () => {
  const bad = join(tmpdir(), 'r6-sol2-marker-dir', 'missing.key');
  assert.throws(() => readKeyFile(bad), (error) => {
    assert.equal(error.code, 'JEV_CONFIG_MISSING');
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error.details)}`, /r6-sol2-marker-dir/);
    return true;
  });
});

test('Q1: element captchaEvidence fields projected (evidence, fingerprint, action, sitekey)', () => {
  const req = baseRequest();
  req.state.elements.push({
    ref: 'cap1',
    role: 'generic',
    name: 'captcha',
    value: '',
    enabled: true,
    visible: true,
    operations: ['CLICK'],
    captchaEvidence: {
      detectorKind: 'turnstile',
      evidence: 'Token data abc123def',
      fingerprint: 'fp-777-secret',
      action: 'submit',
      sitekey: 'my-element-sitekey-456',
    },
  });

  const redacted = redactRequest(req, { secrets: [] });
  const elCe = redacted.state.elements[1].captchaEvidence;

  assert.equal(elCe.evidence, 'token data …');
  assert.equal(elCe.fingerprint, '… # secret');
  assert.equal(elCe.action, 'submit');
  assert.equal(elCe.sitekey, `sha256:${sha256Hex('my-element-sitekey-456')}`);
});

test('Q1: element captchaEvidence sitekey digest form matches sha256 pattern', () => {
  const req = baseRequest();
  const rawKey = '0x4AAAAAAAX123456789';
  req.state.elements[0].captchaEvidence = {
    sitekey: rawKey,
  };

  const redacted = redactRequest(req, { secrets: [] });
  const sitekey = redacted.state.elements[0].captchaEvidence.sitekey;

  assert.match(sitekey, /^sha256:[0-9a-f]{64}$/);
  assert.equal(sitekey, `sha256:${sha256Hex(rawKey)}`);
});

test('Q1: element captchaEvidence projection is total and never throws on malformed shapes', () => {
  for (const ce of [null, undefined, 42, 'string', [], {}, { sitekey: 123 }, { evidence: null }]) {
    const req = baseRequest();
    req.state.elements[0].captchaEvidence = ce;
    assert.doesNotThrow(() => redactRequest(req, { secrets: [] }));
  }
});

test('Q2: redactRequest accepts optional refMap and fills it', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: 'btn-back', role: 'button', name: 'Back', value: '', enabled: true, visible: true, operations: ['CLICK'] },
    { ref: 'btn-next', role: 'button', name: 'Next', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  const refMap = new Map();
  const redacted = redactRequest(req, { refMap });
  assert.equal(refMap.get('btn-back'), 'e1');
  assert.equal(refMap.get('btn-next'), 'e2');
  assert.equal(redacted.state.elements[0].ref, 'e1');
  assert.equal(redacted.state.elements[1].ref, 'e2');
});

// ---------------------------------------------------------------------------
// M2 Round 22 Revision 33: W1 - W5 Regression Tests
// ---------------------------------------------------------------------------

test('W1: declared secret as targetRef is dropped and not emitted raw', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: 'pw', role: 'textbox', name: 'password', value: '', enabled: true, visible: true, operations: ['TYPE_TEXT'] },
  ];
  req.state.recentActions = [
    { operation: 'TYPE_TEXT', targetRef: 'hunter2-pass', text: 'x' },
  ];
  const redacted = redactRequest(req, { secrets: ['hunter2-pass'] });
  assert.equal(redacted.state.recentActions[0].targetRef, undefined);
  const json = JSON.stringify(redacted);
  assert.equal(json.includes('hunter2-pass'), false);
});

test('W1: foreign/stale targetRef is dropped', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: 'pw', role: 'textbox', name: 'password', value: '', enabled: true, visible: true, operations: ['TYPE_TEXT'] },
  ];
  req.state.recentActions = [
    { operation: 'CLICK', targetRef: 'stale-123' },
  ];
  const redacted = redactRequest(req, { secrets: [] });
  assert.equal(redacted.state.recentActions[0].targetRef, undefined);
});

test('W1: recentAction with targetRef when elements is empty is dropped', () => {
  const req = baseRequest();
  req.state.elements = [];
  req.state.recentActions = [
    { operation: 'CLICK', targetRef: 'my card 4111 1111 1111 1111' },
  ];
  const redacted = redactRequest(req, { secrets: [] });
  assert.equal(redacted.state.recentActions[0].targetRef, undefined);
  const json = JSON.stringify(redacted);
  assert.equal(json.includes('4111 1111 1111 1111'), false);
});

test('W2: criteria key with non-canonical punctuation/symbols throws JEV_REQUEST_INVALID', () => {
  const req = baseRequest();
  req.questions.operation.criteria = { 'Continue $$!!@@##%%^^': null };
  assert.throws(
    () => redactRequest(req, { secrets: [] }),
    (err) => err.code === 'JEV_REQUEST_INVALID',
  );
});

test('W2: criteria key with math-bold/fullwidth/ZWSP throws JEV_REQUEST_INVALID', () => {
  const req = baseRequest();
  req.questions.operation.criteria = { '𝐂𝐨𝐧𝐭𝐢𝐧𝐮𝐞 ｙｅｓ\u200bNo': null };
  assert.throws(
    () => redactRequest(req, { secrets: [] }),
    (err) => err.code === 'JEV_REQUEST_INVALID',
  );
});

test('W2: canonical V* criteria key equals its own projection and passes', () => {
  const req = baseRequest();
  req.questions.operation.criteria = { 'continue yes': null };
  const redacted = redactRequest(req, { secrets: [] });
  assert.ok('continue yes' in redacted.questions.operation.criteria);
  assert.equal(projectFreeText('continue yes'), 'continue yes');
});

test('W3: mixing e<N>-looking refs with other refs assigns distinct position refs and criteria keys', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: 'foo', role: 'button', name: 'go', value: '', enabled: true, visible: true, operations: ['CLICK'] },
    { ref: 'e1', role: 'button', name: 'stop', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  req.questions.operation.criteria = { foo: null, e1: null };
  const refMap = new Map();
  const redacted = redactRequest(req, { refMap });

  assert.equal(redacted.state.elements[0].ref, 'e1');
  assert.equal(redacted.state.elements[1].ref, 'e2');
  assert.equal(refMap.get('foo'), 'e1');
  assert.equal(refMap.get('e1'), 'e2');
  assert.deepEqual(Object.keys(redacted.questions.operation.criteria).sort(), ['e1', 'e2']);
});

test('W3: mixing e<N>-looking refs with other refs in other direction assigns distinct position refs', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: 'e2', role: 'button', name: 'go', value: '', enabled: true, visible: true, operations: ['CLICK'] },
    { ref: 'bar', role: 'button', name: 'stop', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  req.questions.operation.criteria = { e2: null, bar: null };
  const refMap = new Map();
  const redacted = redactRequest(req, { refMap });

  assert.equal(redacted.state.elements[0].ref, 'e1');
  assert.equal(redacted.state.elements[1].ref, 'e2');
  assert.equal(refMap.get('e2'), 'e1');
  assert.equal(refMap.get('bar'), 'e2');
  assert.deepEqual(Object.keys(redacted.questions.operation.criteria).sort(), ['e1', 'e2']);
});

test('W4: buildFallback returns a valid directive when request has criteria key outside vocabulary', () => {
  const req = baseRequest();
  req.questions.operation.criteria = { hunter2: null };
  assert.throws(() => redactRequest(req), (err) => err.code === 'JEV_REQUEST_INVALID');

  const fb = buildFallback({ request: req, reason: 'JEV_REQUEST_INVALID', circuit: 'closed', secrets: [] });
  assert.equal(fb.schema, 'webmcp-jev-fallback/1');
  assert.equal(fb.status, 'fallback-required');
  assert.equal(fb.reason, 'JEV_REQUEST_INVALID');
  assert.match(fb.stateDigest, /^sha256:[0-9a-f]{64}$/);
});

test('W5: non-string in string positions are projected or emptied, never passed raw', () => {
  const state = {
    elements: [
      {
        ref: 'a',
        role: { nested: 'hunter22' },
        name: { nested: 'hunter22' },
        value: { nested: 'hunter22' },
        parentContext: [{ nested: 'hunter22' }],
        enabled: true,
        visible: true,
        operations: ['TYPE_TEXT'],
      },
    ],
  };
  const out = redactState(state, { secrets: [] });
  const text = JSON.stringify(out);
  assert.equal(text.includes('hunter22'), false);
  assert.equal(out.elements[0].role, 'generic');
  assert.equal(out.elements[0].name, '');
  assert.equal(out.elements[0].value, REDACTED);
  assert.deepEqual(out.elements[0].parentContext, ['']);
});

test('W5: redactState and buildFallback survive circular references and BigInt without throwing', () => {
  const circular = baseState();
  circular.self = circular;
  circular.elements[0].owner = circular;
  circular.elements[0].value = 1234567890123n;

  let out;
  assert.doesNotThrow(() => {
    out = redactState(circular, { secrets: [] });
  });
  assert.equal(out.elements[0].value, REDACTED);

  const req = baseRequest();
  req.state = circular;
  let fb;
  assert.doesNotThrow(() => {
    fb = buildFallback({ request: req, reason: 'JEV_TIMEOUT', circuit: 'closed', secrets: [] });
  });
  assert.equal(fb.status, 'fallback-required');
  assert.match(fb.stateDigest, /^sha256:[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// M2 Round 22 Revision 34: X1, X2, X3, X4 Tests
// ---------------------------------------------------------------------------

test('X1: redactState builds first-wins refMap and total newRefToOld for duplicate refs', () => {
  const state = {
    snapshotDigest: DIGEST,
    elements: [
      { ref: 'x', role: 'button', name: 'First', value: '', enabled: true, visible: true, operations: ['CLICK'] },
      { ref: 'x', role: 'button', name: 'Second', value: '', enabled: true, visible: true, operations: ['CLICK'] },
    ],
  };
  const refMap = new Map();
  const newRefToOld = new Map();
  redactState(state, { refMap, newRefToOld });
  // First wins on outbound old->new map
  assert.equal(refMap.get('x'), 'e1');
  // Position-based newRefToOld map is total
  assert.equal(newRefToOld.get('e1'), 'x');
  assert.equal(newRefToOld.get('e2'), 'x');
});

test('X2: {e99: null} with no such element is refused with JEV_REQUEST_INVALID', () => {
  const req = baseRequest();
  req.state.elements = [];
  req.questions.operation.criteria = { e99: null };
  assert.throws(
    () => redactRequest(req, { secrets: [] }),
    (err) => err.code === 'JEV_REQUEST_INVALID',
  );
});

test('X2: {foo: "A", e1: "B"} collision is refused with JEV_REQUEST_INVALID, not merged', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: 'foo', role: 'button', name: 'Button', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  req.questions.operation.criteria = { foo: 'A', e1: 'B' };
  assert.throws(
    () => redactRequest(req, { secrets: [] }),
    (err) => err.code === 'JEV_REQUEST_INVALID',
  );
});

test('X2: real emitted ref accepted in criteria', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: 'foo', role: 'button', name: 'Button', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  req.questions.operation.criteria = { foo: null, CLICK: null };
  const redacted = redactRequest(req, { secrets: [] });
  assert.ok('e1' in redacted.questions.operation.criteria);
  assert.ok('CLICK' in redacted.questions.operation.criteria);
});

test('X2: caller literal e1 ref is accepted when it matches an emitted element', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: 'e1', role: 'button', name: 'Button', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  req.questions.operation.criteria = { e1: null };
  const redacted = redactRequest(req, { secrets: [] });
  assert.ok('e1' in redacted.questions.operation.criteria);
});

test('X4: checkbox value "on" + question containing "on" is projected, not refused', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: 'cb', role: 'checkbox', name: 'remember', value: 'on', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  req.questions.operation.instructions = { goal: 'pick', question: 'Which option logs me in?' };
  req.questions.operation.criteria = { answer: 'done' };
  let redacted;
  assert.doesNotThrow(() => {
    redacted = redactRequest(req, { secrets: [] });
  });
  assert.equal(redacted.state.elements[0].value, REDACTED);
});

test('X4: page value "Name Password" with name "Password" does not trigger reassembly refusal', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: 'tb', role: 'textbox', name: 'Password', value: 'Name Password', enabled: true, visible: true, operations: ['TYPE_TEXT'] },
  ];
  req.questions.operation.criteria = { answer: 'done' };
  let redacted;
  assert.doesNotThrow(() => {
    redacted = redactRequest(req, { secrets: [] });
  });
  assert.equal(redacted.state.elements[0].value, REDACTED);
});

test('X4: page value "e1role" does not trigger reassembly refusal', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: 'btn', role: 'button', name: 'Submit', value: 'e1role', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  req.questions.operation.criteria = { answer: 'done' };
  let redacted;
  assert.doesNotThrow(() => {
    redacted = redactRequest(req, { secrets: [] });
  });
  assert.equal(redacted.state.elements[0].value, REDACTED);
});

test('X3: totality on JSON-shaped input - missing and extra fields across request and state', () => {
  const weirdReq = {
    schema: 'webmcp-jev-request/1',
    requestId: 'req-extra-fields',
    extraFieldTopLevel: { foo: 'bar', arr: [1, 2, 3] },
    state: {
      urlOrigin: 'https://example.test',
      goal: 'test goal',
      extraStateProp: 42,
      elements: [
        {
          ref: 'el1',
          extraElementProp: 'ignored',
        },
      ],
      recentActions: [
        {
          operation: 'CLICK',
          extraActionProp: true,
        },
      ],
    },
    questions: {
      q1: {
        type: 'choice',
        extraQuestionProp: [null],
        instructions: { question: 'select' },
        criteria: { CLICK: null },
      },
    },
  };
  let redacted;
  assert.doesNotThrow(() => {
    redacted = redactRequest(weirdReq, { secrets: [] });
  });
  assert.equal(redacted.state.elements[0].ref, 'e1');
  assert.equal(redacted.state.elements[0].role, 'generic');
  assert.equal(redacted.state.elements[0].name, '');
});

test('X3: totality on JSON-shaped input - BigInt and non-string in various positions', () => {
  const state = {
    urlOrigin: 12345,
    goal: 99999n,
    elements: [
      {
        ref: 123n,
        role: { complex: 'role' },
        name: [1, 2, 3],
        value: 9876543210123456789n,
        parentContext: [42, null, { obj: true }],
      },
    ],
    recentActions: [
      {
        operation: 'TYPE_TEXT',
        text: 100n,
        values: [200n, null, undefined, true],
      },
    ],
  };
  let redacted;
  assert.doesNotThrow(() => {
    redacted = redactState(state, { secrets: [] });
  });
  assert.equal(redacted.elements[0].ref, 'e1');
  assert.equal(redacted.elements[0].role, 'generic');
  assert.equal(redacted.elements[0].name, '');
  assert.equal(redacted.elements[0].value, REDACTED);
});

test('X3: totality on JSON-shaped input - buildFallback never throws on request that passed validateRequest', () => {
  const req = baseRequest();
  req.state.elements[0].value = 'ordinary';
  let fb;
  assert.doesNotThrow(() => {
    fb = buildFallback({ request: req, reason: 'JEV_TIMEOUT', circuit: 'closed', secrets: [] });
  });
  assert.equal(fb.status, 'fallback-required');
  assert.equal(fb.reason, 'JEV_TIMEOUT');
});

// ---------------------------------------------------------------------------
// M2 Round 22 Revision 35: Y1 - Y3 Regression Tests
// ---------------------------------------------------------------------------

test('Y1: aliased elements [a, a] emits unique refs and maps back correctly', () => {
  const a = { ref: 'x', role: 'button', name: 'Submit', value: '', enabled: true, visible: true, operations: ['CLICK'] };
  const req = baseRequest();
  req.state.elements = [a, a];
  req.questions.operation.criteria = { x: null };
  const refMap = new Map();
  const newRefToOld = new Map();
  const redacted = redactRequest(req, { refMap, newRefToOld });

  assert.equal(redacted.state.elements[0].ref, 'e1');
  assert.equal(redacted.state.elements[1].ref, 'e2');
  assert.notEqual(redacted.state.elements[0], redacted.state.elements[1]);
  assert.equal(newRefToOld.get('e1'), 'x');
  assert.equal(newRefToOld.get('e2'), 'x');
  assert.equal(refMap.get('x'), 'e1');
  assert.ok('e1' in redacted.questions.operation.criteria);
});

test('Y1: aliased questions { q1: q, q2: q } remaps criteria independently without re-mapping emitted refs', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: 'x', role: 'button', name: 'First', value: '', enabled: true, visible: true, operations: ['CLICK'] },
    { ref: 'e1', role: 'button', name: 'Second', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  const q = {
    type: 'choice',
    instructions: { question: 'Pick button' },
    criteria: { x: null },
  };
  req.questions = { q1: q, q2: q };
  const redacted = redactRequest(req, { secrets: [] });

  assert.notEqual(redacted.questions.q1, redacted.questions.q2);
  assert.ok('e1' in redacted.questions.q1.criteria);
  assert.ok('e1' in redacted.questions.q2.criteria);
  assert.ok(!('e2' in redacted.questions.q1.criteria));
  assert.ok(!('e2' in redacted.questions.q2.criteria));
});

test('Y2: literal eN-shaped key that is not a caller ref is refused', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: 'a', role: 'button', name: 'Go', value: '', enabled: true, visible: true, operations: ['CLICK'] },
    { ref: 'b', role: 'button', name: 'Stop', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  req.questions.operation.criteria = { e2: null, CLICK: null };
  assert.throws(
    () => redactRequest(req, { secrets: [] }),
    (err) => err.code === 'JEV_REQUEST_INVALID',
  );
});

test('Y2: literal eN-shaped key that is a caller ref is accepted and remapped', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: 'e2', role: 'button', name: 'First', value: '', enabled: true, visible: true, operations: ['CLICK'] },
    { ref: 'bar', role: 'button', name: 'Second', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  req.questions.operation.criteria = { e2: null, bar: null };
  const redacted = redactRequest(req, { secrets: [] });

  assert.ok('e1' in redacted.questions.operation.criteria);
  assert.ok('e2' in redacted.questions.operation.criteria);
  assert.equal(redacted.state.elements[0].ref, 'e1');
  assert.equal(redacted.state.elements[1].ref, 'e2');
});

test('Y3: refused key error message never contains the raw key text', () => {
  const secretKey = 'hunter2-Secret-Key';
  const req = baseRequest();
  req.state.elements = [
    { ref: 'btn', role: 'button', name: 'Go', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  req.questions.operation.criteria = { [secretKey]: null };

  assert.throws(
    () => redactRequest(req, { secrets: [] }),
    (err) => {
      assert.equal(err.code, 'JEV_REQUEST_INVALID');
      assert.equal(err.message, 'criteria key is outside the allowed vocabulary');
      assert.doesNotMatch(err.message, new RegExp(secretKey));
      assert.equal(err.details?.key, '[REDACTED-KEY]');
      return true;
    },
  );

  const colReq = baseRequest();
  colReq.state.elements = [
    { ref: 'colKey', role: 'button', name: 'First', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  // Construct collision: both keys map to e1
  colReq.questions.operation.criteria = Object.create(null);
  colReq.questions.operation.criteria.colKey = 'A';
  // If we set a second property whose remapped key is also e1 via Object.defineProperty
  const secondKey = 'colKey2';
  // In redactQuestions: mappedKey = refMap.get(key)
  // If both keys are in refMap and map to the same e1:
  const refMap = new Map();
  refMap.set('colKey', 'e1');
  refMap.set(secondKey, 'e1');
  colReq.questions.operation.criteria[secondKey] = 'B';

  assert.throws(
    () => redactRequest(colReq, { secrets: [], refMap }),
    (err) => {
      assert.equal(err.code, 'JEV_REQUEST_INVALID');
      assert.equal(err.message, 'criteria key collides with a remapped ref');
      assert.doesNotMatch(err.message, new RegExp(secondKey));
      assert.equal(err.details?.key, '[REDACTED-KEY]');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// M2 Round 22 Revision 36: Z1 - Z3 Regression Tests
// ---------------------------------------------------------------------------

test('Z1: aliased recentActions [act, act] remaps targetRef independently without double remapping', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: 'e2', role: 'button', name: 'First', value: '', enabled: true, visible: true, operations: ['CLICK'] },
    { ref: 'x', role: 'button', name: 'Second', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  const act = { operation: 'CLICK', targetRef: 'x' };
  req.state.recentActions = [act, act];
  const redacted = redactRequest(req, { secrets: [] });

  assert.equal(redacted.state.recentActions.length, 2);
  assert.notEqual(redacted.state.recentActions[0], redacted.state.recentActions[1]);
  assert.equal(redacted.state.recentActions[0].targetRef, 'e2');
  assert.equal(redacted.state.recentActions[1].targetRef, 'e2');
});

test('Z2: off-wire ids and page-value substrings pass, while exact page-value and declared secrets in question ids are refused', () => {
  // 1. Off-wire ids and page value substrings in question id pass
  const req = baseRequest({ requestId: 'req-123' });
  req.caller = { runId: 'run-7', permitId: null };
  req.questionSet.id = 'qs-run-123';
  req.state.elements = [
    { ref: 'tb1', role: 'textbox', name: 'field', value: 'ion', enabled: true, visible: true, operations: ['TYPE_TEXT'] },
    { ref: 'tb2', role: 'textbox', name: 'num', value: '123', enabled: true, visible: true, operations: ['TYPE_TEXT'] },
    { ref: 'tb3', role: 'textbox', name: 'word', value: 'run', enabled: true, visible: true, operations: ['TYPE_TEXT'] },
  ];
  req.questions = {
    operation: {
      type: 'choice',
      instructions: { question: 'Select' },
      criteria: { answer: 'done' },
    },
  };
  let redacted;
  assert.doesNotThrow(() => {
    redacted = redactRequest(req, { secrets: [] });
  });
  assert.ok(redacted.questions.operation);

  // 2. Exact canonical equality of page-derived value in question id IS refused
  const exactReq = baseRequest();
  exactReq.state.elements = [
    { ref: 'tb', role: 'textbox', name: 'field', value: 'my_op', enabled: true, visible: true, operations: ['TYPE_TEXT'] },
  ];
  exactReq.questions = {
    'my-op': {
      type: 'choice',
      instructions: { question: 'Select' },
      criteria: { answer: 'done' },
    },
  };
  assert.throws(
    () => redactRequest(exactReq, { secrets: [] }),
    (err) => {
      assert.equal(err.code, 'JEV_REQUEST_INVALID');
      assert.equal(err.message, 'request key carries a sensitive value');
      return true;
    },
  );

  // 3. Declared secret in question id (substring) IS refused
  const secReq = baseRequest();
  secReq.questions = {
    'q-secret123-which': {
      type: 'choice',
      instructions: { question: 'Select' },
      criteria: { answer: 'done' },
    },
  };
  assert.throws(
    () => redactRequest(secReq, { secrets: ['secret123'] }),
    (err) => {
      assert.equal(err.code, 'JEV_REQUEST_INVALID');
      assert.equal(err.message, 'request key carries a declared secret');
      return true;
    },
  );
});

test('Z3: __proto__ element ref is remapped like any ref and preserved in criteria', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: '__proto__', role: 'button', name: 'Go', value: '', enabled: true, visible: true, operations: ['CLICK'] },
    { ref: 'y', role: 'button', name: 'Stop', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  req.questions.operation.criteria = JSON.parse('{"__proto__": null, "y": null}');
  const refMap = new Map();
  const newRefToOld = new Map();
  const redacted = redactRequest(req, { secrets: [], refMap, newRefToOld });

  assert.equal(redacted.state.elements[0].ref, 'e1');
  assert.equal(redacted.state.elements[1].ref, 'e2');
  assert.equal(newRefToOld.get('e1'), '__proto__');
  assert.equal(refMap.get('__proto__'), 'e1');
  assert.ok('e1' in redacted.questions.operation.criteria);
  assert.ok('e2' in redacted.questions.operation.criteria);
  assert.equal(Object.keys(redacted.questions.operation.criteria).length, 2);
});

test('Z3: __proto__ criteria key reaches wire and is checked by key rules', () => {
  const req = baseRequest();
  req.state.elements = [
    { ref: 'btn', role: 'button', name: 'Go', value: '', enabled: true, visible: true, operations: ['CLICK'] },
  ];
  req.questions.operation.criteria = JSON.parse('{"__proto__": null}');
  assert.throws(
    () => redactRequest(req, { secrets: [] }),
    (err) => {
      assert.equal(err.code, 'JEV_REQUEST_INVALID');
      assert.equal(err.message, 'criteria key is outside the allowed vocabulary');
      return true;
    },
  );
});

test('Z3: __proto__ question id reaches wire and is checked by id rules', () => {
  const req = baseRequest();
  const qObj = {};
  Object.defineProperty(qObj, '__proto__', {
    value: {
      type: 'choice',
      instructions: { question: 'Pick' },
      criteria: { answer: 'done' },
    },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  req.questions = qObj;

  const redacted = redactRequest(req, { secrets: [] });
  assert.ok(Object.prototype.hasOwnProperty.call(redacted.questions, '__proto__'));
  assert.equal(Object.keys(redacted.questions).length, 1);
  assert.ok(redacted.questions['__proto__']);

  // And if __proto__ question id contains a declared secret, it is checked and rejected
  const secQObj = {};
  Object.defineProperty(secQObj, '__proto__', {
    value: {
      type: 'choice',
      instructions: { question: 'Pick' },
      criteria: { answer: 'done' },
    },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const secReq = baseRequest();
  secReq.questions = secQObj;
  assert.throws(
    () => redactRequest(secReq, { secrets: ['proto'] }),
    (err) => err.code === 'JEV_REQUEST_INVALID',
  );
});
