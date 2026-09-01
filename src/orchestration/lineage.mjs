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
  DISPATCH_ADMISSION_CODES,
  ID_PREFIXES,
} from './constants.mjs';
import { validateSelectionReceipt } from './selection-receipt.mjs';

export const LINEAGE_INDEX_SCHEMA = 'webmcp-ai-lineage-index/1';
export const LINEAGE_RECORD_SCHEMA = 'webmcp-ai-lineage-record/1';
export const LINEAGE_INDEX_FILENAME = 'lineage-index.json';
export const MAX_LINEAGE_RECORDS = 1024;
export const MAX_LINEAGE_STRING_LENGTH = 256;

const CLOSED_RISK_TIERS_SET = new Set(CLOSED_RISK_TIERS);
const ALLOWED_SESSION_FRESHNESS = new Set(['fresh', 'reused', 'not-required', 'unspecified', null]);
const ALLOWED_DECISIONS = new Set(['eligible', 'denied']);

export const ALLOWED_LINEAGE_RECORD_FIELDS = Object.freeze(new Set([
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
  'model',
  'bindingId',
  'effort',
  'variant',
  'sessionFreshness',
  'decision',
  'contributorDigest',
  'receiptDigest',
  'evaluatedAt',
]));

const FORBIDDEN_LINEAGE_KEYS = /^(credential|credentials|secret|token|password|apikey|api_key|auth|cookie|jwt|private_key|privateKey|prompt|systemPrompt|template|machine|machineId|machine_id|host|hostname|ip|endpoint|session|sessionId|session_id|env|process|transcript|transcripts|stdout|stderr|quota|rateLimit|limits)$/i;
const FORBIDDEN_PATH_PATTERN = /(?:^|[\s("'`])(?:\/|~\/|[a-zA-Z]:[\\/]|file:\/\/|https?:\/\/)/i;
const FORBIDDEN_SECRET_VALUE_PATTERN = /(bearer\s+[A-Za-z0-9_.-]+|basic\s+[A-Za-z0-9+/=]+|(?:secret|token|credential|apikey)[=:][^\s]+|secret-token|token-bearer|sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{15,}|-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----)/i;

function scanLineageForbiddenMaterial(value, path = 'lineage') {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    if (FORBIDDEN_PATH_PATTERN.test(value)) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        `Lineage record contains prohibited file system path material at ${path}`,
        { exitCode: 2 },
      );
    }
    if (FORBIDDEN_SECRET_VALUE_PATTERN.test(value)) {
      throw new AiCliError(
        'POLICY_DENIED',
        `Lineage record contains prohibited secret/token material at ${path}`,
        { exitCode: 2 },
      );
    }
    if (value.includes('{{') && value.includes('}}')) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        `Lineage record contains prohibited prompt template material at ${path}`,
        { exitCode: 2 },
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanLineageForbiddenMaterial(item, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, val] of Object.entries(value)) {
      if (FORBIDDEN_LINEAGE_KEYS.test(key)) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          `Lineage record contains prohibited non-portable key at ${path}.${key}`,
          { exitCode: 2 },
        );
      }
      scanLineageForbiddenMaterial(val, `${path}.${key}`);
    }
  }
}

/**
 * Pure contributor digest calculation. Extracts bounded, safe contributor facts
 * and produces a deterministic lowercase sha256: digest.
 */
export function computeContributorDigest(facts = {}) {
  if (!isPlainObject(facts)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Contributor facts must be an object', { exitCode: 2 });
  }
  const normalized = {
    role: typeof facts.role === 'string' ? facts.role : null,
    provider: typeof facts.provider === 'string' ? facts.provider : null,
    model: typeof facts.model === 'string' ? facts.model : (typeof facts.actualModel === 'string' ? facts.actualModel : null),
    agent: typeof facts.agent === 'string' ? facts.agent : (typeof facts.agentId === 'string' ? facts.agentId : null),
    bindingId: typeof facts.bindingId === 'string' ? facts.bindingId : null,
    ...(typeof facts.executableIdentityDigest === 'string' ? { executableIdentityDigest: facts.executableIdentityDigest } : {}),
  };
  return computeCanonicalDigest(normalized);
}

/**
 * Validates a single LineageRecord.
 */
export function validateLineageRecord(record) {
  if (!isPlainObject(record)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Lineage record must be a non-null object', { exitCode: 2 });
  }

  const unknownFields = Object.keys(record).filter((key) => !ALLOWED_LINEAGE_RECORD_FIELDS.has(key));
  if (unknownFields.length > 0) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `Lineage record contains unauthorized fields: ${unknownFields.sort().join(', ')}`,
      { exitCode: 2 },
    );
  }

  for (const field of ALLOWED_LINEAGE_RECORD_FIELDS) {
    if (!(field in record)) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        `Lineage record missing required field: ${field}`,
        { exitCode: 2 },
      );
    }
  }

  if (record.schema !== LINEAGE_RECORD_SCHEMA) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `Unsupported lineage record schema; expected "${LINEAGE_RECORD_SCHEMA}"`,
      { exitCode: 2 },
    );
  }

  if (typeof record.taskId !== 'string' || !record.taskId.startsWith(ID_PREFIXES.task) || record.taskId.length <= ID_PREFIXES.task.length) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `record.taskId must be a string starting with ${ID_PREFIXES.task}`, { exitCode: 2 });
  }
  if (typeof record.dispatchId !== 'string' || !record.dispatchId.startsWith(ID_PREFIXES.dispatch) || record.dispatchId.length <= ID_PREFIXES.dispatch.length) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `record.dispatchId must be a string starting with ${ID_PREFIXES.dispatch}`, { exitCode: 2 });
  }

  if (record.role !== null && !isClosedRole(record.role)) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `record.role must be null or one of ${CLOSED_ROLES.join(', ')}`,
      { exitCode: 2 },
    );
  }

  if (record.riskTier !== null && (typeof record.riskTier !== 'string' || !CLOSED_RISK_TIERS_SET.has(record.riskTier))) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `record.riskTier must be null or one of ${CLOSED_RISK_TIERS.join(', ')}`,
      { exitCode: 2 },
    );
  }

  for (const revField of ['rolePolicyRevision', 'modelBindingRevision', 'bindingRevision']) {
    const val = record[revField];
    if (val !== null && val !== undefined) {
      if (
        !isValidDigest(val)
        && !(typeof val === 'number' && Number.isInteger(val) && val >= 1)
        && !(typeof val === 'string' && /^[1-9][0-9]{0,9}$/.test(val))
      ) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          `record.${revField} must be null, a positive revision, or a sha256 digest`,
          { exitCode: 2 },
        );
      }
    }
  }

  for (const strField of ['provider', 'agent', 'requestedModel', 'bindingId', 'effort', 'variant']) {
    const val = record[strField];
    if (val !== null && val !== undefined) {
      if (typeof val !== 'string' || val.trim().length === 0 || val.length > MAX_LINEAGE_STRING_LENGTH) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          `record.${strField} must be null or non-empty string under ${MAX_LINEAGE_STRING_LENGTH} chars`,
          { exitCode: 2 },
        );
      }
    }
  }

  if (typeof record.model !== 'string' || record.model.trim().length === 0 || record.model.length > MAX_LINEAGE_STRING_LENGTH) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `record.model must be a non-empty string under ${MAX_LINEAGE_STRING_LENGTH} chars`,
      { exitCode: 2 },
    );
  }

  if (!ALLOWED_SESSION_FRESHNESS.has(record.sessionFreshness)) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'record.sessionFreshness must be null, fresh, reused, not-required, or unspecified',
      { exitCode: 2 },
    );
  }

  if (!ALLOWED_DECISIONS.has(record.decision)) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'record.decision must be "eligible" or "denied"',
      { exitCode: 2 },
    );
  }

  if (typeof record.evaluatedAt !== 'string' || record.evaluatedAt.trim().length === 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'record.evaluatedAt must be a non-empty ISO 8601 string', { exitCode: 2 });
  }
  const evalParsed = Date.parse(record.evaluatedAt);
  if (!Number.isFinite(evalParsed)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'record.evaluatedAt must be a valid date string', { exitCode: 2 });
  }

  if (!isValidDigest(record.receiptDigest)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'record.receiptDigest must be a valid sha256: digest', { exitCode: 2 });
  }

  if (!isValidDigest(record.contributorDigest)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'record.contributorDigest must be a valid sha256: digest', { exitCode: 2 });
  }

  scanLineageForbiddenMaterial(record, 'record');

  const expectedContributorDigest = computeContributorDigest({
    role: record.role,
    provider: record.provider,
    model: record.model,
    agent: record.agent,
    bindingId: record.bindingId,
  });
  if (record.contributorDigest !== expectedContributorDigest) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `contributorDigest mismatch: computed ${expectedContributorDigest} != stored ${record.contributorDigest}`,
      { exitCode: 2 },
    );
  }

  return deepFreeze(structuredClone(record));
}

/**
 * Builds a validated LineageRecord from a validated SelectionReceipt and extra trusted admission facts.
 */
export function buildLineageRecordFromReceipt(receipt, options = {}) {
  if (!isPlainObject(receipt)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Receipt must be an object', { exitCode: 2 });
  }

  const role = receipt.role !== undefined ? receipt.role : null;
  const riskTier = receipt.riskTier !== undefined ? receipt.riskTier : null;
  const rolePolicyRevision = receipt.rolePolicyRevision !== undefined ? receipt.rolePolicyRevision : null;
  const modelBindingRevision = receipt.modelBindingRevision !== undefined ? receipt.modelBindingRevision : null;
  const bindingRevision = receipt.bindingRevision !== undefined ? receipt.bindingRevision : null;
  const provider = receipt.provider !== undefined ? receipt.provider : null;
  const agent = receipt.agent !== undefined ? receipt.agent : null;
  const requestedModel = receipt.requestedModel !== undefined ? receipt.requestedModel : null;
  const model = receipt.actualModel ?? receipt.model ?? 'indeterminate';
  const bindingId = options.bindingId ?? null;
  const effort = receipt.effort !== undefined ? receipt.effort : null;
  const variant = receipt.variant !== undefined ? receipt.variant : null;
  const sessionFreshness = receipt.sessionFreshness !== undefined ? receipt.sessionFreshness : 'unspecified';
  const decision = receipt.decision === 'denied' ? 'denied' : 'eligible';
  const receiptDigest = receipt.receiptDigest;
  const evaluatedAt = receipt.evaluatedAt ?? new Date().toISOString();

  const contributorDigest = computeContributorDigest({
    role,
    provider,
    model,
    agent,
    bindingId,
  });

  const record = {
    schema: LINEAGE_RECORD_SCHEMA,
    taskId: receipt.taskId,
    dispatchId: receipt.dispatchId,
    role,
    riskTier,
    rolePolicyRevision,
    modelBindingRevision,
    bindingRevision,
    provider,
    agent,
    requestedModel,
    model,
    bindingId,
    effort,
    variant,
    sessionFreshness,
    decision,
    contributorDigest,
    receiptDigest,
    evaluatedAt,
  };

  return validateLineageRecord(record);
}

const ALLOWED_INDEX_FIELDS = Object.freeze(new Set([
  'schema',
  'records',
  'indexDigest',
  'updatedAt',
]));

export function computeLineageIndexDigest(indexDraft) {
  if (!isPlainObject(indexDraft)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Index draft must be an object', { exitCode: 2 });
  }
  const { indexDigest: _id, ...stripped } = indexDraft;
  return computeCanonicalDigest(stripped);
}

/**
 * Validates a LineageIndex object.
 */
export function validateLineageIndex(index) {
  if (!isPlainObject(index)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Lineage index must be an object', { exitCode: 2 });
  }

  const unknownFields = Object.keys(index).filter((k) => !ALLOWED_INDEX_FIELDS.has(k));
  if (unknownFields.length > 0) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `Lineage index has unknown fields: ${unknownFields.sort().join(', ')}`,
      { exitCode: 2 },
    );
  }

  if (index.schema !== LINEAGE_INDEX_SCHEMA) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `Unsupported lineage index schema; expected "${LINEAGE_INDEX_SCHEMA}"`,
      { exitCode: 2 },
    );
  }

  if (!Array.isArray(index.records)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Lineage index records must be an array', { exitCode: 2 });
  }

  if (index.records.length > MAX_LINEAGE_RECORDS) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `Lineage index records exceed max limit of ${MAX_LINEAGE_RECORDS}`,
      { exitCode: 2 },
    );
  }

  const seenDispatches = new Set();
  const validatedRecords = [];
  for (const rawRecord of index.records) {
    const record = validateLineageRecord(rawRecord);
    if (seenDispatches.has(record.dispatchId)) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        `Duplicate dispatchId ${record.dispatchId} in lineage index`,
        { exitCode: 2 },
      );
    }
    seenDispatches.add(record.dispatchId);
    validatedRecords.push(record);
  }

  if (typeof index.updatedAt !== 'string' || index.updatedAt.trim().length === 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Lineage index updatedAt must be a non-empty ISO 8601 string', { exitCode: 2 });
  }
  const updatedParsed = Date.parse(index.updatedAt);
  if (!Number.isFinite(updatedParsed)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Lineage index updatedAt must be a valid date string', { exitCode: 2 });
  }

  if (!isValidDigest(index.indexDigest)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Lineage index indexDigest must be a valid sha256: digest', { exitCode: 2 });
  }

  scanLineageForbiddenMaterial(index, 'lineageIndex');

  const expectedIndexDigest = computeLineageIndexDigest(index);
  if (index.indexDigest !== expectedIndexDigest) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `indexDigest mismatch: computed ${expectedIndexDigest} != stored ${index.indexDigest}`,
      { exitCode: 2 },
    );
  }

  return deepFreeze(structuredClone(index));
}

/**
 * Builds a LineageIndex from an array of validated LineageRecords.
 */
export function buildLineageIndex(records = [], { updatedAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(records)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'records must be an array', { exitCode: 2 });
  }

  if (records.length > MAX_LINEAGE_RECORDS) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `Lineage records exceed max limit of ${MAX_LINEAGE_RECORDS}`,
      { exitCode: 2 },
    );
  }

  const dedupedMap = new Map();
  for (const raw of records) {
    const record = validateLineageRecord(raw);
    const existing = dedupedMap.get(record.dispatchId);
    if (existing) {
      // If conflicting facts for same dispatchId, fail closed
      if (existing.receiptDigest !== record.receiptDigest || existing.contributorDigest !== record.contributorDigest) {
        throw new AiCliError(
          'ORCHESTRATION_INDETERMINATE',
          `Conflicting lineage records for dispatch ${record.dispatchId}`,
          { exitCode: 2 },
        );
      }
    } else {
      dedupedMap.set(record.dispatchId, record);
    }
  }

  if (dedupedMap.size > MAX_LINEAGE_RECORDS) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `Lineage records exceed max limit of ${MAX_LINEAGE_RECORDS}`,
      { exitCode: 2 },
    );
  }

  const recordList = Array.from(dedupedMap.values());
  const draft = {
    schema: LINEAGE_INDEX_SCHEMA,
    records: recordList,
    updatedAt,
  };

  const indexDigest = computeCanonicalDigest(draft);
  const fullIndex = {
    ...draft,
    indexDigest,
  };

  return validateLineageIndex(fullIndex);
}

/**
 * Merges two collections of lineage records deterministically.
 * Conflicting records for the same dispatchId throw ORCHESTRATION_INDETERMINATE.
 */
export function mergeLineageRecords(existingRecords = [], incomingRecords = []) {
  if (!Array.isArray(existingRecords) || !Array.isArray(incomingRecords)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Records must be arrays', { exitCode: 2 });
  }

  const map = new Map();

  for (const raw of existingRecords) {
    const rec = validateLineageRecord(raw);
    map.set(rec.dispatchId, rec);
  }

  for (const raw of incomingRecords) {
    const rec = validateLineageRecord(raw);
    const existing = map.get(rec.dispatchId);
    if (existing) {
      if (existing.receiptDigest !== rec.receiptDigest || existing.contributorDigest !== rec.contributorDigest) {
        throw new AiCliError(
          'ORCHESTRATION_INDETERMINATE',
          `Conflicting lineage records for dispatch ${rec.dispatchId}`,
          { exitCode: 2 },
        );
      }
    } else {
      map.set(rec.dispatchId, rec);
    }
  }

  if (map.size > MAX_LINEAGE_RECORDS) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `Merged lineage records exceed max limit of ${MAX_LINEAGE_RECORDS}`,
      { exitCode: 2 },
    );
  }

  return Object.freeze(Array.from(map.values()));
}

/**
 * Derives a LineageIndex from an array of validated SelectionReceipts, preserving
 * existing trusted lineage records and contributor binding identities.
 */
export function reconcileLineageFromReceipts(receipts = [], optionsOrExtra = {}) {
  if (!Array.isArray(receipts)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'receipts must be an array', { exitCode: 2 });
  }
  if (receipts.length > MAX_LINEAGE_RECORDS) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `Lineage receipts exceed max limit of ${MAX_LINEAGE_RECORDS}`,
      { exitCode: 2 },
    );
  }

  let existingRecords = [];
  let defaultBindingId = null;
  let extraTrustedByDispatchId = {};

  if (isPlainObject(optionsOrExtra)) {
    if (
      optionsOrExtra.existingRecords !== undefined
      || optionsOrExtra.existingIndex !== undefined
      || optionsOrExtra.defaultBindingId !== undefined
      || optionsOrExtra.extraTrustedByDispatchId !== undefined
    ) {
      if (optionsOrExtra.existingIndex !== undefined) {
        const validatedIndex = validateLineageIndex(optionsOrExtra.existingIndex);
        existingRecords = validatedIndex.records;
      } else if (optionsOrExtra.existingRecords !== undefined) {
        if (!Array.isArray(optionsOrExtra.existingRecords)) {
          throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'existingRecords must be an array', { exitCode: 2 });
        }
        existingRecords = optionsOrExtra.existingRecords.map((r) => validateLineageRecord(r));
      }
      if (optionsOrExtra.defaultBindingId !== undefined && optionsOrExtra.defaultBindingId !== null) {
        if (typeof optionsOrExtra.defaultBindingId !== 'string' || optionsOrExtra.defaultBindingId.trim().length === 0) {
          throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'defaultBindingId must be null or non-empty string', { exitCode: 2 });
        }
        defaultBindingId = optionsOrExtra.defaultBindingId;
      }
      if (optionsOrExtra.extraTrustedByDispatchId !== undefined) {
        if (!isPlainObject(optionsOrExtra.extraTrustedByDispatchId)) {
          throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'extraTrustedByDispatchId must be an object', { exitCode: 2 });
        }
        extraTrustedByDispatchId = optionsOrExtra.extraTrustedByDispatchId;
      }
    } else {
      extraTrustedByDispatchId = optionsOrExtra;
    }
  }

  const existingMap = new Map();
  for (const rawRecord of existingRecords) {
    const record = validateLineageRecord(rawRecord);
    existingMap.set(record.dispatchId, record);
  }

  const records = [];
  for (const rawReceipt of receipts) {
    const receipt = validateSelectionReceipt(rawReceipt);
    const existing = existingMap.get(receipt.dispatchId);
    if (existing) {
      // Receipt matches an existing validated durable index record:
      // Verify receipt and digest match; fail closed on mismatch
      if (
        existing.receiptDigest !== receipt.receiptDigest
        || existing.taskId !== receipt.taskId
        || existing.role !== (receipt.role ?? null)
        || existing.provider !== (receipt.provider ?? null)
        || existing.model !== (receipt.actualModel ?? receipt.model ?? 'indeterminate')
        || existing.agent !== (receipt.agent ?? null)
        || existing.decision !== (receipt.decision === 'denied' ? 'denied' : 'eligible')
      ) {
        throw new AiCliError(
          'ORCHESTRATION_INDETERMINATE',
          `Conflicting receipt or digest mismatch for existing lineage record ${receipt.dispatchId}`,
          { exitCode: 2 },
        );
      }
      // Reconcile using that record's bindingId; never replace a known bindingId with null
      records.push(existing);
    } else {
      // Receipt has no existing index record:
      // Use explicit extraTrustedByDispatchId if provided, else current supervisor-managed bindingId if available
      const extra = extraTrustedByDispatchId[receipt.dispatchId] ?? {};
      const bindingId = extra.bindingId ?? defaultBindingId ?? null;
      records.push(buildLineageRecordFromReceipt(receipt, {
        ...extra,
        bindingId,
      }));
    }
  }

  return buildLineageIndex(records);
}

/**
 * Pure independence check for final-auditor admission against trusted durable lineage.
 */
export function checkLineageIndependence({
  candidate,
  trustedRecords = [],
  taskPolicy = {},
} = {}) {
  const violations = [];

  if (!isPlainObject(candidate)) {
    violations.push({
      code: DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT,
      message: 'Candidate dispatch definition is required',
      field: 'candidate',
    });
    return { independent: false, violations };
  }

  const isFinalAuditor = candidate.role === 'final-auditor';
  if (!isFinalAuditor) {
    return { independent: true, violations: [] };
  }

  // 1. Final auditor requires non-empty trusted contributor lineage
  if (!Array.isArray(trustedRecords) || trustedRecords.length === 0) {
    violations.push({
      code: DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT,
      message: 'Final auditor requires verifiable non-empty contributor lineage to prove independence',
      field: 'lineage',
    });
    return { independent: false, violations };
  }

  // 2. Fresh session requirement
  const policyAllowsFresh = (taskPolicy.freshSession === true || taskPolicy.requireFresh === true)
    && taskPolicy.freshSession !== false
    && taskPolicy.requireFresh !== false
    && taskPolicy.isReusedSession !== true;
  const isCandidateAttestedFresh = candidate.sessionFreshness === 'fresh'
    && candidate.isReusedSession !== true;

  const isFresh = isCandidateAttestedFresh && policyAllowsFresh;
  if (!isFresh) {
    violations.push({
      code: DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT,
      message: 'Final auditor must execute in a fresh independent session',
      field: 'sessionFreshness',
    });
  }

  // 3. Read-only requirement
  const isReadOnly = (candidate.readOnly === true || taskPolicy.readOnly === true)
    && (!candidate.writeRoots || candidate.writeRoots.length === 0)
    && (!taskPolicy.allowedWriteRoots || taskPolicy.allowedWriteRoots.length === 0);
  if (!isReadOnly || candidate.writeRoot === true || candidate.allowWrite === true) {
    violations.push({
      code: DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT,
      message: 'Final auditor role must be strictly read-only with no write roots',
      field: 'task.allowedWriteRoots',
    });
  }

  // 4. Prohibited dispatch IDs
  const prohibitedDispatchIds = new Set(
    Array.isArray(taskPolicy.mustNotMatchDispatchIds) ? taskPolicy.mustNotMatchDispatchIds : [],
  );
  if (candidate.dispatchId && prohibitedDispatchIds.has(candidate.dispatchId)) {
    violations.push({
      code: DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT,
      message: 'Final auditor candidate dispatch ID matches prohibited dispatch in policy',
      field: 'independencePolicy.mustNotMatchDispatchIds',
    });
  }

  // 5. Compare candidate against trusted records
  const candidateBindingId = candidate.bindingId ?? null;
  const candidateProvider = candidate.provider ?? null;
  const candidateModel = candidate.model ?? candidate.actualModel ?? null;
  const candidateAgent = typeof candidate.agent === 'string'
    ? candidate.agent
    : (candidate.agent?.id ?? candidate.expectedAgent ?? null);
  const candidateContributorDigest = candidate.contributorDigest ?? (
    (candidateProvider && candidateModel)
      ? computeContributorDigest({
          role: candidate.role,
          provider: candidateProvider,
          model: candidateModel,
          agent: candidateAgent,
          bindingId: candidateBindingId,
        })
      : null
  );

  for (const record of trustedRecords) {
    if (!isPlainObject(record)) {
      violations.push({
        code: DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT,
        message: 'Trusted lineage contains invalid non-object entry',
        field: 'lineage',
      });
      break;
    }

    // Explicit mustNotMatchDispatchIds matching prior records
    if (prohibitedDispatchIds.has(record.dispatchId)) {
      if (
        (candidateBindingId && candidateBindingId === record.bindingId)
        || (candidateProvider && candidateModel && candidateProvider === record.provider && candidateModel === record.model)
        || (candidateAgent && candidateAgent === record.agent)
      ) {
        violations.push({
          code: DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT,
          message: 'Final auditor candidate matches contributor prohibited by mustNotMatchDispatchIds',
          field: 'independencePolicy.mustNotMatchDispatchIds',
        });
        break;
      }
    }

    const priorRole = record.role;
    // Prior writer, coordinator, or task-reviewer cannot be final auditor
    if (priorRole === 'writer' || priorRole === 'coordinator' || priorRole === 'task-reviewer') {
      const sameDispatch = Boolean(candidate.dispatchId && candidate.dispatchId === record.dispatchId);
      const sameBinding = Boolean(candidateBindingId && record.bindingId && candidateBindingId === record.bindingId);
      const sameModel = Boolean(
        candidateModel && record.model && candidateModel === record.model &&
        candidateProvider && record.provider && candidateProvider === record.provider,
      );
      const sameAgent = Boolean(candidateAgent && record.agent && candidateAgent === record.agent);
      const sameDigest = Boolean(
        candidateContributorDigest && record.contributorDigest &&
        candidateContributorDigest === record.contributorDigest,
      );

      if (sameDispatch || sameBinding || sameModel || sameAgent || sameDigest) {
        violations.push({
          code: DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT,
          message: `Final auditor candidate was a prior ${priorRole} in trusted lineage`,
          field: 'lineage',
        });
        break;
      }
    }
  }

  return {
    independent: violations.length === 0,
    violations,
  };
}
