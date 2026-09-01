import { isAbsolute, relative, resolve } from 'node:path';

import { AiCliError } from '../errors.mjs';
import {
  CLOSED_RISK_TIERS,
  DISPATCH_ADMISSION_CODES,
  GUARANTEE_TIERS,
  ID_PREFIXES,
  OPERATIONS,
  ORCHESTRATION_LIMITS,
  ORCHESTRATION_MODES,
  ORCHESTRATION_PROTOCOL,
  SELECTION_RECEIPT_SCHEMA,
  TASK_PACKET_PROTOCOL_V1_R2,
  WORKER_CALLBACK_OPERATIONS,
  WORKER_CALLBACK_PROTOCOL,
} from './constants.mjs';
import {
  CLOSED_ASSURANCES,
  CLOSED_CAPABILITIES,
  CLOSED_ROLES,
  isClosedAssurance,
  isClosedCapability,
  isClosedRole,
  isValidDigest,
} from './role-policy.mjs';

export {
  CLOSED_RISK_TIERS,
  DELIVERY_TYPES,
  DISPATCH_ADMISSION_CODES,
  GUARANTEE_TIERS,
  OPERATIONS,
  ORCHESTRATION_ERROR_CODES,
  ORCHESTRATION_LIMITS,
  ORCHESTRATION_MODES,
  ORCHESTRATION_PROTOCOL,
  SELECTION_RECEIPT_SCHEMA,
  TASK_PACKET_PROTOCOL_V1_R2,
} from './constants.mjs';


function invalid(message, details) {
  return new AiCliError('ORCHESTRATION_INVALID_INPUT', message, { exitCode: 2, details });
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) throw invalid(`${label} must be an object`);
  return value;
}

function checkUnknownFields(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw invalid(`${label} has unknown fields: ${unknown.sort().join(', ')}`, {
      unknownFields: unknown.sort(),
    });
  }
}

function requireId(value, prefix, label) {
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.length <= prefix.length) {
    throw invalid(`${label} must be a string with the ${prefix} prefix`);
  }
  return value;
}

function requireInteger(value, label, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw invalid(`${label} must be an absolute path`);
  }
  return resolve(value);
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw invalid(`${label} must be an array of strings`);
  }
  return [...value];
}

function isWithin(candidate, root) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
  } else if (isPlainObject(value)) {
    Object.values(value).forEach(deepFreeze);
  }
  return Object.freeze(value);
}

const CREATE_REQUEST_FIELDS = new Set(['protocol', 'requestId', 'owner']);
const OWNER_FIELDS = new Set(['host', 'instanceId']);

export function validateCreateRequest(value) {
  const request = requirePlainObject(value, 'create request');
  checkUnknownFields(request, CREATE_REQUEST_FIELDS, 'create request');
  const rawProtocol = typeof request.protocol === 'string' ? request.protocol : '';
  if (rawProtocol !== ORCHESTRATION_PROTOCOL) {
    if (rawProtocol.startsWith('webmcp.ai-orchestration/')) {
      throw new AiCliError(
        'ORCHESTRATION_UNSUPPORTED_VERSION',
        `unsupported orchestration protocol ${rawProtocol}; expected ${ORCHESTRATION_PROTOCOL}`,
        { exitCode: 2 },
      );
    }
    throw invalid(`create request protocol must be ${ORCHESTRATION_PROTOCOL}`);
  }
  const normalized = {
    protocol: ORCHESTRATION_PROTOCOL,
    requestId: requireId(request.requestId, ID_PREFIXES.request, 'create requestId'),
  };
  if (request.owner !== undefined && request.owner !== null) {
    const owner = requirePlainObject(request.owner, 'create owner');
    checkUnknownFields(owner, OWNER_FIELDS, 'create owner');
    normalized.owner = {
      ...(owner.host !== undefined ? { host: String(owner.host).slice(0, 128) } : {}),
      ...(owner.instanceId !== undefined ? { instanceId: String(owner.instanceId).slice(0, 128) } : {}),
    };
  }
  return deepFreeze(normalized);
}

const CALL_REQUEST_FIELDS = new Set(['protocol', 'requestId', 'operation', 'input']);

function normalizeWaitInput(input) {
  checkUnknownFields(input, new Set(['afterSequence', 'timeoutMs']), 'delivery.wait input');
  return {
    afterSequence: input.afterSequence === undefined
      ? 0
      : requireInteger(input.afterSequence, 'delivery.wait afterSequence', { min: 0 }),
    timeoutMs: input.timeoutMs === undefined
      ? ORCHESTRATION_LIMITS.maxWaitMs
      : requireInteger(input.timeoutMs, 'delivery.wait timeoutMs', { min: 1, max: ORCHESTRATION_LIMITS.maxWaitMs }),
  };
}

function normalizeAckInput(input) {
  checkUnknownFields(input, new Set(['throughSequence']), 'delivery.ack input');
  return {
    throughSequence: requireInteger(input.throughSequence, 'delivery.ack throughSequence', { min: 0 }),
  };
}

export function validateCallRequest(value) {
  const request = requirePlainObject(value, 'call request');
  checkUnknownFields(request, CALL_REQUEST_FIELDS, 'call request');
  if (typeof request.protocol !== 'string' || !request.protocol.startsWith('webmcp.ai-orchestration/')) {
    throw invalid(`call request protocol must be ${ORCHESTRATION_PROTOCOL}`);
  }
  if (request.protocol !== ORCHESTRATION_PROTOCOL) {
    throw new AiCliError(
      'ORCHESTRATION_UNSUPPORTED_VERSION',
      `unsupported orchestration protocol ${request.protocol}; expected ${ORCHESTRATION_PROTOCOL}`,
      { exitCode: 2 },
    );
  }
  if (!OPERATIONS.includes(request.operation)) {
    throw invalid(`unknown orchestration operation: ${String(request.operation)}`);
  }
  const input = requirePlainObject(request.input ?? {}, 'call input');
  let normalizedInput;
  if (request.operation === 'delivery.wait') {
    normalizedInput = normalizeWaitInput(input);
  } else if (request.operation === 'delivery.ack') {
    normalizedInput = normalizeAckInput(input);
  } else {
    normalizedInput = deepFreeze({ ...input });
  }
  return deepFreeze({
    protocol: ORCHESTRATION_PROTOCOL,
    requestId: requireId(request.requestId, ID_PREFIXES.request, 'call requestId'),
    operation: request.operation,
    input: normalizedInput,
  });
}

const BASE_TASK_PACKET_FIELDS = new Set([
  'objective',
  'workspace',
  'initialRevision',
  'dependencies',
  'allowedReadRoots',
  'allowedWriteRoots',
  'protectedPaths',
  'acceptanceCommands',
  'commandPolicy',
  'delegationDepth',
  'timeBudgetMs',
  'mode',
  'guaranteeTier',
  'adapterId',
]);

const V1_R2_TASK_PACKET_FIELDS = new Set([
  ...BASE_TASK_PACKET_FIELDS,
  'packetVersion',
  'role',
  'riskTier',
  'modelRequirements',
  'rolePolicyRevision',
  'modelBindingRevision',
  'bindingRevision',
  'fallbackPolicy',
  'independencePolicy',
  'lineage',
]);

const LEGACY_TASK_PACKET_FIELDS = new Set([
  ...BASE_TASK_PACKET_FIELDS,
  'role',
  'riskTier',
  'assurance',
  'requiredCapabilities',
  'lineage',
  'isFinalAcceptance',
  'freshSession',
  'readOnly',
  'writeRoot',
  'allowWrite',
  'writeAccess',
  'action',
  'operation',
  'canAccept',
  'modelRequirements',
  'rolePolicyRevision',
  'modelBindingRevision',
  'bindingRevision',
  'fallbackPolicy',
  'independencePolicy',
]);

const MODEL_REQUIREMENTS_FIELDS = new Set([
  'minimumAssurance',
  'requiredCapabilities',
]);

const FALLBACK_POLICY_FIELDS = new Set([
  'mode',
  'allowedBindingIds',
  'allowFallback',
  'fallbackChain',
  'allowEffortDowngrade',
  'primaryAssurance',
  'primaryEffort',
  'fallbackIndex',
]);

const INDEPENDENCE_POLICY_FIELDS = new Set([
  'readOnly',
  'mustNotMatchDispatchIds',
  'mustNotContributeToLineage',
  'requireFresh',
  'freshSession',
  'requireDisjointLineage',
  'disjointLineage',
]);

const CLOSED_RISK_TIERS_SET = new Set(CLOSED_RISK_TIERS);

function isBoundedRevision(value) {
  return isValidDigest(value)
    || (typeof value === 'number' && Number.isInteger(value) && value >= 1)
    || (typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value));
}

const FORBIDDEN_TASK_KEY_PATTERN = /^(provider|model|account|profile|credential|credentials|secret|token|password|apikey|api_key|auth|cookie|jwt|private_key|privateKey|prompt|systemPrompt|template|env|machine|machineId|machine_id|host|hostname|ip|endpoint|session|sessionId|session_id)$/i;

function scanTaskForbiddenMaterial(value, path = 'packet') {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    if (value.includes('{{') && value.includes('}}')) {
      throw invalid(`task packet contains prohibited prompt template material at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanTaskForbiddenMaterial(item, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, val] of Object.entries(value)) {
      if (FORBIDDEN_TASK_KEY_PATTERN.test(key)) {
        throw invalid(`task packet contains prohibited non-portable key ${key} at ${path}`);
      }
      scanTaskForbiddenMaterial(val, `${path}.${key}`);
    }
  }
}

const COMMAND_POLICY_FIELDS = new Set(['allowedExecutables']);
const TASK_ID_PATTERN = /^task_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

export function validateTaskPacket(value) {
  const packet = requirePlainObject(value, 'task packet');
  const isVersioned = packet.packetVersion !== undefined;

  if (isVersioned) {
    if (typeof packet.packetVersion !== 'string' || packet.packetVersion !== TASK_PACKET_PROTOCOL_V1_R2) {
      throw new AiCliError(
        'ORCHESTRATION_UNSUPPORTED_VERSION',
        `unsupported task packetVersion ${String(packet.packetVersion)}; expected ${TASK_PACKET_PROTOCOL_V1_R2}`,
        { exitCode: 2 },
      );
    }
    checkUnknownFields(packet, V1_R2_TASK_PACKET_FIELDS, 'task packet');
  } else {
    checkUnknownFields(packet, LEGACY_TASK_PACKET_FIELDS, 'task packet');
  }

  scanTaskForbiddenMaterial(packet, 'task packet');

  const objective = typeof packet.objective === 'string' ? packet.objective.trim() : '';
  if (!objective) throw invalid('task packet objective must be a non-empty string');

  const workspace = requireAbsolutePath(packet.workspace, 'task packet workspace');

  const dependencies = packet.dependencies === undefined
    ? []
    : requireStringArray(packet.dependencies, 'task packet dependencies').map(
        (id) => requireId(id, ID_PREFIXES.task, 'task dependency'),
      );

  const allowedReadRoots = packet.allowedReadRoots === undefined
    ? [workspace]
    : requireStringArray(packet.allowedReadRoots, 'task packet allowedReadRoots').map(
        (root) => requireAbsolutePath(root, 'allowedReadRoots entry'),
      );
  const allowedWriteRoots = packet.allowedWriteRoots === undefined
    ? []
    : requireStringArray(packet.allowedWriteRoots, 'task packet allowedWriteRoots').map(
        (root) => requireAbsolutePath(root, 'allowedWriteRoots entry'),
      );
  const protectedPaths = packet.protectedPaths === undefined
    ? []
    : requireStringArray(packet.protectedPaths, 'task packet protectedPaths').map(
        (pathValue) => requireAbsolutePath(pathValue, 'protectedPaths entry'),
      );

  for (const guarded of protectedPaths) {
    for (const writable of [...allowedWriteRoots]) {
      // BOTH containment directions are policy contradictions and are refused
      // at admission, before any durable dispatch creation or adapter launch:
      // a protected path inside the writable area AND a writable root inside
      // the protected path can never be verified honestly.
      if (isWithin(guarded, writable) || isWithin(writable, guarded)) {
        throw invalid('protected paths may not overlap allowed write roots', {
          protectedPath: guarded,
          allowedWriteRoot: writable,
        });
      }
    }
  }

  const acceptanceCommands = packet.acceptanceCommands === undefined
    ? []
    : (() => {
        if (!Array.isArray(packet.acceptanceCommands)) {
          throw invalid('acceptanceCommands must be an array of argv arrays, never an executable string');
        }
        if (packet.acceptanceCommands.length > ORCHESTRATION_LIMITS.maxAcceptanceCommands) {
          throw invalid(`acceptanceCommands is limited to ${ORCHESTRATION_LIMITS.maxAcceptanceCommands} commands`);
        }
        return packet.acceptanceCommands.map((argv) => {
          if (!Array.isArray(argv) || argv.length === 0) {
            throw invalid('each acceptance command must be a non-empty argv array of strings');
          }
          return argv.map((arg) => {
            if (typeof arg !== 'string' || arg.length === 0) {
              throw invalid('acceptance command argv entries must be non-empty strings');
            }
            return arg;
          });
        });
      })();

  let commandPolicy;
  if (packet.commandPolicy !== undefined) {
    const policy = requirePlainObject(packet.commandPolicy, 'commandPolicy');
    checkUnknownFields(policy, COMMAND_POLICY_FIELDS, 'commandPolicy');
    commandPolicy = {
      allowedExecutables: policy.allowedExecutables === undefined
        ? []
        : requireStringArray(policy.allowedExecutables, 'commandPolicy.allowedExecutables'),
    };
  }

  const delegationDepth = packet.delegationDepth === undefined
    ? ORCHESTRATION_LIMITS.defaultDelegationDepth
    : requireInteger(packet.delegationDepth, 'delegationDepth', {
        min: 0,
        max: ORCHESTRATION_LIMITS.maxDelegationDepth,
      });

  const timeBudgetMs = packet.timeBudgetMs === undefined
    ? null
    : requireInteger(packet.timeBudgetMs, 'timeBudgetMs', { min: 1, max: Number.MAX_SAFE_INTEGER });

  if (packet.mode !== undefined && !ORCHESTRATION_MODES.includes(packet.mode)) {
    throw invalid(`task packet mode must be one of ${ORCHESTRATION_MODES.join(', ')}`);
  }
  if (
    packet.guaranteeTier !== undefined
    && !GUARANTEE_TIERS.includes(packet.guaranteeTier)
  ) {
    throw invalid(`task packet guaranteeTier must be one of ${GUARANTEE_TIERS.join(', ')}`);
  }
  if (packet.guaranteeTier === 'unsupported') {
    throw invalid('guarantee tier unsupported can never back a dispatchable task packet');
  }

  let normalizedModelRequirements = null;
  let normalizedAssurance = null;
  let normalizedRequiredCapabilities = null;

  if (packet.modelRequirements !== undefined) {
    const reqs = requirePlainObject(packet.modelRequirements, 'modelRequirements');
    checkUnknownFields(reqs, MODEL_REQUIREMENTS_FIELDS, 'modelRequirements');
    if (typeof reqs.minimumAssurance !== 'string' || !isClosedAssurance(reqs.minimumAssurance)) {
      throw invalid(`modelRequirements.minimumAssurance must be one of ${CLOSED_ASSURANCES.join(', ')}`);
    }
    normalizedAssurance = reqs.minimumAssurance;
    if (reqs.requiredCapabilities !== undefined) {
      if (!Array.isArray(reqs.requiredCapabilities)) {
        throw invalid('modelRequirements.requiredCapabilities must be an array of strings');
      }
      for (const cap of reqs.requiredCapabilities) {
        if (!isClosedCapability(cap)) {
          throw invalid(`modelRequirements.requiredCapabilities contains unrecognized capability: ${cap}`);
        }
      }
      normalizedRequiredCapabilities = [...reqs.requiredCapabilities];
    }
    normalizedModelRequirements = {
      minimumAssurance: reqs.minimumAssurance,
      ...(normalizedRequiredCapabilities ? { requiredCapabilities: normalizedRequiredCapabilities } : {}),
    };
  }

  let normalizedFallbackPolicy = null;
  if (packet.fallbackPolicy !== undefined) {
    const fp = requirePlainObject(packet.fallbackPolicy, 'fallbackPolicy');
    checkUnknownFields(fp, FALLBACK_POLICY_FIELDS, 'fallbackPolicy');
    if (fp.allowFallback !== undefined && typeof fp.allowFallback !== 'boolean') {
      throw invalid('fallbackPolicy.allowFallback must be a boolean');
    }
    if (fp.mode !== undefined && !['explicit-only', 'block-on-downgrade'].includes(fp.mode)) {
      throw invalid('fallbackPolicy.mode must be explicit-only or block-on-downgrade');
    }
    if (fp.allowedBindingIds !== undefined) {
      if (!Array.isArray(fp.allowedBindingIds)
        || fp.allowedBindingIds.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
        throw invalid('fallbackPolicy.allowedBindingIds must be an array of non-empty strings');
      }
    }
    if (fp.fallbackChain !== undefined) {
      if (!Array.isArray(fp.fallbackChain) || fp.fallbackChain.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
        throw invalid('fallbackPolicy.fallbackChain must be an array of non-empty strings');
      }
    }
    if (fp.allowEffortDowngrade !== undefined && typeof fp.allowEffortDowngrade !== 'boolean') {
      throw invalid('fallbackPolicy.allowEffortDowngrade must be a boolean');
    }
    if (fp.primaryAssurance !== undefined && (!isClosedAssurance(fp.primaryAssurance))) {
      throw invalid(`fallbackPolicy.primaryAssurance must be one of ${CLOSED_ASSURANCES.join(', ')}`);
    }
    if (fp.primaryEffort !== undefined && (typeof fp.primaryEffort !== 'string' || fp.primaryEffort.trim().length === 0)) {
      throw invalid('fallbackPolicy.primaryEffort must be a non-empty string');
    }
    if (fp.fallbackIndex !== undefined && (!Number.isInteger(fp.fallbackIndex) || fp.fallbackIndex < 0)) {
      throw invalid('fallbackPolicy.fallbackIndex must be a non-negative integer');
    }
    normalizedFallbackPolicy = { ...fp };
  }

  let normalizedIndependencePolicy = null;
  if (packet.independencePolicy !== undefined) {
    const ip = requirePlainObject(packet.independencePolicy, 'independencePolicy');
    checkUnknownFields(ip, INDEPENDENCE_POLICY_FIELDS, 'independencePolicy');
    for (const boolField of [
      'readOnly',
      'mustNotContributeToLineage',
      'requireFresh',
      'freshSession',
      'requireDisjointLineage',
      'disjointLineage',
    ]) {
      if (ip[boolField] !== undefined && typeof ip[boolField] !== 'boolean') {
        throw invalid(`independencePolicy.${boolField} must be a boolean`);
      }
    }
    if (ip.mustNotMatchDispatchIds !== undefined) {
      if (!Array.isArray(ip.mustNotMatchDispatchIds)
        || ip.mustNotMatchDispatchIds.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
        throw invalid('independencePolicy.mustNotMatchDispatchIds must be an array of non-empty strings');
      }
      if (ip.mustNotMatchDispatchIds.length > 64) {
        throw invalid('independencePolicy.mustNotMatchDispatchIds exceeds max entries limit of 64');
      }
      for (const id of ip.mustNotMatchDispatchIds) {
        requireId(id, ID_PREFIXES.dispatch, 'independencePolicy.mustNotMatchDispatchIds entry');
      }
    }
    normalizedIndependencePolicy = { ...ip };
  }

  if (packet.lineage !== undefined) {
    if (!Array.isArray(packet.lineage)) {
      throw invalid('task packet lineage must be an array');
    }
    if (packet.lineage.length > 256) {
      throw invalid('task packet lineage exceeds max entries limit of 256');
    }
    scanTaskForbiddenMaterial(packet.lineage, 'task packet lineage');
  }

  // Versioned packet validation
  if (isVersioned) {
    if (typeof packet.role !== 'string' || !isClosedRole(packet.role)) {
      throw invalid(`task packet role must be one of ${CLOSED_ROLES.join(', ')}`);
    }
    if (typeof packet.riskTier !== 'string' || !CLOSED_RISK_TIERS_SET.has(packet.riskTier)) {
      throw invalid(`task packet riskTier must be one of ${CLOSED_RISK_TIERS.join(', ')}`);
    }
    if (packet.modelRequirements === undefined) {
      throw invalid('versioned task packet requires modelRequirements object');
    }
    if (normalizedRequiredCapabilities === null) {
      throw invalid('versioned task packet requires modelRequirements.requiredCapabilities');
    }
    for (const [field, value] of [
      ['rolePolicyRevision', packet.rolePolicyRevision],
      ['modelBindingRevision', packet.modelBindingRevision],
      ['bindingRevision', packet.bindingRevision],
    ]) {
      if (value === undefined || value === null) {
        throw invalid(`versioned task packet requires ${field}`);
      }
    }
    if (normalizedFallbackPolicy === null) {
      throw invalid('versioned task packet requires fallbackPolicy object');
    }
    if (normalizedIndependencePolicy === null) {
      throw invalid('versioned task packet requires independencePolicy object');
    }

    if (packet.rolePolicyRevision !== undefined && packet.rolePolicyRevision !== null) {
      if (!isBoundedRevision(packet.rolePolicyRevision)) {
        throw invalid('rolePolicyRevision must be a positive revision or sha256 digest');
      }
    }
    if (packet.modelBindingRevision !== undefined && packet.modelBindingRevision !== null) {
      if (!isBoundedRevision(packet.modelBindingRevision)) {
        throw invalid('modelBindingRevision must be a positive revision or sha256 digest');
      }
    }
    if (packet.bindingRevision !== undefined && packet.bindingRevision !== null) {
      if (!isBoundedRevision(packet.bindingRevision)) {
        throw invalid('bindingRevision must be a positive revision or sha256 digest');
      }
    }

    // Final auditor strict requirements
    if (packet.role === 'final-auditor') {
      if (normalizedAssurance !== 'release-final') {
        throw invalid('final-auditor role strictly requires release-final assurance');
      }
      if (allowedWriteRoots.length > 0) {
        throw invalid('final-auditor role must be strictly read-only with no write roots');
      }
      const isFresh = (normalizedIndependencePolicy.freshSession === true || normalizedIndependencePolicy.requireFresh === true)
        && packet.isReusedSession !== true;
      if (normalizedIndependencePolicy.readOnly !== true || !isFresh) {
        throw invalid('final-auditor role requires freshSession=true and readOnly=true');
      }
    }
  } else {
    // Unversioned legacy packet
    if (packet.role !== undefined && !isClosedRole(packet.role)) {
      throw invalid(`task packet role must be one of ${CLOSED_ROLES.join(', ')}`);
    }
    if (packet.riskTier !== undefined && !CLOSED_RISK_TIERS_SET.has(packet.riskTier)) {
      throw invalid(`task packet riskTier must be one of ${CLOSED_RISK_TIERS.join(', ')}`);
    }
    if (packet.assurance !== undefined) {
      if (!isClosedAssurance(packet.assurance)) {
        throw invalid(`task packet assurance must be one of ${CLOSED_ASSURANCES.join(', ')}`);
      }
      normalizedAssurance = packet.assurance;
    }
    if (packet.role === 'final-auditor') {
      if (normalizedAssurance !== 'release-final') {
        throw invalid('final-auditor role strictly requires release-final assurance');
      }
      if (allowedWriteRoots.length > 0) {
        throw invalid('final-auditor role must be strictly read-only with no write roots');
      }
    }
  }

  return deepFreeze({
    objective,
    workspace,
    initialRevision: typeof packet.initialRevision === 'string' ? packet.initialRevision : null,
    dependencies,
    allowedReadRoots,
    allowedWriteRoots,
    protectedPaths,
    acceptanceCommands,
    commandPolicy,
    delegationDepth,
    timeBudgetMs,
    ...(packet.mode !== undefined ? { mode: packet.mode } : {}),
    ...(packet.guaranteeTier !== undefined ? { guaranteeTier: packet.guaranteeTier } : {}),
    ...(packet.packetVersion !== undefined ? { packetVersion: packet.packetVersion } : {}),
    ...(packet.role !== undefined ? { role: packet.role } : {}),
    ...(packet.riskTier !== undefined ? { riskTier: packet.riskTier } : {}),
    ...(normalizedModelRequirements ? { modelRequirements: normalizedModelRequirements } : {}),
    ...(normalizedAssurance ? { assurance: normalizedAssurance } : {}),
    ...(normalizedRequiredCapabilities ? { requiredCapabilities: normalizedRequiredCapabilities } : {}),
    ...(packet.rolePolicyRevision !== undefined ? { rolePolicyRevision: packet.rolePolicyRevision } : {}),
    ...(packet.modelBindingRevision !== undefined ? { modelBindingRevision: packet.modelBindingRevision } : {}),
    ...(packet.bindingRevision !== undefined ? { bindingRevision: packet.bindingRevision } : {}),
    ...(normalizedFallbackPolicy ? { fallbackPolicy: normalizedFallbackPolicy } : {}),
    ...(normalizedIndependencePolicy ? { independencePolicy: normalizedIndependencePolicy } : {}),
    ...(packet.adapterId !== undefined ? { adapterId: packet.adapterId } : {}),
    ...(Array.isArray(packet.lineage) ? { lineage: packet.lineage } : {}),
  });
}

const WORKER_CALLBACK_FIELDS = new Set([
  'schema',
  'callbackId',
  'coordinationId',
  'taskId',
  'dispatchId',
  'bindingId',
  'fenceEpoch',
  'operation',
  'callbackSeq',
  'input',
]);

export function validateWorkerCallback(value) {
  const callback = requirePlainObject(value, 'worker callback');
  checkUnknownFields(callback, WORKER_CALLBACK_FIELDS, 'worker callback');
  if (callback.schema !== WORKER_CALLBACK_PROTOCOL) {
    throw invalid(`worker callback schema must be ${WORKER_CALLBACK_PROTOCOL}`);
  }
  if (!WORKER_CALLBACK_OPERATIONS.includes(callback.operation)) {
    throw invalid(`unknown worker callback operation: ${String(callback.operation)}`);
  }
  const input = callback.input === undefined ? {} : requirePlainObject(callback.input, 'callback input');
  return deepFreeze({
    schema: WORKER_CALLBACK_PROTOCOL,
    callbackId: requireId(callback.callbackId, ID_PREFIXES.callback, 'callback callbackId'),
    coordinationId: requireId(callback.coordinationId, ID_PREFIXES.coordination, 'callback coordinationId'),
    taskId: requireId(callback.taskId, ID_PREFIXES.task, 'callback taskId'),
    dispatchId: requireId(callback.dispatchId, ID_PREFIXES.dispatch, 'callback dispatchId'),
    bindingId: requireId(callback.bindingId, ID_PREFIXES.worker, 'callback bindingId'),
    fenceEpoch: requireInteger(callback.fenceEpoch, 'callback fenceEpoch', { min: 0 }),
    // Stable per-binding monotonic event identity: the owner's dedupe ledger
    // is keyed on (bindingId, callbackSeq); content digests detect conflicts.
    callbackSeq: requireInteger(callback.callbackSeq ?? null, 'callback callbackSeq', { min: 1 }),
    operation: callback.operation,
    input,
  });
}

/**
 * Pure seam predicate: whether a requested orchestration mode is satisfied by
 * the adapter guarantee tier proven for the worker. Dispatch creation must
 * consult this before any mutable work starts.
 */
export function modeRequiresTierSatisfied(mode, tier) {
  if (!ORCHESTRATION_MODES.includes(mode) || !GUARANTEE_TIERS.includes(tier)) return false;
  if (tier === 'unsupported') return false;
  switch (mode) {
    case 'full-handoff':
      return tier === 'native-controlled';
    case 'delegated-result-return':
      return tier === 'native-controlled' || tier === 'owned-process' || tier === 'attached-observer';
    case 'supervised-orchestration':
      return tier === 'native-controlled' || tier === 'owned-process';
    default:
      return false;
  }
}
