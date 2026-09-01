import { AiCliError } from '../errors.mjs';
import {
  CLOSED_ROLES,
  computeCanonicalDigest,
  deepFreeze,
  isClosedRole,
  isPlainObject,
  isValidDigest,
} from './role-policy.mjs';
import {
  CLOSED_RISK_TIERS,
  SELECTION_RECEIPT_SCHEMA,
} from './constants.mjs';

export { SELECTION_RECEIPT_SCHEMA };

export const ALLOWED_RECEIPT_FIELDS = Object.freeze(new Set([
  'schema',
  'taskId',
  'dispatchId',
  'role',
  'riskTier',
  'rolePolicyRevision',
  'modelBindingRevision',
  'bindingRevision',
  'provider',
  'agent',
  'requestedModel',
  'actualModel',
  'effort',
  'variant',
  'fallbackFrom',
  'fallbackDecision',
  'contributorLineageDigest',
  'sessionFreshness',
  'decision',
  'evaluatedAt',
  'receiptDigest',
]));

const CLOSED_RISK_TIERS_SET = new Set(CLOSED_RISK_TIERS);
const ALLOWED_SESSION_FRESHNESS = new Set(['fresh', 'reused', 'not-required', 'unspecified', null]);
const ALLOWED_DECISIONS = new Set(['eligible', 'denied']);

const FORBIDDEN_RECEIPT_KEYS = /^(credential|credentials|secret|token|password|apikey|api_key|auth|cookie|jwt|private_key|privateKey|prompt|systemPrompt|template|machine|machineId|machine_id|host|hostname|ip|endpoint|session|sessionId|session_id|env|process|transcript|transcripts|stdout|stderr|quota|rateLimit|limits)$/i;
const FORBIDDEN_PATH_PATTERN = /(?:^|[\s("'`])(?:\/|~\/|[a-zA-Z]:[\\/]|file:\/\/|https?:\/\/)/i;
const FORBIDDEN_SECRET_VALUE_PATTERN = /(bearer\s+[A-Za-z0-9_.-]+|basic\s+[A-Za-z0-9+/=]+|(?:secret|token|credential|apikey)[=:][^\s]+|secret-token|token-bearer|sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{15,}|-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----)/i;

export function computeSelectionReceiptDigest(receipt) {
  if (!isPlainObject(receipt)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Receipt must be a non-null object to compute digest', { exitCode: 2 });
  }
  const { receiptDigest: _rd, ...stripped } = receipt;
  return computeCanonicalDigest(stripped);
}

function scanReceiptForbiddenMaterial(value, path = 'receipt') {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    if (FORBIDDEN_PATH_PATTERN.test(value)) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        `Selection receipt contains prohibited file system path material at ${path}`,
        { exitCode: 2 },
      );
    }
    if (FORBIDDEN_SECRET_VALUE_PATTERN.test(value)) {
      throw new AiCliError(
        'POLICY_DENIED',
        `Selection receipt contains prohibited secret/token material at ${path}`,
        { exitCode: 2 },
      );
    }
    if (value.includes('{{') && value.includes('}}')) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        `Selection receipt contains prohibited prompt template material at ${path}`,
        { exitCode: 2 },
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanReceiptForbiddenMaterial(item, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, val] of Object.entries(value)) {
      if (FORBIDDEN_RECEIPT_KEYS.test(key)) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          `Selection receipt contains prohibited non-portable key at ${path}.${key}`,
          { exitCode: 2 },
        );
      }
      scanReceiptForbiddenMaterial(val, `${path}.${key}`);
    }
  }
}

export function validateSelectionReceipt(receipt) {
  if (!isPlainObject(receipt)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Selection receipt must be a non-null object', { exitCode: 2 });
  }

  // 1. Check strict allowlist (additionalProperties: false)
  const unknownFields = Object.keys(receipt).filter((key) => !ALLOWED_RECEIPT_FIELDS.has(key));
  if (unknownFields.length > 0) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `Selection receipt contains unauthorized fields: ${unknownFields.sort().join(', ')}`,
      { exitCode: 2 },
    );
  }

  // Check required fields
  for (const field of ALLOWED_RECEIPT_FIELDS) {
    if (!(field in receipt)) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        `Selection receipt missing required field: ${field}`,
        { exitCode: 2 },
      );
    }
  }

  // 2. Schema check
  if (receipt.schema !== SELECTION_RECEIPT_SCHEMA) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `Unsupported selection receipt schema; expected "${SELECTION_RECEIPT_SCHEMA}"`,
      { exitCode: 2 },
    );
  }

  // 3. taskId and dispatchId
  if (typeof receipt.taskId !== 'string' || !receipt.taskId.startsWith('task_') || receipt.taskId.length <= 5) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'receipt.taskId must be a string starting with task_', { exitCode: 2 });
  }
  if (typeof receipt.dispatchId !== 'string' || !receipt.dispatchId.startsWith('disp_') || receipt.dispatchId.length <= 5) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'receipt.dispatchId must be a string starting with disp_', { exitCode: 2 });
  }

  // 4. Role
  if (receipt.role !== null && !isClosedRole(receipt.role)) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `receipt.role must be null or one of ${CLOSED_ROLES.join(', ')}`,
      { exitCode: 2 },
    );
  }

  // 5. RiskTier
  if (receipt.riskTier !== null && (typeof receipt.riskTier !== 'string' || !CLOSED_RISK_TIERS_SET.has(receipt.riskTier))) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `receipt.riskTier must be null or one of ${CLOSED_RISK_TIERS.join(', ')}`,
      { exitCode: 2 },
    );
  }

  // 6. Revisions (rolePolicyRevision, modelBindingRevision, bindingRevision)
  for (const revField of ['rolePolicyRevision', 'modelBindingRevision', 'bindingRevision']) {
    const val = receipt[revField];
    if (val !== null && val !== undefined) {
      if (
        !isValidDigest(val)
        && !(typeof val === 'number' && Number.isInteger(val) && val >= 1)
        && !(typeof val === 'string' && /^[1-9][0-9]{0,9}$/.test(val))
      ) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          `receipt.${revField} must be null, a positive revision, or a sha256 digest`,
          { exitCode: 2 },
        );
      }
    }
  }

  // 7. Provider, Agent, requestedModel, effort, variant, fallbackFrom, fallbackDecision
  for (const strField of ['provider', 'agent', 'requestedModel', 'effort', 'variant', 'fallbackFrom', 'fallbackDecision']) {
    const val = receipt[strField];
    if (val !== null && val !== undefined) {
      if (typeof val !== 'string' || val.trim().length === 0) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          `receipt.${strField} must be null or non-empty string`,
          { exitCode: 2 },
        );
      }
    }
  }

  // 8. actualModel (required non-empty string)
  if (typeof receipt.actualModel !== 'string' || receipt.actualModel.trim().length === 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'receipt.actualModel must be a non-empty string', { exitCode: 2 });
  }

  // 9. contributorLineageDigest
  if (receipt.contributorLineageDigest !== null && receipt.contributorLineageDigest !== undefined) {
    if (!isValidDigest(receipt.contributorLineageDigest)) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        'receipt.contributorLineageDigest must be null or a valid sha256: digest',
        { exitCode: 2 },
      );
    }
  }

  // 10. sessionFreshness
  if (!ALLOWED_SESSION_FRESHNESS.has(receipt.sessionFreshness)) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'receipt.sessionFreshness must be null, fresh, reused, not-required, or unspecified',
      { exitCode: 2 },
    );
  }

  // 11. decision
  if (!ALLOWED_DECISIONS.has(receipt.decision)) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'receipt.decision must be "eligible" or "denied"',
      { exitCode: 2 },
    );
  }
  if (receipt.decision === 'denied') {
    if (receipt.provider !== null || receipt.actualModel !== 'indeterminate') {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        'denied selection receipts must not claim a provider or determinate model',
        { exitCode: 2 },
      );
    }
  } else if (typeof receipt.provider !== 'string' || receipt.provider.trim().length === 0) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'eligible selection receipts require a resolved provider',
      { exitCode: 2 },
    );
  }

  // 12. evaluatedAt
  if (typeof receipt.evaluatedAt !== 'string' || receipt.evaluatedAt.trim().length === 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'receipt.evaluatedAt must be a non-empty ISO 8601 string', { exitCode: 2 });
  }
  const evalParsed = Date.parse(receipt.evaluatedAt);
  if (!Number.isFinite(evalParsed)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'receipt.evaluatedAt must be a valid date string', { exitCode: 2 });
  }

  // 13. receiptDigest
  if (!isValidDigest(receipt.receiptDigest)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'receipt.receiptDigest must be a valid sha256: digest', { exitCode: 2 });
  }

  // 14. Scan forbidden material
  scanReceiptForbiddenMaterial(receipt, 'receipt');

  // 15. Verify digest match
  const expectedDigest = computeSelectionReceiptDigest(receipt);
  if (receipt.receiptDigest !== expectedDigest) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `receiptDigest mismatch: computed ${expectedDigest} != stored ${receipt.receiptDigest}`,
      { exitCode: 2 },
    );
  }

  return deepFreeze(structuredClone(receipt));
}

export function buildSelectionReceipt(input = {}) {
  if (!isPlainObject(input)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Input to buildSelectionReceipt must be an object', { exitCode: 2 });
  }

  const role = input.role !== undefined ? input.role : null;
  const riskTier = input.riskTier !== undefined ? input.riskTier : null;
  const rolePolicyRevision = input.rolePolicyRevision !== undefined ? input.rolePolicyRevision : null;
  const modelBindingRevision = input.modelBindingRevision !== undefined ? input.modelBindingRevision : null;
  const bindingRevision = input.bindingRevision !== undefined ? input.bindingRevision : null;
  const decision = input.decision === 'denied' ? 'denied' : (input.decision === 'eligible' ? 'eligible' : (input.eligible === false ? 'denied' : 'eligible'));
  const provider = decision === 'denied' ? null : (input.provider !== undefined ? input.provider : null);
  const agent = typeof input.agent === 'string'
    ? input.agent
    : (input.agent?.id ?? input.agent?.name ?? null);
  const requestedModel = input.requestedModel !== undefined ? input.requestedModel : null;
  const actualModel = decision === 'denied'
    ? 'indeterminate'
    : (typeof input.actualModel === 'string' && input.actualModel.trim().length > 0
        ? input.actualModel
        : (input.model ?? 'indeterminate'));
  const effort = input.effort !== undefined ? input.effort : null;
  const variant = input.variant !== undefined ? input.variant : null;
  const fallbackFrom = input.fallbackFrom !== undefined ? input.fallbackFrom : null;
  const fallbackDecision = input.fallbackDecision !== undefined
    ? input.fallbackDecision
    : (input.isFallback || input.fallback ? (decision === 'eligible' ? 'fallback-authorized' : 'denied') : 'none');
  const contributorLineageDigest = input.contributorLineageDigest !== undefined ? input.contributorLineageDigest : null;
  const sessionFreshness = input.sessionFreshness !== undefined
    ? (typeof input.sessionFreshness === 'boolean'
        ? (input.sessionFreshness ? 'fresh' : 'reused')
        : input.sessionFreshness)
    : 'unspecified';
  const evaluatedAt = typeof input.evaluatedAt === 'string'
    ? input.evaluatedAt
    : new Date(typeof input.now === 'number' ? input.now : Date.now()).toISOString();

  const draft = {
    schema: SELECTION_RECEIPT_SCHEMA,
    taskId: input.taskId,
    dispatchId: input.dispatchId,
    role,
    riskTier,
    rolePolicyRevision,
    modelBindingRevision,
    bindingRevision,
    provider,
    agent,
    requestedModel,
    actualModel,
    effort,
    variant,
    fallbackFrom,
    fallbackDecision,
    contributorLineageDigest,
    sessionFreshness,
    decision,
    evaluatedAt,
  };

  const receiptDigest = computeCanonicalDigest(draft);
  const fullReceipt = {
    ...draft,
    receiptDigest,
  };

  return validateSelectionReceipt(fullReceipt);
}
