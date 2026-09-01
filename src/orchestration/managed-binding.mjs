import { AiCliError } from '../errors.mjs';
import {
  CLOSED_ROLES,
  computeCanonicalDigest,
  deepFreeze,
  isClosedRole,
  isPlainObject,
  isValidDigest,
} from './role-policy.mjs';

export const MANAGED_BINDING_SCHEMA = 'webmcp.ai-managed-model-binding/v1';

export const ALLOWED_BINDING_FIELDS = Object.freeze(new Set([
  'schema',
  'bindingId',
  'adapterId',
  'provider',
  'model',
  'effort',
  'variant',
  'agent',
  'capabilityTier',
  'eligibleRoles',
  'deniedRoles',
  'expiresAt',
  'calibrationEvidenceDigest',
  'approvalDigest',
  'revision',
  'executableIdentityDigest',
]));

export const ALLOWED_AGENT_FIELDS = Object.freeze(new Set([
  'id',
  'name',
  'version',
  'type',
  'description',
]));

const INDETERMINATE_MODELS = new Set([
  '',
  'auto',
  '*',
  'indeterminate',
  'unknown',
  'default',
  'undefined',
  'null',
  'none',
]);

const FORBIDDEN_BINDING_KEYS = /^(session|session_id|sessionId|machine|machine_id|machineId|host|hostname|ip|path|filePath|dir|credential|credentials|secret|token|password|apiKey|api_key|auth|cookie|jwt|privateKey|private_key|prompt|systemPrompt|template|env|process)$/i;

const FORBIDDEN_PATH_PATTERN = /^(\/|~|[a-zA-Z]:[\\/]|file:\/\/|\/Users\/|\/home\/|\/etc\/|\/tmp\/|\/var\/|\/private\/)/;

export { isValidDigest };

export function isModelDeterminate(model) {
  if (typeof model !== 'string') return false;
  const trimmed = model.trim().toLowerCase();
  if (INDETERMINATE_MODELS.has(trimmed)) return false;
  if (trimmed.includes('*') || trimmed.includes('?') || trimmed.includes('{{')) return false;
  return model.trim().length > 0;
}

export function isManagedBinding(binding) {
  if (!isPlainObject(binding)) return false;
  return binding.schema === MANAGED_BINDING_SCHEMA;
}

export function computeBindingDigest(binding) {
  return computeCanonicalDigest(binding);
}

function scanBindingForbiddenMaterial(value, path = 'binding') {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    if (FORBIDDEN_PATH_PATTERN.test(value)) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        `Managed binding contains prohibited file system path material at ${path}`,
        { exitCode: 2 },
      );
    }
    if (value.includes('{{') && value.includes('}}')) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        `Managed binding contains prohibited prompt template material at ${path}`,
        { exitCode: 2 },
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanBindingForbiddenMaterial(item, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, val] of Object.entries(value)) {
      if (FORBIDDEN_BINDING_KEYS.test(key)) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          `Managed binding contains prohibited non-portable key at ${path}`,
          { exitCode: 2 },
        );
      }
      scanBindingForbiddenMaterial(val, `${path}.${key}`);
    }
  }
}

/**
 * Pure validator for webmcp.ai-managed-model-binding/v1.
 * Never reads files or environment variables.
 * Fails closed on missing, stale, expired, indeterminate, denied or mismatched binding.
 */
export function validateManagedBinding(binding, { now = Date.now() } = {}) {
  if (!isPlainObject(binding)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'Managed model binding must be a non-null object', { exitCode: 2 });
  }

  // 1. Unknown fields check (strict allowlist)
  const unknownFields = Object.keys(binding).filter((key) => !ALLOWED_BINDING_FIELDS.has(key));
  if (unknownFields.length > 0) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'Managed model binding contains unauthorized fields',
      { exitCode: 2 },
    );
  }

  // 2. Schema check
  if (binding.schema !== MANAGED_BINDING_SCHEMA) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `Unsupported binding schema; expected "${MANAGED_BINDING_SCHEMA}"`,
      { exitCode: 2 },
    );
  }

  // 3. Binding & Adapter IDs
  if (typeof binding.bindingId !== 'string' || binding.bindingId.trim().length === 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'bindingId must be a non-empty string', { exitCode: 2 });
  }
  if (typeof binding.adapterId !== 'string' || binding.adapterId.trim().length === 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'adapterId must be a non-empty string', { exitCode: 2 });
  }

  // 4. Provider & Model
  if (typeof binding.provider !== 'string' || binding.provider.trim().length === 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'provider must be a non-empty string', { exitCode: 2 });
  }
  if (!isModelDeterminate(binding.model)) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'model must be a determinate non-empty model identifier',
      { exitCode: 2 },
    );
  }

  // 5. Effort & Variant (optional non-empty strings or null)
  if (binding.effort !== undefined && binding.effort !== null) {
    if (typeof binding.effort !== 'string' || binding.effort.trim().length === 0) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'effort must be a non-empty string or null if specified', { exitCode: 2 });
    }
  }
  if (binding.variant !== undefined && binding.variant !== null) {
    if (typeof binding.variant !== 'string' || binding.variant.trim().length === 0) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'variant must be a non-empty string or null if specified', { exitCode: 2 });
    }
  }

  // 6. Agent (optional string, structured object, or null)
  if (binding.agent !== undefined && binding.agent !== null) {
    if (typeof binding.agent === 'string') {
      if (binding.agent.trim().length === 0) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'agent must be a non-empty string if specified as a string', { exitCode: 2 });
      }
    } else if (isPlainObject(binding.agent)) {
      const unknownAgentFields = Object.keys(binding.agent).filter((k) => !ALLOWED_AGENT_FIELDS.has(k));
      if (unknownAgentFields.length > 0) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'agent descriptor contains unauthorized fields', { exitCode: 2 });
      }
      if (binding.agent.id !== undefined && (typeof binding.agent.id !== 'string' || binding.agent.id.trim().length === 0)) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'agent id must be a non-empty string', { exitCode: 2 });
      }
      if (binding.agent.name !== undefined && (typeof binding.agent.name !== 'string' || binding.agent.name.trim().length === 0)) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'agent name must be a non-empty string', { exitCode: 2 });
      }
    } else {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'agent must be a string, structured descriptor object, or null if specified', { exitCode: 2 });
    }
  }

  // 7. Capability tier (non-empty array, object, or string)
  if (binding.capabilityTier === undefined || binding.capabilityTier === null) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'capabilityTier is required', { exitCode: 2 });
  }
  if (Array.isArray(binding.capabilityTier)) {
    if (binding.capabilityTier.length === 0) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'capabilityTier array must not be empty', { exitCode: 2 });
    }
    const seenCaps = new Set();
    for (const cap of binding.capabilityTier) {
      if (typeof cap !== 'string' || cap.trim().length === 0) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'capabilityTier entries must be non-empty strings', { exitCode: 2 });
      }
      if (seenCaps.has(cap)) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'capabilityTier array must not contain duplicate capabilities', { exitCode: 2 });
      }
      seenCaps.add(cap);
    }
  } else if (isPlainObject(binding.capabilityTier)) {
    if (Object.keys(binding.capabilityTier).length === 0) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'capabilityTier object must not be empty', { exitCode: 2 });
    }
    for (const [, v] of Object.entries(binding.capabilityTier)) {
      if (typeof v !== 'boolean') {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'capabilityTier object values must be booleans', { exitCode: 2 });
      }
    }
  } else if (typeof binding.capabilityTier === 'string') {
    if (binding.capabilityTier.trim().length === 0) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'capabilityTier string must not be empty', { exitCode: 2 });
    }
  } else {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'capabilityTier must be a string, array, or object', { exitCode: 2 });
  }

  // 8. Eligible & Denied Roles
  if (!Array.isArray(binding.eligibleRoles) || binding.eligibleRoles.length === 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'eligibleRoles must be a non-empty array of closed roles', { exitCode: 2 });
  }
  const seenEligible = new Set();
  for (const role of binding.eligibleRoles) {
    if (!isClosedRole(role)) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        `eligibleRoles contains unrecognized role; must be one of ${CLOSED_ROLES.join(', ')}`,
        { exitCode: 2 },
      );
    }
    if (seenEligible.has(role)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'eligibleRoles must not contain duplicate role entries', { exitCode: 2 });
    }
    seenEligible.add(role);
  }

  const deniedRoles = binding.deniedRoles ?? [];
  if (!Array.isArray(deniedRoles)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'deniedRoles must be an array of closed roles', { exitCode: 2 });
  }
  const seenDenied = new Set();
  for (const role of deniedRoles) {
    if (!isClosedRole(role)) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        `deniedRoles contains unrecognized role; must be one of ${CLOSED_ROLES.join(', ')}`,
        { exitCode: 2 },
      );
    }
    if (seenDenied.has(role)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'deniedRoles must not contain duplicate role entries', { exitCode: 2 });
    }
    seenDenied.add(role);
  }

  // Disjoint check between eligibleRoles and deniedRoles
  const overlap = binding.eligibleRoles.filter((role) => seenDenied.has(role));
  if (overlap.length > 0) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'eligibleRoles and deniedRoles must be disjoint',
      { exitCode: 2 },
    );
  }

  // 9. Expiry (must be strictly in the future relative to now)
  if (binding.expiresAt === undefined || binding.expiresAt === null) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'expiresAt is required', { exitCode: 2 });
  }
  const expiryMs = typeof binding.expiresAt === 'number'
    ? binding.expiresAt
    : Date.parse(binding.expiresAt);

  if (!Number.isFinite(expiryMs) || expiryMs <= 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'expiresAt must be a valid ISO date-time or timestamp', { exitCode: 2 });
  }

  const currentMs = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(currentMs) || expiryMs <= currentMs) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'Managed model binding has expired',
      { exitCode: 2, details: { expired: true, expiresAt: expiryMs, now: currentMs } },
    );
  }

  // 10. Cryptographic Digests (must be valid lowercase sha256: plus 64 hex, not null/zero digest)
  if (!isValidDigest(binding.calibrationEvidenceDigest)) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'calibrationEvidenceDigest must be a valid lowercase sha256: digest',
      { exitCode: 2 },
    );
  }
  if (!isValidDigest(binding.approvalDigest)) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'approvalDigest must be a valid lowercase sha256: digest',
      { exitCode: 2 },
    );
  }
  if (!isValidDigest(binding.executableIdentityDigest)) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'executableIdentityDigest must be a valid lowercase sha256: digest',
      { exitCode: 2 },
    );
  }

  // 11. Revision
  if (
    (typeof binding.revision !== 'number' || !Number.isInteger(binding.revision) || binding.revision < 1) &&
    (typeof binding.revision !== 'string' || binding.revision.trim().length === 0)
  ) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'revision must be a positive integer or non-empty string', { exitCode: 2 });
  }

  // 12. Scan recursive non-portable material
  scanBindingForbiddenMaterial(binding, 'binding');

  return deepFreeze(structuredClone(binding));
}
