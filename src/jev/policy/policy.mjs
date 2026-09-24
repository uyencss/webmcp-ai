// Promoted copy of runner policy module.
// Source: packages/webmcp-automation-runner/src/runner/jev-fallback/policy.mjs
// Source commit: aae9d8ed0d5ebea199f13650f4113c07b58917da
// Source policy.mjs sha256: 6f6148601d17ae113456c60da5d727562ab59be8c03739ff85aa0df9e96a2814
// Failure-path wiring only; success-path guard wiring is follow-up.
// Divergence risk: two copies until M7 single-sources it.

import { createHash } from 'node:crypto';
import { AiCliError } from '../../errors.mjs';

function digestBytes(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalNumber(value) {
  if (!Number.isFinite(value)) throw new Error('number must be finite');
  if (Object.is(value, -0)) return '0';
  return JSON.stringify(value);
}

function canonicalString(value) {
  return JSON.stringify(value);
}

function canonicalValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return canonicalString(value);
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalValue(entry)).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${canonicalString(key)}:${canonicalValue(value[key])}`).join(',')}}`;
  }
  throw new Error(`unsupported value type: ${typeof value}`);
}

function digestCanonical(value, contractId) {
  const payload = `webmcp-digest-v1\u0000${contractId}\u0000${canonicalValue(value)}`;
  return digestBytes(payload);
}

export const JEV_FALLBACK_SCHEMA = 'webmcp-runner-jev-fallback/1';
export const JEV_GUARD_SCHEMA = 'webmcp-runner-jev-guard/1';
export const JEV_STOP_SCHEMA = 'webmcp-runner-jev-stop/1';
export const JEV_COHORT_SCHEMA = 'webmcp-runner-jev-cohort/1';
export const JEV_SCAN_SCHEMA = 'webmcp-runner-jev-scan/1';
export const JEV_FALLBACK_STOP_STATE = 'JEV_FAST_PATH_DISABLED';

export const DECISION_ENGINES = Object.freeze([
  'jev',
  'normal-agent',
  'deterministic',
  'human',
  'blocked',
]);

export const ENGINE_STATES = Object.freeze([
  'JEV_READY',
  'JEV_TRANSIENT_FAILURE',
  'JEV_CIRCUIT_OPEN',
  'FALLBACK_NORMAL_AGENT',
  'FALLBACK_DETERMINISTIC',
  'HUMAN_REQUIRED',
  'BLOCKED',
]);

export const CAPABILITIES = Object.freeze([
  'browser-step',
  'captcha-classify',
  'captcha-next-step',
  'query',
]);

export const LOW_RISK_OPERATIONS = Object.freeze([
  'CLICK',
  'TYPE_TEXT',
  'HOVER',
  'SELECT',
]);

export const CONTROL_OPERATIONS = Object.freeze([
  'WAIT',
  'DONE',
  'BLOCKED',
]);

export const FAILURE_REASONS = Object.freeze([
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

export const POLICY_REASONS = Object.freeze([
  'JEV_FAST_PATH_DISABLED',
  'JEV_DISABLED_BY_FLAG',
  'JEV_CAPABILITY_DISABLED',
  'ORIGIN_NOT_ALLOWLISTED',
  'COHORT_OUT_OF_SCOPE',
  'PERMIT_DENIED',
  'OPERATION_CLASS_NOT_PERMITTED',
  'POLICY_IRREVERSIBLE_ACTION',
  'POLICY_CAPTCHA_HUMAN_REQUIRED',
  'POLICY_CAPTCHA_V3_NO_SOLVE',
  'STALE_SNAPSHOT',
  'SOLVER_KIND_MISMATCH',
]);

export const STOP_TRIGGER_CODES = Object.freeze([
  'UNAUTHORIZED_ACTION',
  'STALE_TARGET_EXECUTION',
  'V3_SOLVE_ATTEMPT',
  'RESULT_AS_PERMIT',
  'SECRET_IN_RECEIPT',
  'SILENT_FALLBACK',
  'COMPLETION_WINDOW',
  'LATENCY_WINDOW',
]);

export const DEFAULT_FLAGS = Object.freeze({
  enabled: true,
  capabilities: Object.freeze({}),
  killSwitch: false,
});

export const DEFAULT_COHORT = Object.freeze({
  environment: 'local',
  percent: 5,
  authorizationId: null,
});

const RETRYABLE_FAILURES = new Set([
  'JEV_RATE_LIMITED',
  'JEV_OVERLOADED',
  'JEV_TIMEOUT',
  'JEV_TRANSPORT_FAILED',
  'PROVIDER_BUSY',
]);

const VOCABULARY_OPERATIONS = new Set([
  ...LOW_RISK_OPERATIONS,
  ...CONTROL_OPERATIONS,
]);

const CAPTCHA_KINDS = new Set([
  'recaptcha_v2',
  'recaptcha_v2_invisible',
  'recaptcha_v3',
  'hcaptcha',
  'turnstile',
  'aws_waf',
  'arkose',
  'datadome',
  'perimeterx',
  'akamai_bm',
  'kasada',
  'tiktok',
  'unknown',
]);

const DECIDE_ACCEPTED_KEYS = new Set([
  'kind',
  'operation',
  'irreversible',
  'captchaKind',
  'interactive',
  'failure',
  'circuit',
  'attempts',
  'maxAttempts',
  'fallbackPolicy',
  'flags',
  'cohort',
  'stopState',
  'now',
  'state',
  'urlOrigin',
  'policy',
  'solverId',
  'solverProposal',
  'advisory',
  'solverKindMap',
]);

const GUARD_ACCEPTED_KEYS = new Set([
  'decision',
  'operation',
  'irreversible',
  'captchaKind',
  'interactive',
  'invokesSolver',
  'permit',
  'snapshot',
]);

const STOP_ACCEPTED_KEYS = new Set([
  'events',
  'thresholds',
  'now',
]);

const COHORT_CONFIG_ACCEPTED_KEYS = new Set([
  'environment',
  'percent',
  'authorizationId',
]);

const FORBIDDEN_KEY = /token|cookie|authorization|secret|password|passwd|pwd|api[-_]?key|x[-_]?api[-_]?key|profile_?id|db_?path|database|private[-_]?key|session[-_]?id|credential/i;
const FORBIDDEN_VALUE_SLASH_ROOTED = /^\//;
const FORBIDDEN_VALUE_UNIX_PATH = /(?:^|[\s"'=(:\[{,])\/(?!\/)(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+/;
const FORBIDDEN_VALUE_WIN_DRIVE = /(?<![A-Za-z])[A-Za-z]:[\\/]/;
const FORBIDDEN_VALUE_DB = /(?:\.db|\.sqlite|\.sqlite3|-wal|-shm)(\b|$)/i;
const FORBIDDEN_VALUE_QUERY_PARAM = /[?&](?:token|key|secret|apikey|api_key|api-key|client_secret|password|passwd|access_token|auth_token|refresh_token)(?=[=&]|$)/i;
const FORBIDDEN_VALUE_URL_QUERY = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*\?/i;
const FORBIDDEN_VALUE_BEARER = /\bbearer\b/i;
const FORBIDDEN_VALUE_BASIC = /\bbasic\s+[A-Za-z0-9+/=]{8,}/i;
const FORBIDDEN_VALUE_BASIC_DECODE = /\bbasic\s+([A-Za-z0-9+/=]{4,})/gi;

function hasDecodableBasicCredential(str) {
  if (typeof str !== 'string') return false;
  try {
    for (const match of str.matchAll(FORBIDDEN_VALUE_BASIC_DECODE)) {
      const token = match[1];
      try {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        if (decoded.includes(':')) {
          return true;
        }
      } catch {
        // ignore decode errors
      }
    }
  } catch {
    // ignore regex errors
  }
  return false;
}

const FORBIDDEN_VALUE_JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;
const FORBIDDEN_VALUE_FILE_URI = /file:\/\//i;
const FORBIDDEN_VALUE_UNC = /(?:^|[^\\])\\\\[A-Za-z0-9_.$~-]+(?:[\\\/][A-Za-z0-9_.$~-]+)+/;
const FORBIDDEN_VALUE_HOME = /(?:^|[\s"'=(:\[{,])~\//;
const FORBIDDEN_VALUE_URL_AUTH = /\b[a-z][a-z0-9+.-]*:\/\/[^\s\/?#@]+@[^\s\/?#]+/i;
const SENSITIVE_URL_PARAM_NAMES = 'token|key|secret|apikey|api_key|api-key|client_secret|password|passwd|access_token|auth_token|refresh_token';
const FORBIDDEN_VALUE_URL_FRAGMENT = new RegExp(
  String.raw`\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>#]*#[^\s"'<>]*(?:=|${SENSITIVE_URL_PARAM_NAMES})`,
  'i',
);
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9_$.-]+$/;

function isForbiddenStringValue(node) {
  return (
    FORBIDDEN_VALUE_SLASH_ROOTED.test(node) ||
    FORBIDDEN_VALUE_UNIX_PATH.test(node) ||
    FORBIDDEN_VALUE_WIN_DRIVE.test(node) ||
    FORBIDDEN_VALUE_DB.test(node) ||
    FORBIDDEN_VALUE_QUERY_PARAM.test(node) ||
    FORBIDDEN_VALUE_URL_QUERY.test(node) ||
    FORBIDDEN_VALUE_BEARER.test(node) ||
    FORBIDDEN_VALUE_BASIC.test(node) ||
    hasDecodableBasicCredential(node) ||
    FORBIDDEN_VALUE_JWT.test(node) ||
    FORBIDDEN_VALUE_FILE_URI.test(node) ||
    FORBIDDEN_VALUE_UNC.test(node) ||
    FORBIDDEN_VALUE_HOME.test(node) ||
    FORBIDDEN_VALUE_URL_AUTH.test(node) ||
    FORBIDDEN_VALUE_URL_FRAGMENT.test(node)
  );
}

function isForbiddenOriginKey(key) {
  if (typeof key !== 'string' || key.length === 0) return true;
  if (key.includes('?') || key.includes('#') || key.includes('@')) return true;
  if (/\s$/.test(key)) return true;
  return false;
}

const SNAPSHOT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const NOW_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function failInput(message, violationCode, details = {}) {
  throw new AiCliError('JEV_FALLBACK_INPUT_INVALID', message, {
    exitCode: 3,
    details: { violationCode, ...details },
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stripUndefinedRecursively(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stripUndefinedRecursively);
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) {
        const cleaned = stripUndefinedRecursively(v);
        if (cleaned !== undefined) {
          result[k] = cleaned;
        }
      }
    }
    if (Object.keys(result).length === 0) {
      return undefined;
    }
    return result;
  }
  return value;
}

function getBaselineEngine(kind) {
  if (kind === 'browser-step') return 'normal-agent';
  if (kind === 'captcha-classify' || kind === 'captcha-next-step') return 'deterministic';
  if (kind === 'query') return 'blocked';
  throw new Error(`Unexpected kind '${kind}'`);
}

function engineToPolicyState(engine) {
  if (engine === 'normal-agent') return 'FALLBACK_NORMAL_AGENT';
  if (engine === 'deterministic') return 'FALLBACK_DETERMINISTIC';
  if (engine === 'human') return 'HUMAN_REQUIRED';
  if (engine === 'blocked') return 'BLOCKED';
  throw new Error(`Unexpected engine for fallback state: ${engine}`);
}

function engineToState(engine, circuit) {
  if (circuit === 'open' && (engine === 'normal-agent' || engine === 'deterministic')) {
    return 'JEV_CIRCUIT_OPEN';
  }
  return engineToPolicyState(engine);
}

function resolveTargetEngine(candidate, input) {
  if (candidate === 'abort' || candidate === 'blocked') {
    return 'blocked';
  }
  if (candidate === 'human') {
    return 'human';
  }
  const isActionKind = input.kind === 'browser-step' || input.kind === 'captcha-classify' || input.kind === 'captcha-next-step';
  if (isActionKind) {
    if (input.irreversible === true) {
      return 'human';
    }
    if (input.captchaKind === 'turnstile' && input.interactive === true) {
      return 'human';
    }
  }
  const isCaptchaKind = input.kind === 'captcha-classify' || input.kind === 'captcha-next-step';
  if (isCaptchaKind) {
    if (input.captchaKind === 'recaptcha_v3') {
      return 'deterministic';
    }
  }
  if (candidate === 'deterministic' || candidate === 'normal-agent') {
    return candidate;
  }
  return getBaselineEngine(input.kind);
}

function validateCohortConfig(config) {
  if (!isPlainObject(config)) {
    failInput('cohort config must be a plain object', 'COHORT_CONFIG_INVALID');
  }
  for (const k of Object.keys(config)) {
    if (!COHORT_CONFIG_ACCEPTED_KEYS.has(k)) {
      failInput(`Unrecognized cohort config key '${k}'`, 'COHORT_CONFIG_INVALID', { key: k });
    }
  }
  if (config.environment !== undefined) {
    if (!['local', 'test', 'production', 'staging'].includes(config.environment)) {
      failInput('environment must be local, test, production, or staging', 'COHORT_CONFIG_INVALID');
    }
  }
  if (config.percent !== undefined) {
    if (config.percent !== 5 && config.percent !== 25) {
      failInput('percent must be 5 or 25', 'COHORT_CONFIG_INVALID');
    }
  }
  if (config.authorizationId !== undefined && config.authorizationId !== null) {
    if (typeof config.authorizationId !== 'string') {
      failInput('authorizationId must be a string or null', 'COHORT_CONFIG_INVALID');
    }
  }
}

export function cohortMembership(input) {
  if (!isPlainObject(input)) {
    failInput('cohortMembership input must be a plain object', 'COHORT_INPUT_INVALID');
  }
  for (const k of Object.keys(input)) {
    if (k !== 'key' && k !== 'config') {
      failInput(`Unrecognized key '${k}' in cohortMembership input`, 'COHORT_INPUT_INVALID', { key: k });
    }
  }
  if (typeof input.key !== 'string' || input.key.length === 0) {
    failInput('cohort key must be a non-empty string', 'KEY_REQUIRED');
  }

  const config = input.config === undefined ? DEFAULT_COHORT : input.config;
  validateCohortConfig(config);

  const environment = config.environment ?? 'local';
  const percent = config.percent ?? 5;
  const authorizationId = config.authorizationId ?? null;

  const digest = digestBytes(String(input.key));
  const bucket = parseInt(digest.slice(7, 15), 16) % 10000;

  let inCohort = false;
  let reason = null;

  if (environment !== 'local' && environment !== 'test') {
    inCohort = false;
    reason = 'COHORT_ENV_NOT_ALLOWED';
  } else if (
    percent > 5 &&
    (!authorizationId || typeof authorizationId !== 'string' || authorizationId.trim().length === 0)
  ) {
    inCohort = false;
    reason = 'COHORT_NOT_AUTHORIZED';
  } else {
    inCohort = bucket < percent * 100;
    reason = null;
  }

  return Object.freeze({
    schema: JEV_COHORT_SCHEMA,
    inCohort,
    reason,
    bucket,
    percent,
    environment,
  });
}

export function decideFallback(input) {
  if (!isPlainObject(input)) {
    failInput('decideFallback input must be a plain object', 'INPUT_NOT_OBJECT');
  }

  for (const k of Object.keys(input)) {
    if (!DECIDE_ACCEPTED_KEYS.has(k)) {
      failInput(`Unrecognized key '${k}' in decideFallback input`, 'UNRECOGNIZED_KEY', { key: k });
    }
  }

  if (!CAPABILITIES.includes(input.kind)) {
    failInput(`kind must be one of: ${CAPABILITIES.join(', ')}`, 'KIND_INVALID');
  }

  const allowedPolicies = (input.kind === 'browser-step' || input.kind === 'query')
    ? ['normal-agent', 'human', 'abort']
    : ['deterministic', 'human', 'abort'];

  if (!allowedPolicies.includes(input.fallbackPolicy)) {
    failInput(
      `fallbackPolicy '${input.fallbackPolicy}' is invalid for kind '${input.kind}'`,
      'FALLBACK_POLICY_INVALID',
    );
  }

  if (input.flags !== undefined && input.flags !== null) {
    if (!isPlainObject(input.flags)) {
      failInput('flags must be a plain object', 'FLAGS_INVALID');
    }
    for (const k of Object.keys(input.flags)) {
      if (k !== 'enabled' && k !== 'capabilities' && k !== 'killSwitch' && k !== 'origins') {
        failInput(`Unrecognized flag '${k}'`, 'FLAGS_INVALID', { key: k });
      }
    }
    if (input.flags.enabled !== undefined && typeof input.flags.enabled !== 'boolean') {
      failInput('flags.enabled must be a boolean', 'FLAGS_INVALID');
    }
    if (input.flags.killSwitch !== undefined && typeof input.flags.killSwitch !== 'boolean') {
      failInput('flags.killSwitch must be a boolean', 'FLAGS_INVALID');
    }
    if (input.flags.capabilities !== undefined) {
      if (!isPlainObject(input.flags.capabilities)) {
        failInput('flags.capabilities must be a plain object', 'FLAGS_INVALID');
      }
      for (const [capKey, capVal] of Object.entries(input.flags.capabilities)) {
        if (!CAPABILITIES.includes(capKey)) {
          failInput(`flags.capabilities contains unknown capability '${capKey}'`, 'FLAGS_INVALID', { key: capKey });
        }
        if (capVal === undefined) {
          continue;
        }
        if (typeof capVal !== 'boolean') {
          failInput(`flags.capabilities['${capKey}'] must be a boolean`, 'FLAGS_INVALID');
        }
      }
    }
    if (input.flags.origins !== undefined) {
      if (!isPlainObject(input.flags.origins)) {
        failInput('flags.origins must be a plain object', 'FLAGS_INVALID');
      }
      for (const [originKey, originVal] of Object.entries(input.flags.origins)) {
        if (isForbiddenOriginKey(originKey)) {
          failInput(`flags.origins contains invalid origin key '${originKey}'`, 'FLAGS_INVALID', { key: originKey });
        }
        if (originVal === undefined) {
          continue;
        }
        if (typeof originVal !== 'boolean') {
          failInput(`flags.origins['${originKey}'] must be a boolean`, 'FLAGS_INVALID');
        }
      }
    }
  }

  if (input.policy !== undefined) {
    if (!isPlainObject(input.policy)) {
      failInput('policy must be a plain object', 'POLICY_INVALID');
    }
    for (const k of Object.keys(input.policy)) {
      if (k !== 'solverKindMap') {
        failInput(`Unrecognized policy key '${k}'`, 'POLICY_INVALID', { key: k });
      }
    }
  }

  let solverKindMap = undefined;
  const rawMap = (input.policy && input.policy.solverKindMap !== undefined)
    ? input.policy.solverKindMap
    : input.solverKindMap;

  if (rawMap !== undefined) {
    if (!isPlainObject(rawMap)) {
      failInput('policy.solverKindMap must be a plain object', 'POLICY_INVALID');
    }
    const copy = {};
    for (const [kindKey, solvers] of Object.entries(rawMap)) {
      if (!CAPTCHA_KINDS.has(kindKey)) {
        failInput(`policy.solverKindMap contains unknown captchaKind '${kindKey}'`, 'POLICY_INVALID', { key: kindKey });
      }
      if (solvers === undefined) {
        continue;
      }
      if (!Array.isArray(solvers) || solvers.length === 0) {
        failInput(`policy.solverKindMap['${kindKey}'] must be a non-empty array`, 'POLICY_INVALID', { key: kindKey });
      }
      for (const solverId of solvers) {
        if (typeof solverId !== 'string' || solverId.trim().length === 0) {
          failInput(`policy.solverKindMap['${kindKey}'] contains invalid solverId`, 'POLICY_INVALID', { key: kindKey });
        }
      }
      copy[kindKey] = Object.freeze([...solvers]);
    }
    solverKindMap = Object.freeze(copy);
  }

  if (input.solverId !== undefined) {
    if (typeof input.solverId !== 'string' || input.solverId.trim().length === 0) {
      failInput('solverId must be a non-empty string', 'SOLVER_ID_INVALID');
    }
  }

  if (input.solverProposal !== undefined) {
    if (typeof input.solverProposal !== 'string' && !isPlainObject(input.solverProposal)) {
      failInput('solverProposal must be a string or plain object', 'SOLVER_PROPOSAL_INVALID');
    }
    if (isPlainObject(input.solverProposal)) {
      if (
        input.solverProposal.solverId !== undefined &&
        (typeof input.solverProposal.solverId !== 'string' || input.solverProposal.solverId.trim().length === 0)
      ) {
        failInput('solverProposal.solverId must be a non-empty string', 'SOLVER_PROPOSAL_INVALID');
      }
    }
  }

  if (input.failure !== undefined && input.failure !== null) {
    if (!FAILURE_REASONS.includes(input.failure)) {
      failInput(`failure must be null or one of FAILURE_REASONS`, 'FAILURE_CODE_INVALID');
    }
  }

  if (input.circuit !== undefined && input.circuit !== null) {
    if (input.circuit !== 'closed' && input.circuit !== 'open' && input.circuit !== 'half-open') {
      failInput("circuit must be 'closed', 'open', or 'half-open'", 'CIRCUIT_INVALID');
    }
  }

  if (input.attempts !== undefined && input.attempts !== null) {
    if (!Number.isInteger(input.attempts) || input.attempts < 0) {
      failInput('attempts must be an integer >= 0', 'ATTEMPTS_INVALID');
    }
  }

  if (input.maxAttempts !== undefined && input.maxAttempts !== null) {
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
      failInput('maxAttempts must be an integer >= 1', 'MAX_ATTEMPTS_INVALID');
    }
  }

  if (input.operation !== undefined && input.operation !== null) {
    if (!VOCABULARY_OPERATIONS.has(input.operation)) {
      failInput('operation must be null or one of the 7 vocabulary operations', 'OPERATION_INVALID');
    }
  }

  if (input.irreversible !== undefined && typeof input.irreversible !== 'boolean') {
    failInput('irreversible must be a boolean', 'IRREVERSIBLE_INVALID');
  }

  if (input.interactive !== undefined && typeof input.interactive !== 'boolean') {
    failInput('interactive must be a boolean', 'INTERACTIVE_INVALID');
  }

  if (input.captchaKind !== undefined && input.captchaKind !== null) {
    if (typeof input.captchaKind !== 'string' || !CAPTCHA_KINDS.has(input.captchaKind)) {
      failInput('captchaKind is invalid', 'CAPTCHA_KIND_INVALID');
    }
  }

  if (input.cohort !== undefined && input.cohort !== null) {
    if (!isPlainObject(input.cohort)) {
      failInput('cohort must be a plain object', 'COHORT_INVALID');
    }
    for (const k of Object.keys(input.cohort)) {
      if (k !== 'key' && k !== 'config') {
        failInput(`Unrecognized key '${k}' in cohort`, 'COHORT_INVALID', { key: k });
      }
    }
    if (typeof input.cohort.key !== 'string' || input.cohort.key.length === 0) {
      failInput('cohort.key must be a non-empty string', 'COHORT_INVALID');
    }
    if (input.cohort.config !== undefined) {
      validateCohortConfig(input.cohort.config);
    }
  }

  if (input.stopState !== undefined && input.stopState !== null) {
    if (input.stopState !== JEV_FALLBACK_STOP_STATE) {
      failInput(`stopState must be null or '${JEV_FALLBACK_STOP_STATE}'`, 'STOP_STATE_INVALID');
    }
  }

  let createdAt;
  if (input.now !== undefined) {
    if (typeof input.now !== 'function') {
      failInput('now must be a function', 'NOW_INVALID');
    }
    createdAt = input.now();
    if (typeof createdAt !== 'string' || !NOW_UTC_PATTERN.test(createdAt)) {
      failInput('now() return value must match ISO-8601 UTC pattern', 'NOW_INVALID');
    }
  } else {
    createdAt = new Date().toISOString();
  }

  const declared = input.fallbackPolicy;
  const attempts = input.attempts ?? 0;
  const maxAttempts = input.maxAttempts ?? 2;
  const circuit = input.circuit ?? 'closed';
  let failure = input.failure ?? null;
  if (circuit === 'open' && failure === null) {
    failure = 'JEV_CIRCUIT_OPEN';
  }

  let origins = undefined;
  if (input.flags && input.flags.origins !== undefined) {
    const copy = {};
    for (const [k, v] of Object.entries(input.flags.origins)) {
      if (v !== undefined) {
        copy[k] = v;
      }
    }
    origins = Object.freeze(copy);
  }

  const flags = input.flags ? {
    enabled: input.flags.enabled ?? true,
    capabilities: input.flags.capabilities ?? {},
    killSwitch: input.flags.killSwitch ?? false,
    origins,
  } : DEFAULT_FLAGS;

  let origin = undefined;
  if (input.state !== undefined && input.state !== null) {
    if (isPlainObject(input.state) || (typeof input.state === 'object' && !Array.isArray(input.state))) {
      origin = input.state.urlOrigin;
    }
  }
  if (origin === undefined && input.urlOrigin !== undefined) {
    origin = input.urlOrigin;
  }

  let proposedSolverId = null;
  if (typeof input.solverId === 'string' && input.solverId.trim().length > 0) {
    proposedSolverId = input.solverId.trim();
  } else if (typeof input.solverProposal === 'string' && input.solverProposal.trim().length > 0) {
    proposedSolverId = input.solverProposal.trim();
  } else if (isPlainObject(input.solverProposal) && typeof input.solverProposal.solverId === 'string' && input.solverProposal.solverId.trim().length > 0) {
    proposedSolverId = input.solverProposal.solverId.trim();
  } else if (isPlainObject(input.advisory) && typeof input.advisory.solverId === 'string' && input.advisory.solverId.trim().length > 0) {
    proposedSolverId = input.advisory.solverId.trim();
  }

  let engine;
  let state;
  let reason;
  let retryable = false;
  let retry = null;
  let fallback = null;

  // 1. flags.killSwitch === true or stopState === 'JEV_FAST_PATH_DISABLED' -> baseline engine for kind, reason: 'JEV_FAST_PATH_DISABLED'
  if (flags.killSwitch === true || input.stopState === JEV_FALLBACK_STOP_STATE) {
    engine = resolveTargetEngine(getBaselineEngine(input.kind), input);
    reason = 'JEV_FAST_PATH_DISABLED';
    state = engineToPolicyState(engine);
    fallback = Object.freeze({ reason, targetEngine: engine, circuit });
  }
  // 2. flags.enabled === false -> baseline, reason: 'JEV_DISABLED_BY_FLAG'
  else if (flags.enabled === false) {
    engine = resolveTargetEngine(getBaselineEngine(input.kind), input);
    reason = 'JEV_DISABLED_BY_FLAG';
    state = engineToPolicyState(engine);
    fallback = Object.freeze({ reason, targetEngine: engine, circuit });
  }
  // 3. flags.capabilities[kind] === false -> baseline, reason: 'JEV_CAPABILITY_DISABLED'
  else if (flags.capabilities && flags.capabilities[input.kind] === false) {
    engine = resolveTargetEngine(getBaselineEngine(input.kind), input);
    reason = 'JEV_CAPABILITY_DISABLED';
    state = engineToPolicyState(engine);
    fallback = Object.freeze({ reason, targetEngine: engine, circuit });
  }
  // 4. flags.origins present and origin is not allowlisted -> baseline, reason: 'ORIGIN_NOT_ALLOWLISTED'
  else if (
    flags.origins !== undefined &&
    (isForbiddenOriginKey(origin) || !Object.hasOwn(flags.origins, origin) || flags.origins[origin] !== true)
  ) {
    engine = resolveTargetEngine(getBaselineEngine(input.kind), input);
    reason = 'ORIGIN_NOT_ALLOWLISTED';
    state = engineToPolicyState(engine);
    fallback = Object.freeze({ reason, targetEngine: engine, circuit });
  }
  // 5. cohort provided and cohortMembership({key, config}).inCohort === false -> baseline, reason: 'COHORT_OUT_OF_SCOPE'
  else if (input.cohort != null && !cohortMembership(input.cohort).inCohort) {
    engine = resolveTargetEngine(getBaselineEngine(input.kind), input);
    reason = 'COHORT_OUT_OF_SCOPE';
    state = engineToPolicyState(engine);
    fallback = Object.freeze({ reason, targetEngine: engine, circuit });
  }
  // 5. failure == null -> engine: 'jev', state: 'JEV_READY', reason: null
  else if (failure == null) {
    engine = 'jev';
    state = 'JEV_READY';
    reason = null;
    retryable = false;
    retry = null;
    fallback = null;
  }
  // 6. failure is retryable and attempts < maxAttempts and circuit !== 'open'
  else if (
    RETRYABLE_FAILURES.has(failure) &&
    attempts < maxAttempts &&
    circuit !== 'open'
  ) {
    engine = 'jev';
    state = 'JEV_TRANSIENT_FAILURE';
    reason = failure;
    retryable = true;
    retry = Object.freeze({ allowed: true, attempt: attempts + 1, maxAttempts });
    fallback = null;
  }
  // 7. Otherwise -> fallback. target = escalated declared engine
  else {
    engine = resolveTargetEngine(declared, input);
    reason = failure;
    retryable = failure !== null && RETRYABLE_FAILURES.has(failure);
    retry = null;
    state = engineToState(engine, circuit);
    fallback = Object.freeze({ reason, targetEngine: engine, circuit });
  }

  let solverInvocation;
  if (input.kind === 'browser-step' || input.kind === 'query') {
    solverInvocation = 'not-applicable';
  } else if (
    !input.captchaKind ||
    input.captchaKind === 'recaptcha_v3' ||
    input.captchaKind === 'unknown' ||
    (input.captchaKind === 'turnstile' && input.interactive === true)
  ) {
    solverInvocation = 'forbidden';
  } else {
    solverInvocation = 'allowed';
  }

  let humanRequired =
    engine === 'human' ||
    input.irreversible === true ||
    (input.kind !== 'query' && input.captchaKind === 'turnstile' && input.interactive === true) ||
    input.captchaKind === 'tiktok';

  let riskCause = null;
  if (input.irreversible === true) {
    riskCause = 'irreversible';
  } else if (
    input.kind !== 'query' &&
    input.captchaKind === 'turnstile' &&
    input.interactive === true
  ) {
    riskCause = 'turnstile-interactive';
  } else if (input.captchaKind === 'tiktok') {
    riskCause = 'tiktok-hitl';
  }

  // TikTok/HITL clamp: escalate non-human routes to human
  if (input.captchaKind === 'tiktok') {
    solverInvocation = 'forbidden';
    if (input.fallbackPolicy === 'abort' || engine === 'blocked') {
      // Terminal abort semantics: stays blocked
      engine = 'blocked';
      state = 'BLOCKED';
      if (reason === null) {
        reason = 'POLICY_CAPTCHA_HUMAN_REQUIRED';
      }
      fallback = Object.freeze({ reason, targetEngine: engine, circuit });
      retryable = false;
      retry = null;
    } else if (engine === 'human' && input.fallbackPolicy === 'human') {
      // If the advisory already routes human by declared policy, leave it untouched
    } else {
      engine = 'human';
      state = 'HUMAN_REQUIRED';
      reason = 'POLICY_CAPTCHA_HUMAN_REQUIRED';
      retryable = false;
      retry = null;
      fallback = Object.freeze({ reason, targetEngine: engine, circuit });
    }
  } else if (solverKindMap !== undefined && solverKindMap !== null && proposedSolverId !== null) {
    // Cross-kind escalation (opt-in via solverKindMap)
    if (input.captchaKind && input.captchaKind !== 'unknown') {
      const allowedSolvers = solverKindMap[input.captchaKind];
      const isMatch = Array.isArray(allowedSolvers) && allowedSolvers.includes(proposedSolverId);
      if (!isMatch) {
        if (input.fallbackPolicy === 'abort' || engine === 'blocked') {
          // Terminal abort semantics: stays blocked
          engine = 'blocked';
          state = 'BLOCKED';
          humanRequired = true;
          solverInvocation = 'forbidden';
          if (reason === null) {
            reason = 'SOLVER_KIND_MISMATCH';
          }
          fallback = Object.freeze({ reason, targetEngine: engine, circuit });
          retryable = false;
          retry = null;
        } else {
          engine = 'human';
          state = 'HUMAN_REQUIRED';
          reason = 'SOLVER_KIND_MISMATCH';
          humanRequired = true;
          solverInvocation = 'forbidden';
          retryable = false;
          retry = null;
          fallback = Object.freeze({ reason, targetEngine: engine, circuit });
        }
      }
    }
  }

  const requiresFreshSnapshot = input.kind === 'browser-step' && ['jev', 'normal-agent', 'deterministic'].includes(engine);

  const inputForDigest = {};
  for (const [k, v] of Object.entries(input)) {
    if (k !== 'now' && v !== undefined) {
      const cleaned = stripUndefinedRecursively(v);
      if (cleaned !== undefined) {
        inputForDigest[k] = cleaned;
      }
    }
  }
  const inputDigest = digestCanonical(inputForDigest, JEV_FALLBACK_SCHEMA);

  return Object.freeze({
    schema: JEV_FALLBACK_SCHEMA,
    kind: input.kind,
    state,
    engine,
    reason,
    retryable,
    attempts,
    maxAttempts,
    circuit,
    retry,
    fallback,
    downstreamRoute: engine,
    jevUsed: engine === 'jev',
    requiresFreshSnapshot,
    policy: Object.freeze({
      humanRequired,
      solverInvocation,
      riskCause,
    }),
    advisoryOnly: true,
    inputDigest,
    createdAt,
  });
}

export function guardAction(input) {
  if (!isPlainObject(input)) {
    failInput('guardAction input must be a plain object', 'INPUT_NOT_OBJECT');
  }

  for (const k of Object.keys(input)) {
    if (!GUARD_ACCEPTED_KEYS.has(k)) {
      failInput(`Unrecognized key '${k}' in guardAction input`, 'UNRECOGNIZED_KEY', { key: k });
    }
  }

  if (!isPlainObject(input.decision)) {
    failInput('decision must be a plain object', 'DECISION_INVALID');
  }
  if (!DECISION_ENGINES.includes(input.decision.engine)) {
    failInput(`decision.engine must be one of: ${DECISION_ENGINES.join(', ')}`, 'ENGINE_INVALID');
  }
  if (!ENGINE_STATES.includes(input.decision.state)) {
    failInput('decision.state must be one of ENGINE_STATES', 'DECISION_INVALID');
  }
  const validEnginesByState = {
    JEV_READY: ['jev'],
    JEV_TRANSIENT_FAILURE: ['jev'],
    JEV_CIRCUIT_OPEN: ['normal-agent', 'deterministic'],
    FALLBACK_NORMAL_AGENT: ['normal-agent'],
    FALLBACK_DETERMINISTIC: ['deterministic'],
    HUMAN_REQUIRED: ['human'],
    BLOCKED: ['blocked'],
  };
  const validEngines = validEnginesByState[input.decision.state];
  if (!validEngines || !validEngines.includes(input.decision.engine)) {
    failInput(
      `decision.state '${input.decision.state}' is incompatible with decision.engine '${input.decision.engine}'`,
      'DECISION_INVALID',
    );
  }

  const validSolverInvocations = ['allowed', 'forbidden', 'not-applicable'];
  if (
    !isPlainObject(input.decision.policy) ||
    typeof input.decision.policy.humanRequired !== 'boolean' ||
    !validSolverInvocations.includes(input.decision.policy.solverInvocation)
  ) {
    failInput(
      'decision.policy must be a plain object with humanRequired boolean and solverInvocation in allowed|forbidden|not-applicable',
      'DECISION_INVALID',
    );
  }

  if (input.decision.reason !== null && input.decision.reason !== undefined && typeof input.decision.reason !== 'string') {
    failInput('decision.reason must be null or a string', 'REASON_INVALID');
  }

  if (input.permit !== undefined && input.permit !== null) {
    if (!isPlainObject(input.permit)) {
      failInput('permit must be a plain object', 'PERMIT_INVALID');
    }
    if (typeof input.permit.allowed !== 'boolean') {
      failInput('permit.allowed must be a boolean', 'PERMIT_INVALID');
    }
    if (input.permit.permitId !== undefined && input.permit.permitId !== null && typeof input.permit.permitId !== 'string') {
      failInput('permit.permitId must be a string or null', 'PERMIT_INVALID');
    }
  }

  if (input.snapshot !== undefined && input.snapshot !== null) {
    if (!isPlainObject(input.snapshot)) {
      failInput('snapshot must be a plain object', 'SNAPSHOT_INVALID');
    }
    if (
      typeof input.snapshot.expectedDigest !== 'string' ||
      typeof input.snapshot.observedDigest !== 'string' ||
      !SNAPSHOT_DIGEST_PATTERN.test(input.snapshot.expectedDigest) ||
      !SNAPSHOT_DIGEST_PATTERN.test(input.snapshot.observedDigest)
    ) {
      failInput('snapshot digests must match sha256: followed by 64 hex characters', 'SNAPSHOT_INVALID');
    }
  }

  if (input.irreversible !== undefined && typeof input.irreversible !== 'boolean') {
    failInput('irreversible must be a boolean', 'IRREVERSIBLE_INVALID');
  }

  if (input.interactive !== undefined && typeof input.interactive !== 'boolean') {
    failInput('interactive must be a boolean', 'INTERACTIVE_INVALID');
  }

  if (input.invokesSolver !== undefined && typeof input.invokesSolver !== 'boolean') {
    failInput('invokesSolver must be a boolean', 'INVOKES_SOLVER_INVALID');
  }

  if (input.captchaKind !== undefined && input.captchaKind !== null) {
    if (typeof input.captchaKind !== 'string' || !CAPTCHA_KINDS.has(input.captchaKind)) {
      failInput('captchaKind is invalid', 'CAPTCHA_KIND_INVALID');
    }
  }

  if (input.operation !== undefined && input.operation !== null && typeof input.operation !== 'string') {
    failInput('operation must be null or a string', 'OPERATION_INVALID');
  }

  const { decision, operation } = input;
  let allowed;
  let action;
  let reason;
  let zeroBrowserAction;

  // 1. decision.engine === 'human'
  if (decision.engine === 'human') {
    allowed = false;
    action = 'human';
    reason = decision.reason ?? null;
    zeroBrowserAction = true;
  }
  // 2. decision.engine === 'blocked'
  else if (decision.engine === 'blocked') {
    allowed = false;
    action = 'blocked';
    reason = decision.reason ?? null;
    zeroBrowserAction = true;
  }
  // 3. decision.state === 'JEV_TRANSIENT_FAILURE'
  else if (decision.state === 'JEV_TRANSIENT_FAILURE') {
    allowed = false;
    action = 'blocked';
    reason = decision.reason ?? null;
    zeroBrowserAction = true;
  }
  // 4. permit provided and permit.allowed === false
  else if (input.permit && input.permit.allowed === false) {
    allowed = false;
    action = 'blocked';
    reason = 'PERMIT_DENIED';
    zeroBrowserAction = true;
  }
  // 5. invokesSolver === true and captchaKind === 'recaptcha_v3'
  else if (input.invokesSolver === true && input.captchaKind === 'recaptcha_v3') {
    allowed = false;
    action = 'blocked';
    reason = 'POLICY_CAPTCHA_V3_NO_SOLVE';
    zeroBrowserAction = true;
  }
  // 6. invokesSolver === true and (captchaKind == null || captchaKind === 'unknown')
  else if (input.invokesSolver === true && (input.captchaKind == null || input.captchaKind === 'unknown')) {
    allowed = false;
    action = 'human';
    reason = 'POLICY_CAPTCHA_HUMAN_REQUIRED';
    zeroBrowserAction = true;
  }
  // invokesSolver === true and captchaKind === 'tiktok'
  else if (input.invokesSolver === true && input.captchaKind === 'tiktok') {
    allowed = false;
    action = 'human';
    reason = 'POLICY_CAPTCHA_HUMAN_REQUIRED';
    zeroBrowserAction = true;
  }
  // 7. invokesSolver === true and captchaKind === 'turnstile' and interactive !== false
  else if (input.invokesSolver === true && input.captchaKind === 'turnstile' && input.interactive !== false) {
    allowed = false;
    action = 'human';
    reason = 'POLICY_CAPTCHA_HUMAN_REQUIRED';
    zeroBrowserAction = true;
  }
  // 8. invokesSolver === true and decision.policy.solverInvocation === 'forbidden'
  else if (input.invokesSolver === true && decision.policy.solverInvocation === 'forbidden') {
    allowed = false;
    action = 'blocked';
    reason = 'POLICY_CAPTCHA_V3_NO_SOLVE';
    zeroBrowserAction = true;
  }
  // 9. invokesSolver === true and decision.policy.solverInvocation !== 'allowed'
  else if (input.invokesSolver === true && decision.policy.solverInvocation !== 'allowed') {
    allowed = false;
    action = 'human';
    reason = 'POLICY_CAPTCHA_HUMAN_REQUIRED';
    zeroBrowserAction = true;
  }
  // 10. decision.policy.humanRequired === true
  else if (decision.policy.humanRequired === true) {
    allowed = false;
    action = 'human';
    if (typeof decision.reason === 'string') {
      reason = decision.reason;
    } else if (decision.policy.riskCause === 'irreversible') {
      reason = 'POLICY_IRREVERSIBLE_ACTION';
    } else if (decision.policy.riskCause === 'turnstile-interactive') {
      reason = 'POLICY_CAPTCHA_HUMAN_REQUIRED';
    } else if (decision.policy.riskCause === 'tiktok-hitl' || decision.policy.riskCause === 'tiktok') {
      reason = 'POLICY_CAPTCHA_HUMAN_REQUIRED';
    } else if (input.irreversible === true) {
      reason = 'POLICY_IRREVERSIBLE_ACTION';
    } else if (
      input.captchaKind === 'tiktok' ||
      (input.captchaKind === 'turnstile' && input.interactive !== false) ||
      decision.policy.solverInvocation === 'forbidden'
    ) {
      reason = 'POLICY_CAPTCHA_HUMAN_REQUIRED';
    } else {
      reason = null;
    }
    zeroBrowserAction = true;
  }
  // 11. irreversible === true
  else if (input.irreversible === true) {
    allowed = false;
    action = 'human';
    reason = 'POLICY_IRREVERSIBLE_ACTION';
    zeroBrowserAction = true;
  }
  // 11. operation provided and not in LOW_RISK_OPERATIONS and not in CONTROL_OPERATIONS
  else if (operation != null && !LOW_RISK_OPERATIONS.includes(operation) && !CONTROL_OPERATIONS.includes(operation)) {
    allowed = false;
    action = 'human';
    reason = 'OPERATION_CLASS_NOT_PERMITTED';
    zeroBrowserAction = true;
  }
  // 12. operation in CONTROL_OPERATIONS
  else if (operation != null && CONTROL_OPERATIONS.includes(operation)) {
    allowed = true;
    action = 'no-command';
    reason = null;
    zeroBrowserAction = true;
  }
  // 13. no operation class and no solver invocation: nothing identifiable to authorize
  else if (operation == null && input.invokesSolver !== true) {
    allowed = false;
    action = 'human';
    reason = 'OPERATION_CLASS_NOT_PERMITTED';
    zeroBrowserAction = true;
  }
  // the guard's current context says the page has an interactive Turnstile, and we are about to authorize a
  // browser action: refuse with a human, zero browser action
  else if (
    operation != null &&
    LOW_RISK_OPERATIONS.includes(operation) &&
    input.captchaKind === 'turnstile' &&
    input.interactive !== false
  ) {
    allowed = false;
    action = 'human';
    reason = 'POLICY_CAPTCHA_HUMAN_REQUIRED';
    zeroBrowserAction = true;
  }
  // 14. operation in LOW_RISK_OPERATIONS and decision.engine in [jev, normal-agent, deterministic] and (snapshot missing or expectedDigest !== observedDigest)
  else if (
    operation != null &&
    LOW_RISK_OPERATIONS.includes(operation) &&
    ['jev', 'normal-agent', 'deterministic'].includes(decision.engine) &&
    (!input.snapshot || input.snapshot.expectedDigest !== input.snapshot.observedDigest)
  ) {
    allowed = false;
    action = 're-observe';
    reason = 'STALE_SNAPSHOT';
    zeroBrowserAction = true;
  }
  // 15. Otherwise
  else {
    allowed = true;
    action = 'execute';
    reason = null;
    zeroBrowserAction = false;
  }

  return Object.freeze({
    schema: JEV_GUARD_SCHEMA,
    allowed,
    action,
    reason,
    zeroBrowserAction,
    completionClaim: false,
    requiresPostconditionVerify: action === 'execute',
    advisoryOnly: true,
  });
}

function sanitizeDetail(detail) {
  if (detail === undefined) return undefined;
  let copy;
  try {
    if (typeof detail === 'string') {
      copy = detail;
    } else if (Array.isArray(detail)) {
      copy = Object.freeze([...detail]);
    } else if (isPlainObject(detail)) {
      copy = Object.freeze({ ...detail });
    } else if (detail instanceof Map) {
      copy = Object.freeze(Object.fromEntries(detail));
    } else if (detail instanceof Set) {
      copy = Object.freeze([...detail]);
    } else if (typeof detail === 'object' && detail !== null) {
      copy = Object.freeze({ ...detail });
    } else {
      copy = Object.freeze(detail);
    }
  } catch {
    return Object.freeze({ redacted: true });
  }

  const scan = scanForbiddenReceiptFields(copy);
  if (!scan.clean) {
    return Object.freeze({ redacted: true });
  }
  return copy;
}

export function evaluateStopTriggers(input) {
  if (!isPlainObject(input)) {
    failInput('evaluateStopTriggers input must be a plain object', 'INPUT_NOT_OBJECT');
  }

  for (const k of Object.keys(input)) {
    if (!STOP_ACCEPTED_KEYS.has(k)) {
      failInput(`Unrecognized key '${k}' in evaluateStopTriggers input`, 'UNRECOGNIZED_KEY', { key: k });
    }
  }

  if (!Array.isArray(input.events)) {
    failInput('events must be an array', 'EVENTS_INVALID');
  }

  for (const ev of input.events) {
    if (!isPlainObject(ev)) {
      failInput('each event must be a plain object with string code', 'EVENT_INVALID');
    }
    let code;
    try {
      code = ev.code;
    } catch {
      failInput('each event must be a plain object with string code', 'EVENT_INVALID');
    }
    if (typeof code !== 'string') {
      failInput('each event must be a plain object with string code', 'EVENT_INVALID');
    }
  }

  if (input.thresholds !== undefined && input.thresholds !== null) {
    if (!isPlainObject(input.thresholds)) {
      failInput('thresholds must be a plain object', 'THRESHOLDS_INVALID');
    }
    for (const k of Object.keys(input.thresholds)) {
      if (k !== 'completionRegressionPoints') {
        failInput(`Unrecognized threshold key '${k}'`, 'THRESHOLDS_INVALID', { key: k });
      }
    }
    if (input.thresholds.completionRegressionPoints !== undefined) {
      const crp = input.thresholds.completionRegressionPoints;
      if (typeof crp !== 'number' || !Number.isFinite(crp) || crp <= 0 || crp > 100) {
        failInput('completionRegressionPoints must be a finite number in (0, 100]', 'THRESHOLDS_INVALID');
      }
    }
  }

  let evaluatedAt;
  if (input.now !== undefined) {
    if (typeof input.now !== 'function') {
      failInput('now must be a function', 'NOW_INVALID');
    }
    evaluatedAt = input.now();
    if (typeof evaluatedAt !== 'string' || !NOW_UTC_PATTERN.test(evaluatedAt)) {
      failInput('now() return value must match ISO-8601 UTC pattern', 'NOW_INVALID');
    }
  } else {
    evaluatedAt = new Date().toISOString();
  }

  const triggersMap = new Map();
  const triggerDetails = new Map();
  const ignoredSet = new Set();
  let stop = false;
  const completionThreshold = input.thresholds?.completionRegressionPoints ?? 2;
  let consecutiveLatencyRegressions = 0;

  for (const event of input.events) {
    let code;
    let detail;
    try {
      code = event.code;
      detail = event.detail;
    } catch {
      const unreadableCode = typeof code === 'string' ? code : 'UNREADABLE_EVENT';
      const scan = scanForbiddenReceiptFields(unreadableCode);
      ignoredSet.add(scan.clean ? unreadableCode : '[redacted]');
      continue;
    }
    if (!STOP_TRIGGER_CODES.includes(code)) {
      const scan = scanForbiddenReceiptFields(code);
      const storedCode = scan.clean ? code : '[redacted]';
      ignoredSet.add(storedCode);
      continue;
    }

    if (
      code === 'UNAUTHORIZED_ACTION' ||
      code === 'STALE_TARGET_EXECUTION' ||
      code === 'V3_SOLVE_ATTEMPT' ||
      code === 'RESULT_AS_PERMIT' ||
      code === 'SECRET_IN_RECEIPT' ||
      code === 'SILENT_FALLBACK'
    ) {
      stop = true;
      if (!triggersMap.has(code)) {
        triggersMap.set(code, true);
        if (detail !== undefined) {
          triggerDetails.set(code, sanitizeDetail(detail));
        }
      }
    } else if (code === 'COMPLETION_WINDOW') {
      let baselineRate;
      let currentRate;
      try {
        if (detail != null) {
          baselineRate = detail.baselineRate;
          currentRate = detail.currentRate;
        }
      } catch {
        ignoredSet.add(code);
        continue;
      }

      const isWellFormed =
        detail != null &&
        typeof baselineRate === 'number' &&
        Number.isFinite(baselineRate) &&
        typeof currentRate === 'number' &&
        Number.isFinite(currentRate);

      if (!isWellFormed) {
        ignoredSet.add(code);
        continue;
      }

      if ((baselineRate - currentRate) > completionThreshold) {
        stop = true;
        if (!triggersMap.has(code)) {
          triggersMap.set(code, true);
          if (detail !== undefined) {
            triggerDetails.set(code, sanitizeDetail(detail));
          }
        }
      }
    } else if (code === 'LATENCY_WINDOW') {
      let p95Ms;
      let baselineP95Ms;
      try {
        if (detail != null) {
          p95Ms = detail.p95Ms;
          baselineP95Ms = detail.baselineP95Ms;
        }
      } catch {
        ignoredSet.add(code);
        continue;
      }

      const isWellFormed =
        detail != null &&
        typeof p95Ms === 'number' &&
        Number.isFinite(p95Ms) &&
        typeof baselineP95Ms === 'number' &&
        Number.isFinite(baselineP95Ms);

      if (!isWellFormed) {
        ignoredSet.add(code);
        continue;
      }

      if (p95Ms > baselineP95Ms) {
        consecutiveLatencyRegressions += 1;
        if (consecutiveLatencyRegressions >= 2) {
          stop = true;
          if (!triggersMap.has(code)) {
            triggersMap.set(code, true);
            if (detail !== undefined) {
              triggerDetails.set(code, sanitizeDetail(detail));
            }
          }
        }
      } else {
        consecutiveLatencyRegressions = 0;
      }
    }
  }

  const sortedCodes = Array.from(triggersMap.keys()).sort();
  const triggers = Object.freeze(sortedCodes.map((code) => {
    const detail = triggerDetails.get(code);
    const entry = { code };
    if (detail !== undefined) {
      entry.detail = detail;
    }
    return Object.freeze(entry);
  }));

  const ignored = Object.freeze(Array.from(ignoredSet).sort());

  return Object.freeze({
    schema: JEV_STOP_SCHEMA,
    stop,
    stopState: stop ? JEV_FALLBACK_STOP_STATE : null,
    triggers,
    ignored,
    evaluatedAt,
  });
}

export function scanForbiddenReceiptFields(value) {
  const findings = new Set();
  const stack = new Set();

  function walk(node, path, depth) {
    if (depth > 64) {
      findings.add(path);
      return;
    }
    try {
      if (typeof node === 'string') {
        if (isForbiddenStringValue(node)) {
          findings.add(path);
        }
        return;
      }
      if (!node || typeof node !== 'object') {
        return;
      }
      if (stack.has(node)) {
        return;
      }
      stack.add(node);

      try {
        if (
          typeof node.toJSON === 'function' &&
          !Array.isArray(node) &&
          !(node instanceof Map) &&
          !(node instanceof Set)
        ) {
          let serialized;
          try {
            serialized = node.toJSON();
          } catch {
            findings.add(path);
            return;
          }
          if (serialized !== node) {
            walk(serialized, path, depth + 1);
            return;
          }
        }

        if (Array.isArray(node)) {
          for (let i = 0; i < node.length; i += 1) {
            const childPath = `${path}[${i}]`;
            let item;
            try {
              item = node[i];
            } catch {
              findings.add(childPath);
              continue;
            }
            walk(item, childPath, depth + 1);
          }
        } else if (node instanceof Map) {
          let i = 0;
          for (const [k, v] of node.entries()) {
            if (typeof k === 'string') {
              const isSafeKey = SAFE_KEY_SEGMENT.test(k) && !isForbiddenStringValue(k);
              const segment = isSafeKey ? k : '[redacted]';
              const childPath = `${path}.${segment}`;
              if (FORBIDDEN_KEY.test(k) || isForbiddenStringValue(k)) {
                findings.add(childPath);
              }
              walk(v, childPath, depth + 1);
            } else {
              const entryPath = `${path}[${i}]`;
              walk(k, entryPath, depth + 1);
              walk(v, entryPath, depth + 1);
            }
            i += 1;
          }
        } else if (node instanceof Set) {
          let i = 0;
          for (const item of node) {
            walk(item, `${path}[${i}]`, depth + 1);
            i += 1;
          }
        } else {
          for (const key of Object.keys(node)) {
            const isSafeKey = SAFE_KEY_SEGMENT.test(key) && !isForbiddenStringValue(key);
            const segment = isSafeKey ? key : '[redacted]';
            const childPath = `${path}.${segment}`;
            if (FORBIDDEN_KEY.test(key) || isForbiddenStringValue(key)) {
              findings.add(childPath);
            }
            let childVal;
            try {
              childVal = node[key];
            } catch {
              findings.add(childPath);
              continue;
            }
            walk(childVal, childPath, depth + 1);
          }
        }
      } finally {
        stack.delete(node);
      }
    } catch {
      findings.add(path);
    }
  }

  walk(value, '$', 0);
  const sortedFindings = Object.freeze(Array.from(findings).sort());

  return Object.freeze({
    schema: JEV_SCAN_SCHEMA,
    clean: sortedFindings.length === 0,
    findings: sortedFindings,
  });
}
