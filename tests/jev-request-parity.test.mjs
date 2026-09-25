// Finding-3 parity: the hand-rolled validateRequest must agree with ajv
// verdicts from validate-contracts.mjs on every fixture. Offline only — ajv
// is resolved from the local webmcp-browser-kit tree, no network.
// Fixtures use synthetic digests; no secrets anywhere.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRequest } from '../src/jev/schemas.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');

function resolveContractsDir() {
  const candidates = [
    join(PKG_ROOT, '..', '..', 'docs', 'initiatives', '10-local-ready', '2026-09-jev-fast-browser-runtime', 'contracts'),
    join(PKG_ROOT, '..', '..', 'docs', 'initiatives', '2026-09-jev-fast-browser-runtime', 'contracts'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  assert.fail(`Contracts directory not found. Tried paths:\n  - ${candidates[0]}\n  - ${candidates[1]}`);
}

const CONTRACTS = resolveContractsDir();

function resolveAjv() {
  const candidates = [
    join(PKG_ROOT, '..', 'webmcp-browser-kit', 'package.json'),
    join(PKG_ROOT, 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const req = createRequire(candidate);
      const Ajv2020Module = req('ajv/dist/2020');
      const Ajv2020 = Ajv2020Module.default || Ajv2020Module;
      return new Ajv2020({ strict: false, allErrors: true });
    } catch {
      // try next candidate
    }
  }
  throw new Error('AJV_UNAVAILABLE: no local JSON Schema engine resolved');
}

const ajv = resolveAjv();
const requestSchema = JSON.parse(readFileSync(join(CONTRACTS, 'webmcp-jev-request-1.schema.json'), 'utf8'));
const validateAjv = ajv.compile(requestSchema);

const DIGEST = `sha256:${'ab'.repeat(32)}`;

function baseRequest() {
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
  };
}

function captchaNextStepRequest() {
  const request = baseRequest();
  request.kind = 'captcha-next-step';
  request.state.captchaEvidence = { detectorKind: 'turnstile', interactive: true };
  request.questions = {
    solver: {
      type: 'choice',
      instructions: { goal: 'Select solver', question: 'Which solver?' },
      criteria: { turnstile: null, slider: null },
    },
    next_step: {
      type: 'choice',
      instructions: { goal: 'Next step', question: 'Choose next step.' },
      criteria: { invoke_existing_solver: null, escalate_human: null },
    },
  };
  return request;
}

function captchaClassifyRequest() {
  const request = baseRequest();
  request.kind = 'captcha-classify';
  request.state.captchaEvidence = { detectorKind: 'turnstile', interactive: true };
  request.questions = {
    captcha_kind: {
      type: 'choice',
      instructions: { goal: 'Classify', question: 'Identify detector kind.' },
      criteria: { turnstile: null, recaptcha_v2: null },
    },
  };
  return request;
}

// [label, expectedValid, mutate]
const FIXTURES = [
  ['browser-step valid', true, () => {}],
  ['query kind valid without evidence', true, (r) => { r.kind = 'query'; }],
  ['captcha-classify valid', true, () => captchaClassifyRequest()],
  ['captcha-next-step valid', true, () => captchaNextStepRequest()],
  ['element with checked/selected/parentContext valid', true, (r) => {
    r.state.elements[0].checked = null;
    r.state.elements[0].selected = true;
    r.state.elements[0].parentContext = ['dialog'];
  }],
  ['captcha-classify missing captchaEvidence', false, (r) => {
    r.kind = 'captcha-classify';
    r.questions = { captcha_kind: { type: 'choice', instructions: { question: 'Which?' }, criteria: { turnstile: null } } };
  }],
  ['captcha-next-step missing captchaEvidence', false, (r) => {
    const full = captchaNextStepRequest();
    r.kind = full.kind;
    r.questions = full.questions;
  }],
  ['captchaEvidence detectorKind outside enum', false, (r) => {
    const full = captchaClassifyRequest();
    r.kind = full.kind;
    r.questions = full.questions;
    r.state.captchaEvidence = { detectorKind: 'recaptcha_v4' };
  }],
  ['captchaEvidence with extra cookie field', false, (r) => {
    const full = captchaClassifyRequest();
    r.kind = full.kind;
    r.questions = full.questions;
    r.state.captchaEvidence = { detectorKind: 'turnstile', cookie: 'SID=abc' };
  }],
  ['captchaEvidence missing required detectorKind', false, (r) => {
    const full = captchaNextStepRequest();
    r.kind = full.kind;
    r.questions = full.questions;
    r.state.captchaEvidence = { interactive: true };
  }],
  ['solver criteria key outside allowlist', false, (r) => {
    const full = captchaNextStepRequest();
    r.kind = full.kind;
    r.questions = full.questions;
    r.state.captchaEvidence = full.state.captchaEvidence;
    r.questions.solver.criteria = { recaptcha_v4: null };
  }],
  ['solver without criteria', false, (r) => {
    const full = captchaNextStepRequest();
    r.kind = full.kind;
    r.questions = full.questions;
    r.state.captchaEvidence = full.state.captchaEvidence;
    delete r.questions.solver.criteria;
  }],
  ['solver with empty criteria', false, (r) => {
    const full = captchaNextStepRequest();
    r.kind = full.kind;
    r.questions = full.questions;
    r.state.captchaEvidence = full.state.captchaEvidence;
    r.questions.solver.criteria = {};
  }],
  ['next_step criteria key outside allowlist', false, (r) => {
    const full = captchaNextStepRequest();
    r.kind = full.kind;
    r.questions = full.questions;
    r.state.captchaEvidence = full.state.captchaEvidence;
    r.questions.next_step.criteria = { solve_now: null };
  }],
  ['element with undeclared field', false, (r) => { r.state.elements[0].secret = 'x'; }],
  ['recentAction with undeclared field', false, (r) => {
    r.state.recentActions = [{ operation: 'CLICK', targetRef: 'r5', cookie: 'SID=abc' }];
  }],
  ['instructions with undeclared field', false, (r) => {
    r.questions.operation.instructions.hint = 'extra';
  }],
  ['criteria value of wrong type', false, (r) => { r.questions.operation.criteria = { CLICK: 42 }; }],
  ['criteria descriptor with undeclared key', false, (r) => {
    r.questions.operation.criteria = { CLICK: { role: 'button', evil: 1 } };
  }],
  ['browser-step missing operation question', false, (r) => {
    r.questions = { note: { type: 'noul', instructions: { question: 'Hi?' } } };
  }],
  ['captcha-classify missing captcha_kind question', false, (r) => {
    const full = captchaClassifyRequest();
    r.kind = full.kind;
    r.state.captchaEvidence = full.state.captchaEvidence;
    r.questions = { operation: full.questions.captcha_kind };
  }],
  ['bounds maxStateBytes zero', false, (r) => { r.bounds.maxStateBytes = 0; }],
  ['question with undeclared top-level key', false, (r) => {
    r.questions.operation.allowlist = ['CLICK'];
  }],
];

function validatorVerdict(request) {
  try {
    validateRequest(request);
    return true;
  } catch (error) {
    if (error?.code === 'JEV_REQUEST_INVALID') return false;
    throw error;
  }
}

const rows = [];
for (const [label, expected, build] of FIXTURES) {
  test(`parity: ${label} (ajv ${expected ? 'accepts' : 'rejects'})`, () => {
    let request = null;
    if (label === 'captcha-classify valid') request = captchaClassifyRequest();
    else if (label === 'captcha-next-step valid') request = captchaNextStepRequest();
    else {
      request = baseRequest();
      const out = build(request);
      if (out && typeof out === 'object') request = out;
    }
    const ajvVerdict = validateAjv(request) === true;
    const handVerdict = validatorVerdict(request);
    rows.push({ label, expected, ajvVerdict, handVerdict });
    assert.equal(ajvVerdict, expected, `${label}: ajv verdict drifted from the recorded expectation`);
    assert.equal(handVerdict, ajvVerdict, `${label}: hand-rolled validator disagrees with ajv`);
  });
}

test('parity: verdict table validator vs ajv', () => {
  const lines = rows.map(({ label, ajvVerdict, handVerdict }) => {
    const mark = ajvVerdict === handVerdict ? '=' : 'X';
    return `${mark} ${ajvVerdict ? 'accept' : 'reject'} / ${handVerdict ? 'accept' : 'reject'}  ${label}`;
  });
  console.log(`\nvalidator-vs-ajv parity (${rows.length} fixtures):\n${lines.join('\n')}`);
  assert.equal(rows.length, FIXTURES.length, 'every fixture ran before the table printed');
  assert.ok(rows.every(({ ajvVerdict, handVerdict }) => ajvVerdict === handVerdict), 'all verdicts agree');
});
