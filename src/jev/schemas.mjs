// M2 shape validators for the three frozen envelopes:
// webmcp-jev-request/1, webmcp-jev-result/1, webmcp-jev-fallback/1.
// Field names are copied from the frozen schemas — never renamed here.
// Hand-rolled (zero dependencies): structural checks only, mirroring the
// normative shapes. Full JSON-Schema proof stays in validate-contracts.mjs.
import { AiCliError } from '../errors.mjs';
import { validateAnswers } from './answers.mjs';

export const JEV_REQUEST_SCHEMA = 'webmcp-jev-request/1';
export const JEV_RESULT_SCHEMA = 'webmcp-jev-result/1';
export const JEV_FALLBACK_SCHEMA = 'webmcp-jev-fallback/1';

export const REQUEST_KINDS = ['browser-step', 'captcha-classify', 'captcha-next-step', 'query'];
export const FALLBACK_POLICIES = ['normal-agent', 'deterministic', 'human', 'abort'];
export const QUESTION_TYPES = ['choice', 'score', 'noul'];
export const OPERATIONS = ['CLICK', 'TYPE_TEXT', 'HOVER', 'SELECT', 'WAIT', 'DONE', 'BLOCKED'];
export const ELEMENT_OPERATIONS = ['CLICK', 'TYPE_TEXT', 'HOVER', 'SELECT'];
export const FALLBACK_ENGINES = ['normal-agent', 'deterministic', 'human', 'blocked'];
export const CIRCUIT_STATES = ['open', 'closed', 'half-open'];

// Frozen key sets and enums copied from webmcp-jev-request-1.schema.json.
// The hand-rolled validator must reject exactly what ajv rejects; the parity
// test (tests/jev-request-parity.test.mjs) proves it fixture by fixture.
const ELEMENT_KEYS = new Set([
  'ref', 'role', 'name', 'value', 'enabled', 'visible', 'operations',
  'checked', 'selected', 'expanded', 'parentContext',
]);
const RECENT_ACTION_KEYS = new Set(['operation', 'targetRef', 'text', 'values']);
const INSTRUCTION_KEYS = new Set(['goal', 'assumedOperation', 'question']);
const CAPTCHA_EVIDENCE_KEYS = new Set([
  'detectorKind', 'sitekey', 'action', 'fingerprint', 'evidence', 'interactive', 'solvableByPackage',
]);
const CRITERION_DESCRIPTOR_KEYS = new Set(['role', 'name', 'value']);
export const DETECTOR_KINDS = [
  'recaptcha_v2', 'recaptcha_v2_invisible', 'recaptcha_v3', 'hcaptcha', 'turnstile',
  'aws_waf', 'arkose', 'datadome', 'perimeterx', 'akamai_bm', 'kasada', 'tiktok', 'unknown',
];
// Criteria keys of the captcha-next-step solver/next_step questions ARE the
// allowlist (frozen propertyNames enums); nothing else is offered.
export const SOLVER_CRITERIA_KEYS = [
  'recaptcha_v2', 'recaptcha_invisible', 'hcaptcha', 'hcaptcha_multistage', 'slider',
  'shopee_slider', 'text_captcha', 'math_captcha', 'turnstile',
];
export const NEXT_STEP_CRITERIA_KEYS = [
  'run_detector', 'invoke_existing_solver', 'wait_backoff', 'route_antibot', 'escalate_human', 'abort',
];
// Frozen 14-code reason enum (webmcp-jev-fallback-1.schema.json). Duplicated
// here (not imported) to avoid a require cycle with fallback.mjs.
const FALLBACK_REASONS = new Set([
  'JEV_CONFIG_MISSING', 'JEV_AUTH_FAILED', 'JEV_RATE_LIMITED', 'JEV_OVERLOADED',
  'JEV_TIMEOUT', 'JEV_TRANSPORT_FAILED', 'JEV_REQUEST_INVALID', 'JEV_RESPONSE_INVALID',
  'JEV_MODEL_MISMATCH', 'JEV_CIRCUIT_OPEN', 'PROVIDER_STATE_UNINITIALIZED',
  'PROVIDER_NO_ROUTE', 'PROVIDER_BUSY', 'REVIEW_BLOCKED_PROVIDER_ROUTE',
]);

const REQUEST_ID_RE = /^[a-zA-Z0-9_-]+(@[a-zA-Z0-9_.-]+)?$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const ORIGIN_RE = /^https?:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?$/;
export const MODEL_RE = /^jev-[0-9.]+$/;

function requestInvalid(message, details) {
  return new AiCliError('JEV_REQUEST_INVALID', message, { details });
}

function responseInvalid(message, details) {
  return new AiCliError('JEV_RESPONSE_INVALID', message, { details });
}

function assertNoExtra(value, allowed, fail, label) {
  for (const key of Object.keys(value ?? {})) {
    if (!allowed.has(key)) throw fail(`${label} carries an unknown field`);
  }
}

function assertDigest(value, fail, label) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    throw fail(`${label} must match sha256:<64 hex>`);
  }
}

function assertRequestId(value, fail) {
  if (typeof value !== 'string' || !REQUEST_ID_RE.test(value)) {
    throw fail('requestId violates the frozen pattern');
  }
}

function checkBounds(bounds) {
  if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)) {
    throw requestInvalid('bounds must be an object');
  }
  assertNoExtra(bounds, new Set(['maxStateBytes', 'maxQuestions', 'timeoutMs', 'maxRetries']), requestInvalid, 'bounds');
  for (const key of ['maxStateBytes', 'maxQuestions', 'timeoutMs']) {
    if (!Number.isInteger(bounds[key]) || bounds[key] < 1) {
      throw requestInvalid(`bounds.${key} must be an integer >= 1`);
    }
  }
  if (!Number.isInteger(bounds.maxRetries) || bounds.maxRetries < 0) {
    throw requestInvalid('bounds.maxRetries must be an integer >= 0');
  }
}

function checkElement(element, index) {
  const fail = (message) => requestInvalid(`state.elements[${index}]: ${message}`);
  if (!element || typeof element !== 'object') throw fail('must be an object');
  assertNoExtra(element, ELEMENT_KEYS, fail, `state.elements[${index}]`);
  for (const key of ['ref', 'role', 'name', 'value', 'enabled', 'visible', 'operations']) {
    if (!(key in element)) throw fail(`missing required field ${key}`);
  }
  if (typeof element.ref !== 'string' || !/^[a-zA-Z0-9_:-]+$/.test(element.ref)) throw fail('ref violates the frozen pattern');
  if (typeof element.role !== 'string' || element.role.length === 0) throw fail('role must be a non-empty string');
  if (typeof element.name !== 'string' || typeof element.value !== 'string') throw fail('name/value must be strings');
  if (typeof element.enabled !== 'boolean' || typeof element.visible !== 'boolean') throw fail('enabled/visible must be booleans');
  if (!Array.isArray(element.operations)) throw fail('operations must be an array');
  for (const operation of element.operations) {
    if (!ELEMENT_OPERATIONS.includes(operation)) throw fail('unknown element operation');
  }
  if (new Set(element.operations).size !== element.operations.length) throw fail('operations must be unique');
  for (const key of ['checked', 'selected', 'expanded']) {
    if (key in element && !(typeof element[key] === 'boolean' || element[key] === null)) {
      throw fail(`${key} must be a boolean or null`);
    }
  }
  if ('parentContext' in element) {
    if (!Array.isArray(element.parentContext) || element.parentContext.some((entry) => typeof entry !== 'string')) {
      throw fail('parentContext must be an array of strings');
    }
  }
}

function checkCaptchaEvidence(evidence) {
  const fail = (message) => requestInvalid(`state.captchaEvidence: ${message}`);
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw fail('must be an object');
  assertNoExtra(evidence, CAPTCHA_EVIDENCE_KEYS, fail, 'state.captchaEvidence');
  if (!('detectorKind' in evidence)) throw fail('missing required field detectorKind');
  if (!DETECTOR_KINDS.includes(evidence.detectorKind)) {
    throw fail('detectorKind is outside the frozen enum');
  }
  for (const key of ['sitekey', 'action']) {
    if (key in evidence && !(typeof evidence[key] === 'string' || evidence[key] === null)) {
      throw fail(`${key} must be a string or null`);
    }
  }
  for (const key of ['fingerprint', 'evidence']) {
    if (key in evidence && typeof evidence[key] !== 'string') throw fail(`${key} must be a string`);
  }
  for (const key of ['interactive', 'solvableByPackage']) {
    if (key in evidence && typeof evidence[key] !== 'boolean') throw fail(`${key} must be a boolean`);
  }
}

function checkState(state, kind = null) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw requestInvalid('state must be an object');
  assertNoExtra(
    state,
    new Set(['snapshotDigest', 'urlOrigin', 'goal', 'elements', 'recentActions', 'captchaEvidence']),
    requestInvalid,
    'state',
  );
  for (const key of ['snapshotDigest', 'urlOrigin', 'goal']) {
    if (!(key in state)) throw requestInvalid(`state missing required field ${key}`);
  }
  assertDigest(state.snapshotDigest, requestInvalid, 'state.snapshotDigest');
  if (typeof state.urlOrigin !== 'string' || !ORIGIN_RE.test(state.urlOrigin)) {
    throw requestInvalid('state.urlOrigin must be origin-only (scheme://host[:port])');
  }
  if (typeof state.goal !== 'string' || state.goal.length === 0) throw requestInvalid('state.goal must be non-empty');
  if ('elements' in state) {
    if (!Array.isArray(state.elements)) throw requestInvalid('state.elements must be an array');
    state.elements.forEach(checkElement);
  }
  if ('recentActions' in state) {
    if (!Array.isArray(state.recentActions)) throw requestInvalid('state.recentActions must be an array');
    for (const [index, action] of state.recentActions.entries()) {
      const fail = (message) => requestInvalid(`state.recentActions[${index}]: ${message}`);
      if (!action || typeof action !== 'object' || !OPERATIONS.includes(action.operation)) {
        throw fail('operation must be a known operation');
      }
      assertNoExtra(action, RECENT_ACTION_KEYS, fail, `state.recentActions[${index}]`);
      if ('targetRef' in action && !(typeof action.targetRef === 'string' || action.targetRef === null)) {
        throw fail('targetRef must be a string or null');
      }
      if ('text' in action && typeof action.text !== 'string') throw fail('text must be a string');
      if ('values' in action) {
        if (!Array.isArray(action.values) || action.values.some((entry) => typeof entry !== 'string')) {
          throw fail('values must be an array of strings');
        }
      }
    }
  }
  // Frozen allOf: captcha-classify and captcha-next-step require evidence.
  if (typeof kind === 'string' && kind.startsWith('captcha-') && !('captchaEvidence' in state)) {
    throw requestInvalid('captcha requests require state.captchaEvidence');
  }
  if ('captchaEvidence' in state) checkCaptchaEvidence(state.captchaEvidence);
}

function checkQuestionSet(questionSet) {
  if (!questionSet || typeof questionSet !== 'object') throw requestInvalid('questionSet must be an object');
  assertNoExtra(questionSet, new Set(['id', 'version', 'digest']), requestInvalid, 'questionSet');
  if (typeof questionSet.id !== 'string' || questionSet.id.length === 0) throw requestInvalid('questionSet.id must be non-empty');
  if (!Number.isInteger(questionSet.version) || questionSet.version < 1) throw requestInvalid('questionSet.version must be an integer >= 1');
  assertDigest(questionSet.digest, requestInvalid, 'questionSet.digest');
}

function checkCriterionValue(id, key, descriptor) {
  const fail = (message) => requestInvalid(`question criteria: ${message}`);
  if (descriptor === null || typeof descriptor === 'string') return;
  if (descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)) {
    assertNoExtra(descriptor, CRITERION_DESCRIPTOR_KEYS, fail, 'question criteria');
    for (const field of ['role', 'name', 'value']) {
      if (field in descriptor && typeof descriptor[field] !== 'string') throw fail(`${field} must be a string`);
    }
    return;
  }
  throw fail('must be a string, an object descriptor, or null');
}

function checkQuestions(questions, kind) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    throw requestInvalid('questions must be an object');
  }
  for (const [id, question] of Object.entries(questions)) {
    if (!question || typeof question !== 'object') throw requestInvalid('question must be an object');
    assertNoExtra(question, new Set(['type', 'instructions', 'criteria']), requestInvalid, `question`);
    if (!QUESTION_TYPES.includes(question.type)) throw requestInvalid('question type must be choice|score|noul');
    const instructions = question.instructions;
    if (!instructions || typeof instructions !== 'object') throw requestInvalid('question instructions must be an object');
    assertNoExtra(instructions, INSTRUCTION_KEYS, requestInvalid, 'question instructions');
    if (typeof instructions.question !== 'string' || instructions.question.length === 0) {
      throw requestInvalid('question instructions.question must be non-empty');
    }
    if ('goal' in instructions && typeof instructions.goal !== 'string') {
      throw requestInvalid('question instructions.goal must be a string');
    }
    if ('assumedOperation' in instructions && !OPERATIONS.includes(instructions.assumedOperation)) {
      throw requestInvalid('question instructions.assumedOperation must be a known operation');
    }
    if ('criteria' in question) {
      const { criteria } = question;
      if (criteria === null || typeof criteria !== 'object' || Array.isArray(criteria)) {
        throw requestInvalid('question criteria must be an object when present');
      }
      for (const [key, descriptor] of Object.entries(criteria)) checkCriterionValue(id, key, descriptor);
    }
  }
  // Kind-scoped required question ids (frozen allOf rules).
  if (kind === 'browser-step' && !('operation' in questions)) {
    throw requestInvalid('browser-step requests require an "operation" question');
  }
  if (kind === 'captcha-classify' && !('captcha_kind' in questions)) {
    throw requestInvalid('captcha-classify requests require a "captcha_kind" question');
  }
  if (kind === 'captcha-next-step') {
    for (const id of ['solver', 'next_step']) {
      if (!(id in questions)) throw requestInvalid(`captcha-next-step requests require a ${JSON.stringify(id)} question`);
    }
    if (questions.solver?.type !== 'choice' || questions.next_step?.type !== 'choice') {
      throw requestInvalid('captcha-next-step solver/next_step questions must be choice type');
    }
    // The criteria keys ARE the allowlist (frozen propertyNames enums):
    // required, non-empty, and restricted to the frozen key sets.
    for (const [id, allowed] of [['solver', SOLVER_CRITERIA_KEYS], ['next_step', NEXT_STEP_CRITERIA_KEYS]]) {
      const criteria = questions[id]?.criteria;
      if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
        throw requestInvalid(`captcha-next-step ${id} requires non-empty criteria`);
      }
      const keys = Object.keys(criteria);
      if (keys.length === 0) throw requestInvalid(`captcha-next-step ${id} requires non-empty criteria`);
      for (const key of keys) {
        if (!allowed.includes(key)) throw requestInvalid(`captcha-next-step ${id} carries a criteria key outside the frozen allowlist`);
      }
    }
  }
}

export function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw requestInvalid('request must be an object');
  }
  const required = ['schema', 'requestId', 'kind', 'state', 'questionSet', 'questions', 'bounds', 'caller', 'fallbackPolicy'];
  for (const key of required) {
    if (!(key in request)) throw requestInvalid(`request missing required field ${key}`);
  }
  assertNoExtra(request, new Set(required), requestInvalid, 'request');
  if (request.schema !== JEV_REQUEST_SCHEMA) throw requestInvalid(`request schema must be ${JEV_REQUEST_SCHEMA}`);
  if (request.requestId !== undefined) assertRequestId(request.requestId, requestInvalid);
  if (!REQUEST_KINDS.includes(request.kind)) throw requestInvalid('request kind is unknown');
  checkState(request.state, request.kind);
  checkQuestionSet(request.questionSet);
  checkQuestions(request.questions, request.kind);
  checkBounds(request.bounds);
  const caller = request.caller;
  if (!caller || typeof caller !== 'object') throw requestInvalid('caller must be an object');
  assertNoExtra(caller, new Set(['runId', 'permitId']), requestInvalid, 'caller');
  if (typeof caller.runId !== 'string' || caller.runId.length === 0) throw requestInvalid('caller.runId must be non-empty');
  if (!(typeof caller.permitId === 'string' || caller.permitId === null)) {
    throw requestInvalid('caller.permitId must be a string or null (correlation only)');
  }
  if (!FALLBACK_POLICIES.includes(request.fallbackPolicy)) {
    throw requestInvalid('fallbackPolicy is unknown');
  }
  return request;
}

const FORBIDDEN_RESULT_FIELDS = ['approved', 'allowed', 'passed', 'done', 'solved'];

export function validateResult(result, { request = null } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw responseInvalid('result must be an object');
  }
  const required = ['schema', 'requestId', 'status', 'advisoryOnly', 'answers', 'lineage', 'timing', 'usage'];
  for (const key of required) {
    if (!(key in result)) throw responseInvalid(`result missing required field ${key}`);
  }
  assertNoExtra(result, new Set(required), responseInvalid, 'result');
  if (result.schema !== JEV_RESULT_SCHEMA) throw responseInvalid(`result schema must be ${JEV_RESULT_SCHEMA}`);
  assertRequestId(result.requestId, responseInvalid);
  if (result.status !== 'ok') throw responseInvalid('result status must be "ok" (errors travel via fallback)');
  if (result.advisoryOnly !== true) throw responseInvalid('result advisoryOnly must be true');
  for (const field of FORBIDDEN_RESULT_FIELDS) {
    if (field in result) throw responseInvalid(`result must not carry authority field ${field}`);
  }
  if (request && result.requestId !== request.requestId) {
    throw responseInvalid('result requestId must match the request requestId');
  }
  try {
    validateAnswers(result.answers, request?.questions ?? nullForOpenValidation(result.answers));
  } catch (error) {
    if (error?.code === 'JEV_RESPONSE_INVALID') throw error;
    throw responseInvalid(error?.message ?? 'invalid answers', { cause: String(error) });
  }
  const lineage = result.lineage;
  if (!lineage || typeof lineage !== 'object') throw responseInvalid('lineage must be an object');
  assertNoExtra(
    lineage,
    new Set(['provider', 'model', 'skillDigest', 'questionSetDigest', 'stateDigest', 'requestDigest']),
    responseInvalid,
    'lineage',
  );
  if (lineage.provider !== 'typesafe') throw responseInvalid('lineage.provider must be "typesafe"');
  if (typeof lineage.model !== 'string' || !MODEL_RE.test(lineage.model)) {
    throw responseInvalid('lineage.model must match ^jev-[0-9.]+$');
  }
  for (const key of ['skillDigest', 'questionSetDigest', 'stateDigest', 'requestDigest']) {
    assertDigest(lineage[key], responseInvalid, `lineage.${key}`);
  }
  const timing = result.timing;
  if (!timing || typeof timing !== 'object') throw responseInvalid('timing must be an object');
  assertNoExtra(timing, new Set(['latencyMs', 'attempts']), responseInvalid, 'timing');
  if (!Number.isInteger(timing.latencyMs) || timing.latencyMs < 0) throw responseInvalid('timing.latencyMs must be an integer >= 0');
  if (!Number.isInteger(timing.attempts) || timing.attempts < 1) throw responseInvalid('timing.attempts must be an integer >= 1');
  const usage = result.usage;
  if (!usage || typeof usage !== 'object') throw responseInvalid('usage must be an object');
  assertNoExtra(usage, new Set(['inputTokens', 'outputTokens']), responseInvalid, 'usage');
  for (const key of ['inputTokens', 'outputTokens']) {
    if (!Number.isInteger(usage[key]) || usage[key] < 0) throw responseInvalid(`usage.${key} must be an integer >= 0`);
  }
  return result;
}

// Without the originating request we can still check answer shapes, but not
// option membership. This adapter exposes each answer's own option set.
function nullForOpenValidation(answers) {
  const questions = {};
  for (const [id, answer] of Object.entries(answers ?? {})) {
    if (answer?.type === 'choice' && answer?.probabilities && typeof answer.probabilities === 'object') {
      questions[id] = { type: 'choice', criteria: Object.fromEntries(Object.keys(answer.probabilities).map((key) => [key, null])) };
    } else if (answer?.type === 'score') {
      questions[id] = { type: 'score' };
    } else if (answer?.type === 'noul') {
      questions[id] = { type: 'noul' };
    } else {
      questions[id] = { type: answer?.type };
    }
  }
  return questions;
}

export function validateFallback(fallback) {
  if (!fallback || typeof fallback !== 'object' || Array.isArray(fallback)) {
    throw responseInvalid('fallback must be an object');
  }
  const required = ['schema', 'requestId', 'status', 'decisionEngine', 'reason', 'retryable', 'circuit', 'stateDigest'];
  for (const key of required) {
    if (!(key in fallback)) throw responseInvalid(`fallback missing required field ${key}`);
  }
  assertNoExtra(fallback, new Set(required), responseInvalid, 'fallback');
  if (fallback.schema !== JEV_FALLBACK_SCHEMA) throw responseInvalid(`fallback schema must be ${JEV_FALLBACK_SCHEMA}`);
  assertRequestId(fallback.requestId, responseInvalid);
  if (fallback.status !== 'fallback-required') throw responseInvalid('fallback status must be "fallback-required"');
  if (!FALLBACK_ENGINES.includes(fallback.decisionEngine)) {
    throw responseInvalid('fallback decisionEngine is unknown');
  }
  // Reason must be one of the frozen 14 taxonomy codes (checked locally,
  // not imported, to avoid a require cycle with fallback.mjs).
  if (typeof fallback.reason !== 'string' || !FALLBACK_REASONS.has(fallback.reason)) {
    throw responseInvalid('fallback reason is outside the frozen 14-code enum');
  }
  if (typeof fallback.retryable !== 'boolean') throw responseInvalid('fallback retryable must be a boolean');
  if (!CIRCUIT_STATES.includes(fallback.circuit)) throw responseInvalid('fallback circuit must be open|closed|half-open');
  assertDigest(fallback.stateDigest, responseInvalid, 'fallback.stateDigest');
  return fallback;
}
