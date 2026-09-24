// M2 answer-validator tests: Choice / Score / Noul incl. the Noul
// confidence-fabrication ban.
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateChoice, validateScore, validateNoul, validateAnswer, validateAnswers } from '../src/jev/answers.mjs';

const OPTIONS = ['CLICK', 'WAIT'];

test('choice accepts a valid distribution with max selected', () => {
  const answer = { type: 'choice', choice: 'CLICK', probabilities: { CLICK: 0.97, WAIT: 0.03 }, confidence: 0.94 };
  assert.equal(validateChoice(answer, OPTIONS), answer);
});

test('choice rejects unoffered option', () => {
  assert.throws(
    () => validateChoice({ type: 'choice', choice: 'DELETE', probabilities: { DELETE: 0.9, WAIT: 0.1 }, confidence: 0.9 }, OPTIONS),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
});

test('choice rejects key mismatch (missing option)', () => {
  assert.throws(
    () => validateChoice({ type: 'choice', choice: 'CLICK', probabilities: { CLICK: 1.0 }, confidence: 1.0 }, OPTIONS),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
});

test('choice rejects extra probability key', () => {
  assert.throws(
    () => validateChoice(
      { type: 'choice', choice: 'CLICK', probabilities: { CLICK: 0.8, WAIT: 0.1, DONE: 0.1 }, confidence: 0.8 },
      OPTIONS,
    ),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
});

test('choice rejects sum far from 1.0', () => {
  assert.throws(
    () => validateChoice({ type: 'choice', choice: 'CLICK', probabilities: { CLICK: 0.4, WAIT: 0.1 }, confidence: 0.5 }, OPTIONS),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
});

test('choice rejects non-max selection', () => {
  assert.throws(
    () => validateChoice({ type: 'choice', choice: 'WAIT', probabilities: { CLICK: 0.8, WAIT: 0.2 }, confidence: 0.2 }, OPTIONS),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
});

test('choice rejects out-of-range and non-finite probabilities', () => {
  for (const probabilities of [
    { CLICK: 1.2, WAIT: -0.2 },
    { CLICK: Number.NaN, WAIT: 1 },
    { CLICK: Number.POSITIVE_INFINITY, WAIT: 0 },
  ]) {
    assert.throws(
      () => validateChoice({ type: 'choice', choice: 'CLICK', probabilities, confidence: 0.5 }, OPTIONS),
      (error) => error.code === 'JEV_RESPONSE_INVALID',
    );
  }
});

test('choice rejects missing/bad confidence', () => {
  assert.throws(
    () => validateChoice({ type: 'choice', choice: 'CLICK', probabilities: { CLICK: 1, WAIT: 0 } }, OPTIONS),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
  assert.throws(
    () => validateChoice({ type: 'choice', choice: 'CLICK', probabilities: { CLICK: 1, WAIT: 0 }, confidence: 2 }, OPTIONS),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
});

test('score accepts finite score + confidence, rejects extras', () => {
  assert.equal(validateScore({ type: 'score', score: 0.42, confidence: 0.7 }).score, 0.42);
  assert.throws(
    () => validateScore({ type: 'score', score: 0.42 }),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
  assert.throws(
    () => validateScore({ type: 'score', score: Number.NaN, confidence: 0.5 }),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
  assert.throws(
    () => validateScore({ type: 'score', score: 1, confidence: 0.5, choice: 'CLICK' }),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
});

test('noul accepts bare text, bans fabricated confidence', () => {
  assert.equal(validateNoul({ type: 'noul', noul: 'some text' }).noul, 'some text');
  assert.throws(
    () => validateNoul({ type: 'noul', noul: 'some text', confidence: 0.99 }),
    (error) => {
      assert.match(error.message, /fabrication/);
      return error.code === 'JEV_RESPONSE_INVALID';
    },
  );
  for (const extra of ['choice', 'probabilities', 'score']) {
    assert.throws(
      () => validateNoul({ type: 'noul', noul: 'x', [extra]: 1 }),
      (error) => error.code === 'JEV_RESPONSE_INVALID',
    );
  }
});

test('validateAnswer dispatches on question type and rejects mismatch', () => {
  const questions = {
    operation: { type: 'choice', criteria: { CLICK: null, WAIT: null } },
    risk: { type: 'score' },
    note: { type: 'noul' },
  };
  validateAnswer('operation', { type: 'choice', choice: 'CLICK', probabilities: { CLICK: 1, WAIT: 0 }, confidence: 1 }, questions.operation);
  validateAnswer('risk', { type: 'score', score: 3, confidence: 0.5 }, questions.risk);
  validateAnswer('note', { type: 'noul', noul: 'hi' }, questions.note);
  assert.throws(
    () => validateAnswer('operation', { type: 'score', score: 1, confidence: 1 }, questions.operation),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
  assert.throws(
    () => validateAnswer('ghost', { type: 'noul', noul: 'hi' }, questions.ghost),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
});

test('validateAnswers rejects unknown ids and empty maps', () => {
  const questions = { operation: { type: 'choice', criteria: { CLICK: null } } };
  assert.throws(() => validateAnswers({}, questions), (error) => error.code === 'JEV_RESPONSE_INVALID');
  assert.throws(
    () => validateAnswers({ nope: { type: 'noul', noul: 'x' } }, questions),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
});

// ---- M2 repair guards ----

// Finding 10: every answer variant rejects undeclared keys (frozen
// additionalProperties: false), not just known cross-variant fields.
test('finding-10: choice answers reject arbitrary extra keys', () => {
  assert.throws(
    () => validateChoice(
      { type: 'choice', choice: 'CLICK', probabilities: { CLICK: 1, WAIT: 0 }, confidence: 1, approved: true },
      OPTIONS,
    ),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
});

test('finding-10: score answers reject arbitrary extra keys', () => {
  assert.throws(
    () => validateScore({ type: 'score', score: 0.5, confidence: 0.5, unsafe: 'extra' }),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
});

test('finding-10: noul answers reject arbitrary extra keys', () => {
  assert.throws(
    () => validateNoul({ type: 'noul', noul: 'text', unsafe: 'extra' }),
    (error) => error.code === 'JEV_RESPONSE_INVALID',
  );
});
