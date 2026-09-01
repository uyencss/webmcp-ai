import { createHash } from 'node:crypto';

import { AiCliError } from '../errors.mjs';

export const ROLE_POLICY_SCHEMA = 'webmcp-ai-role-policy/1';

export const CLOSED_ROLES = Object.freeze([
  'coordinator',
  'writer',
  'task-reviewer',
  'final-auditor',
  'observer',
]);

export const CLOSED_ASSURANCES = Object.freeze([
  'diagnostic',
  'code-bounded',
  'reasoning-high',
  'release-final',
]);

export const CLOSED_CAPABILITIES = Object.freeze([
  'coordinate',
  'delegate',
  'inspect',
  'write-code',
  'execute-tests',
  'review-code',
  'inspect-diff',
  'audit-release',
  'verify-integrity',
  'accept',
  'log',
]);

export const CLOSED_RULES = Object.freeze([
  'coordinatorSelfAcceptDenial',
  'finalAuditorDisjointLineage',
  'finalAuditorReadOnlyNoWriteRoot',
  'noDowngrade',
]);

export const ASSURANCE_RANK = Object.freeze({
  diagnostic: 0,
  'code-bounded': 1,
  'reasoning-high': 2,
  'release-final': 3,
});

export const ALLOWED_POLICY_TOP_LEVEL_FIELDS = Object.freeze(new Set([
  'schema',
  '$schema',
  'policyVersion',
  'roles',
  'assurances',
  'rules',
  'digest',
  'policyDigest',
  'revision',
]));

export const ALLOWED_ROLE_CONFIG_FIELDS = Object.freeze(new Set([
  'allowedAssurances',
  'capabilities',
  'canCoordinate',
  'canWrite',
  'canAccept',
  'readOnly',
  'requireFresh',
  'requireDisjointLineage',
]));

export const ALLOWED_ASSURANCE_CONFIG_FIELDS = Object.freeze(new Set([
  'description',
  'minimumRank',
]));

export const ALLOWED_RULE_CONFIG_FIELDS = Object.freeze(new Set([
  'coordinatorSelfAcceptDenial',
  'finalAuditorDisjointLineage',
  'finalAuditorReadOnlyNoWriteRoot',
  'noDowngrade',
]));

const CLOSED_ROLES_SET = new Set(CLOSED_ROLES);
const CLOSED_ASSURANCES_SET = new Set(CLOSED_ASSURANCES);
const CLOSED_CAPABILITIES_SET = new Set(CLOSED_CAPABILITIES);
const CLOSED_RULES_SET = new Set(CLOSED_RULES);

const DIGEST_REGEX = /^sha256:[0-9a-f]{64}$/;
const NULL_DIGEST = 'sha256:' + '0'.repeat(64);

const FORBIDDEN_KEY_PATTERN = /^(provider|model|account|profile|path|credential|machine|prompt|secret|token|password|apikey|api_key|auth|cookie|jwt|private_key|session_id|user_id|host|hostname|ip|endpoint|env|process)$/i;

const FORBIDDEN_PATH_PATTERN = /^(\/|~|[a-zA-Z]:[\\/]|file:\/\/|\/Users\/|\/home\/|\/etc\/|\/tmp\/|\/var\/|\/private\/)/;

export function isClosedRole(role) {
  return typeof role === 'string' && CLOSED_ROLES_SET.has(role);
}

export function isClosedAssurance(assurance) {
  return typeof assurance === 'string' && CLOSED_ASSURANCES_SET.has(assurance);
}

export function isClosedCapability(capability) {
  return typeof capability === 'string' && CLOSED_CAPABILITIES_SET.has(capability);
}

export function isValidDigest(digest) {
  return typeof digest === 'string' && DIGEST_REGEX.test(digest) && digest !== NULL_DIGEST;
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else {
    for (const val of Object.values(value)) {
      deepFreeze(val);
    }
  }
  return Object.freeze(value);
}

/**
 * Deterministic canonical JSON serialization.
 * Object keys are recursively sorted lexicographically (UTF-16 code unit order).
 */
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const entries = [];
    for (const key of keys) {
      const val = value[key];
      if (val !== undefined && typeof val !== 'function' && typeof val !== 'symbol') {
        entries.push(`${JSON.stringify(key)}:${canonicalJson(val)}`);
      }
    }
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`Cannot canonicalize unsupported type: ${typeof value}`);
}

/**
 * Computes deterministic canonical lowercase sha256: digest.
 */
export function computeCanonicalDigest(value) {
  const serialized = canonicalJson(value);
  const hash = createHash('sha256').update(serialized, 'utf8').digest('hex');
  return `sha256:${hash.toLowerCase()}`;
}

/**
 * Computes deterministic canonical policy digest.
 * Excludes only explicitly documented digest/revision metadata (digest, policyDigest, revision),
 * preserving all other fields and array order.
 */
export function computePolicyDigest(policy) {
  if (!isPlainObject(policy)) {
    return computeCanonicalDigest(policy);
  }
  const {
    digest: _d,
    policyDigest: _pd,
    revision: _r,
    ...stripped
  } = policy;
  return computeCanonicalDigest(stripped);
}

function scanForbiddenMaterial(value, path = 'policy') {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    if (FORBIDDEN_PATH_PATTERN.test(value)) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        `Policy contains prohibited file system path material at ${path}`,
        { exitCode: 2 },
      );
    }
    if (value.includes('{{') && value.includes('}}')) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        `Policy contains prohibited prompt template material at ${path}`,
        { exitCode: 2 },
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenMaterial(item, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, val] of Object.entries(value)) {
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          `Policy contains prohibited non-portable key at ${path}`,
          { exitCode: 2 },
        );
      }
      scanForbiddenMaterial(val, `${path}.${key}`);
    }
  }
}

/**
 * Validates role policy against webmcp-ai-role-policy/1.
 * Fails closed on any invalid, unknown, or non-portable material.
 */
export function validateRolePolicy(policy) {
  if (!isPlainObject(policy)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Role policy must be a non-null object', { exitCode: 2 });
  }

  // 1. Check unknown top-level fields
  const unknownTopLevel = Object.keys(policy).filter((key) => !ALLOWED_POLICY_TOP_LEVEL_FIELDS.has(key));
  if (unknownTopLevel.length > 0) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'Role policy contains unauthorized top-level fields',
      { exitCode: 2 },
    );
  }

  // 2. Schema validation
  const schema = policy.schema || policy.$schema;
  if (schema !== ROLE_POLICY_SCHEMA) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `Unsupported role policy schema; expected "${ROLE_POLICY_SCHEMA}"`,
      { exitCode: 2 },
    );
  }

  // 3. Policy version validation
  if (policy.policyVersion !== undefined) {
    if (!Number.isInteger(policy.policyVersion) || policy.policyVersion < 1) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        'policyVersion must be a positive integer',
        { exitCode: 2 },
      );
    }
  }

  // 4. Policy metadata (digest / revision) validation if present
  if (policy.digest !== undefined && !isValidDigest(policy.digest)) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'policy digest metadata must be a valid lowercase sha256: digest',
      { exitCode: 2 },
    );
  }
  if (policy.policyDigest !== undefined && !isValidDigest(policy.policyDigest)) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'policyDigest metadata must be a valid lowercase sha256: digest',
      { exitCode: 2 },
    );
  }
  if (policy.revision !== undefined) {
    if (
      (typeof policy.revision !== 'number' || !Number.isInteger(policy.revision) || policy.revision < 1) &&
      (typeof policy.revision !== 'string' || policy.revision.trim().length === 0)
    ) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        'policy revision metadata must be a positive integer or non-empty string',
        { exitCode: 2 },
      );
    }
  }

  // 5. Scan forbidden non-portable material
  scanForbiddenMaterial(policy, 'policy');

  // 6. Validate roles object
  if (!isPlainObject(policy.roles)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Role policy must contain a roles object', { exitCode: 2 });
  }

  const roleKeys = Object.keys(policy.roles);
  for (const role of roleKeys) {
    if (!isClosedRole(role)) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        `Role policy contains unrecognized role; must be one of ${CLOSED_ROLES.join(', ')}`,
        { exitCode: 2 },
      );
    }

    const config = policy.roles[role];
    if (!isPlainObject(config)) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        'Role configuration must be an object',
        { exitCode: 2 },
      );
    }

    // Check unknown role config fields
    const unknownRoleFields = Object.keys(config).filter((key) => !ALLOWED_ROLE_CONFIG_FIELDS.has(key));
    if (unknownRoleFields.length > 0) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        'Role configuration contains unauthorized fields',
        { exitCode: 2 },
      );
    }

    if (!Array.isArray(config.allowedAssurances) || config.allowedAssurances.length === 0) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        'Role must define non-empty allowedAssurances array',
        { exitCode: 2 },
      );
    }

    const seenAssurances = new Set();
    for (const assurance of config.allowedAssurances) {
      if (!isClosedAssurance(assurance)) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          `Role contains unrecognized assurance; must be one of ${CLOSED_ASSURANCES.join(', ')}`,
          { exitCode: 2 },
        );
      }
      if (seenAssurances.has(assurance)) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          'Role allowedAssurances must not contain duplicates',
          { exitCode: 2 },
        );
      }
      seenAssurances.add(assurance);
    }

    if (config.capabilities !== undefined) {
      if (!Array.isArray(config.capabilities)) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          'Role capabilities must be an array',
          { exitCode: 2 },
        );
      }
      const seenCaps = new Set();
      for (const cap of config.capabilities) {
        if (!isClosedCapability(cap)) {
          throw new AiCliError(
            'ORCHESTRATION_INVALID_INPUT',
            `Role contains unrecognized capability; must be one of ${CLOSED_CAPABILITIES.join(', ')}`,
            { exitCode: 2 },
          );
        }
        if (seenCaps.has(cap)) {
          throw new AiCliError(
            'ORCHESTRATION_INVALID_INPUT',
            'Role capabilities must not contain duplicates',
            { exitCode: 2 },
          );
        }
        seenCaps.add(cap);
      }
    }

    for (const boolField of ['canCoordinate', 'canWrite', 'canAccept', 'readOnly', 'requireFresh', 'requireDisjointLineage']) {
      if (config[boolField] !== undefined && typeof config[boolField] !== 'boolean') {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          `Role ${boolField} must be a boolean`,
          { exitCode: 2 },
        );
      }
    }
  }

  // 7. Validate assurances object if present
  if (policy.assurances !== undefined) {
    if (!isPlainObject(policy.assurances)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'assurances must be an object', { exitCode: 2 });
    }
    for (const [assuranceName, assuranceConfig] of Object.entries(policy.assurances)) {
      if (!isClosedAssurance(assuranceName)) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          `assurances contains unrecognized assurance; must be one of ${CLOSED_ASSURANCES.join(', ')}`,
          { exitCode: 2 },
        );
      }
      if (!isPlainObject(assuranceConfig)) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Assurance configuration must be an object', { exitCode: 2 });
      }
      const unknownAssuranceFields = Object.keys(assuranceConfig).filter((k) => !ALLOWED_ASSURANCE_CONFIG_FIELDS.has(k));
      if (unknownAssuranceFields.length > 0) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Assurance configuration contains unauthorized fields', { exitCode: 2 });
      }
      if (assuranceConfig.description !== undefined && typeof assuranceConfig.description !== 'string') {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Assurance description must be a string', { exitCode: 2 });
      }
      if (
        assuranceConfig.minimumRank !== undefined &&
        (!Number.isInteger(assuranceConfig.minimumRank) || assuranceConfig.minimumRank < 0)
      ) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Assurance minimumRank must be a non-negative integer', { exitCode: 2 });
      }
    }
  }

  // 8. Validate rules object if present
  if (policy.rules !== undefined) {
    if (!isPlainObject(policy.rules)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'rules must be an object', { exitCode: 2 });
    }
    for (const [ruleName, ruleValue] of Object.entries(policy.rules)) {
      if (!CLOSED_RULES_SET.has(ruleName)) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          `rules contains unrecognized rule; must be one of ${CLOSED_RULES.join(', ')}`,
          { exitCode: 2 },
        );
      }
      if (typeof ruleValue !== 'boolean') {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Rule value must be a boolean', { exitCode: 2 });
      }
    }
  }

  return deepFreeze(structuredClone(policy));
}

export const DEFAULT_ROLE_POLICY = deepFreeze({
  schema: ROLE_POLICY_SCHEMA,
  policyVersion: 1,
  roles: {
    coordinator: {
      allowedAssurances: [
        'diagnostic',
        'code-bounded',
        'reasoning-high',
        'release-final',
      ],
      capabilities: [
        'coordinate',
        'delegate',
        'inspect',
      ],
      canCoordinate: true,
      canWrite: false,
      canAccept: false,
      readOnly: true,
    },
    writer: {
      allowedAssurances: [
        'code-bounded',
        'reasoning-high',
      ],
      capabilities: [
        'write-code',
        'execute-tests',
      ],
      canCoordinate: false,
      canWrite: true,
      canAccept: false,
      readOnly: false,
    },
    'task-reviewer': {
      allowedAssurances: [
        'code-bounded',
        'reasoning-high',
        'release-final',
      ],
      capabilities: [
        'review-code',
        'inspect-diff',
      ],
      canCoordinate: false,
      canWrite: false,
      canAccept: false,
      readOnly: true,
    },
    'final-auditor': {
      allowedAssurances: [
        'release-final',
      ],
      capabilities: [
        'audit-release',
        'verify-integrity',
        'accept',
      ],
      canCoordinate: false,
      canWrite: false,
      canAccept: true,
      readOnly: true,
      requireFresh: true,
      requireDisjointLineage: true,
    },
    observer: {
      allowedAssurances: [
        'diagnostic',
        'code-bounded',
      ],
      capabilities: [
        'inspect',
        'log',
      ],
      canCoordinate: false,
      canWrite: false,
      canAccept: false,
      readOnly: true,
    },
  },
  assurances: {
    diagnostic: {
      description: 'Diagnostic and triage tier with read-only inspection',
      minimumRank: 0,
    },
    'code-bounded': {
      description: 'Bounded code creation, modification, and local verification',
      minimumRank: 1,
    },
    'reasoning-high': {
      description: 'Deep reasoning, comprehensive review, and analytical verification',
      minimumRank: 2,
    },
    'release-final': {
      description: 'Final release audit and non-repudiable integrity verification',
      minimumRank: 3,
    },
  },
  rules: {
    coordinatorSelfAcceptDenial: true,
    finalAuditorDisjointLineage: true,
    finalAuditorReadOnlyNoWriteRoot: true,
    noDowngrade: true,
  },
});
