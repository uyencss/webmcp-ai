// M2 answer validators: Choice / Score / Noul discriminated union.
// Field names follow webmcp-jev-result/1 exactly (frozen at M0).
// Noul MUST NOT carry confidence — presence is fabrication, rejected.
import { AiCliError } from '../errors.mjs';

export function jevResponseInvalid(message, details) {
  return new AiCliError('JEV_RESPONSE_INVALID', message, { details });
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Frozen key sets per variant (result schema additionalProperties: false).
const CHOICE_KEYS = new Set(['type', 'choice', 'probabilities', 'confidence']);
const SCORE_KEYS = new Set(['type', 'score', 'confidence']);
const NOUL_KEYS = new Set(['type', 'noul']);

function assertAnswerKeys(answer, allowed, label) {
  for (const key of Object.keys(answer)) {
    if (!allowed.has(key)) throw jevResponseInvalid(`${label} answer carries undeclared field ${JSON.stringify(key)}`);
  }
}

// Plan §6.5 strict choice validation.
export function validateChoice(answer, expectedOptions, { sumTolerance = 0.02 } = {}) {
  if (!answer || typeof answer !== 'object' || answer.type !== 'choice') {
    throw jevResponseInvalid('choice answer must be an object with type "choice"');
  }
  assertAnswerKeys(answer, CHOICE_KEYS, 'choice');
  const options = Array.isArray(expectedOptions) ? expectedOptions : Object.keys(expectedOptions ?? {});
  const optionSet = new Set(options);
  if (!optionSet.has(answer.choice)) {
    throw jevResponseInvalid(`choice ${JSON.stringify(answer.choice)} is not an offered option`, {
      choice: answer.choice,
    });
  }
  const probabilities = answer.probabilities;
  if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) {
    throw jevResponseInvalid('choice answer requires a probabilities object');
  }
  const keys = Object.keys(probabilities);
  if (keys.length !== optionSet.size || !keys.every((key) => optionSet.has(key))) {
    throw jevResponseInvalid('probabilities keys must match the offered options exactly', {
      expected: [...optionSet].sort(),
      actual: [...keys].sort(),
    });
  }
  const values = Object.values(probabilities);
  if (values.some((value) => !isFiniteNumber(value) || value < 0 || value > 1)) {
    throw jevResponseInvalid('probabilities must be finite numbers in [0,1]');
  }
  const sum = values.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > sumTolerance) {
    throw jevResponseInvalid(`probabilities must sum to ~1.0 (got ${sum})`, { sum });
  }
  const max = Math.max(...values);
  if (probabilities[answer.choice] < max - 1e-6) {
    throw jevResponseInvalid('choice must be the max-probability option');
  }
  if (!isFiniteNumber(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
    throw jevResponseInvalid('choice answer requires confidence in [0,1]');
  }
  return answer;
}

export function validateScore(answer) {
  if (!answer || typeof answer !== 'object' || answer.type !== 'score') {
    throw jevResponseInvalid('score answer must be an object with type "score"');
  }
  assertAnswerKeys(answer, SCORE_KEYS, 'score');
  if (!isFiniteNumber(answer.score)) {
    throw jevResponseInvalid('score answer requires a finite numeric score');
  }
  if (!isFiniteNumber(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
    throw jevResponseInvalid('score answer requires confidence in [0,1]');
  }
  return answer;
}

export function validateNoul(answer) {
  if (!answer || typeof answer !== 'object' || answer.type !== 'noul') {
    throw jevResponseInvalid('noul answer must be an object with type "noul"');
  }
  // Frozen rule (plan §5.2): never fabricate confidence for Noul. The
  // known cross-variant keys keep the fabrication wording; any other
  // undeclared key is rejected by the frozen key-set check below.
  for (const forbidden of ['confidence', 'choice', 'probabilities', 'score']) {
    if (forbidden in answer) {
      throw jevResponseInvalid(`noul answer must not carry ${forbidden} (confidence fabrication banned)`);
    }
  }
  assertAnswerKeys(answer, NOUL_KEYS, 'noul');
  if (typeof answer.noul !== 'string') {
    throw jevResponseInvalid('noul answer requires a string noul field');
  }
  return answer;
}

export function validateAnswer(questionId, answer, question) {
  if (!question || typeof question !== 'object') {
    throw jevResponseInvalid(`answer ${JSON.stringify(questionId)} has no matching request question`);
  }
  if (!answer || typeof answer !== 'object' || answer.type !== question.type) {
    throw jevResponseInvalid(
      `answer ${JSON.stringify(questionId)} type ${JSON.stringify(answer?.type)} must match question type ${JSON.stringify(question.type)}`,
    );
  }
  if (question.type === 'choice') {
    return validateChoice(answer, Object.keys(question.criteria ?? {}));
  }
  if (question.type === 'score') return validateScore(answer);
  if (question.type === 'noul') return validateNoul(answer);
  throw jevResponseInvalid(`unknown question type ${JSON.stringify(question.type)}`);
}

// Every answer id must exist in the request questions; each answer validates
// against its question. Unanswered questions are allowed (fan-out heads the
// caller ignores), but unoffered answer ids are not.
export function validateAnswers(answers, questions) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw jevResponseInvalid('result answers must be an object');
  }
  const ids = Object.keys(answers);
  if (ids.length === 0) throw jevResponseInvalid('result answers must not be empty');
  for (const id of ids) validateAnswer(id, answers[id], questions?.[id]);
  return answers;
}
