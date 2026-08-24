import { isAbsolute, relative, resolve } from 'node:path';

import { AiCliError } from '../errors.mjs';
import {
  GUARANTEE_TIERS,
  ID_PREFIXES,
  OPERATIONS,
  ORCHESTRATION_LIMITS,
  ORCHESTRATION_MODES,
  ORCHESTRATION_PROTOCOL,
  WORKER_CALLBACK_OPERATIONS,
  WORKER_CALLBACK_PROTOCOL,
} from './constants.mjs';

export {
  DELIVERY_TYPES,
  GUARANTEE_TIERS,
  OPERATIONS,
  ORCHESTRATION_ERROR_CODES,
  ORCHESTRATION_LIMITS,
  ORCHESTRATION_MODES,
  ORCHESTRATION_PROTOCOL,
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

const TASK_PACKET_FIELDS = new Set([
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
]);
const COMMAND_POLICY_FIELDS = new Set(['allowedExecutables']);
const TASK_ID_PATTERN = /^task_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

export function validateTaskPacket(value) {
  const packet = requirePlainObject(value, 'task packet');
  checkUnknownFields(packet, TASK_PACKET_FIELDS, 'task packet');

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
      if (isWithin(guarded, writable)) {
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
