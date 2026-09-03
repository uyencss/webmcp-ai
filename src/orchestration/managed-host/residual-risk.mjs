import { AiCliError } from '../../errors.mjs';

export const RESIDUAL_RISK_SCHEMA = 'webmcp-managed-host-residual-risk/1';

const ALLOWED_HOST_MODES = new Set(['managed-G1', 'ambient-G0', 'unsupported']);
const ALLOWED_GUARANTEE_TIERS = new Set(['G0', 'G1']);

const SECRET_VALUE_PATTERN = /(bearer\s+[A-Za-z0-9_.-]+|sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{15,}|-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----|secret|token|credential|password)/i;
const PATH_PATTERN = /(?:^|[\s("'`])(?:\/|~\/|[a-zA-Z]:[\\/]|file:\/\/|https?:\/\/)/i;

function scanNoSecrets(value, path = 'residualRisk') {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (SECRET_VALUE_PATTERN.test(value)) {
      throw new AiCliError('POLICY_DENIED', `residual risk payload contains prohibited secret material at ${path}`, { exitCode: 2 });
    }
    if (PATH_PATTERN.test(value) && value.includes('/')) {
      // Absolute paths are not allowed in portable residual risk; but capabilityProfileRevision digests are allowed
      // Only flag if looks like filesystem path not digest
      if (!/^sha256:[0-9a-f]{64}$/.test(value) && !/^webmcp-/.test(value) && value.length > 20) {
        // Check if it's a wouldDeny code or missingPrimitive name — those are short identifiers, not paths
        if (value.startsWith('/') || value.includes('://')) {
          throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `residual risk payload contains prohibited path material at ${path}`, { exitCode: 2 });
        }
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => scanNoSecrets(item, `${path}[${idx}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/^(credential|secret|token|password|privateKey|bindingPath|env|session)/i.test(k)) {
        throw new AiCliError('POLICY_DENIED', `residual risk contains prohibited key ${k} at ${path}`, { exitCode: 2 });
      }
      scanNoSecrets(v, `${path}.${k}`);
    }
  }
}

export function buildResidualRisk({
  guaranteeTier,
  hostMode,
  entryState,
  capabilityProfileRevision,
  entryPolicyRevision,
  rolePolicyRevision,
  missingPrimitives = [],
  wouldDeny = [],
  createdAt = null,
} = {}) {
  if (guaranteeTier === 'G2') {
    throw new AiCliError('POLICY_DENIED', 'residual risk must never claim G2', { exitCode: 2 });
  }
  if (!ALLOWED_GUARANTEE_TIERS.has(guaranteeTier)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `guaranteeTier must be one of ${[...ALLOWED_GUARANTEE_TIERS].join(', ')}`, { exitCode: 2 });
  }
  if (!ALLOWED_HOST_MODES.has(hostMode)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `hostMode must be one of ${[...ALLOWED_HOST_MODES].join(', ')}`, { exitCode: 2 });
  }
  if (typeof entryState !== 'string' || entryState.length === 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'entryState is required', { exitCode: 2 });
  }
  for (const field of [capabilityProfileRevision, entryPolicyRevision, rolePolicyRevision]) {
    if (typeof field !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(field)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'revision fields must be sha256 digests', { exitCode: 2 });
    }
  }
  if (!Array.isArray(missingPrimitives) || !Array.isArray(wouldDeny)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'missingPrimitives and wouldDeny must be arrays', { exitCode: 2 });
  }
  // missingPrimitives are short identifiers, not paths/secrets
  for (const prim of missingPrimitives) {
    if (typeof prim !== 'string' || prim.length === 0 || prim.length > 64) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'missingPrimitive must be a bounded identifier', { exitCode: 2 });
    }
    if (prim.includes('/') || prim.includes(':') || prim.includes(' ')) {
      // Should be identifiers like tool-surface-hiding
      if (prim.includes('/') ) throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'missingPrimitive must not contain path separators', { exitCode: 2 });
    }
  }
  for (const deny of wouldDeny) {
    if (typeof deny !== 'string' || deny.length === 0) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'wouldDeny entries must be non-empty strings', { exitCode: 2 });
    }
  }

  const payload = {
    schema: RESIDUAL_RISK_SCHEMA,
    guaranteeTier,
    hostMode,
    missingPrimitives: Object.freeze([...missingPrimitives].sort()),
    wouldDeny: Object.freeze([...wouldDeny].sort()),
    entryState,
    capabilityProfileRevision,
    entryPolicyRevision,
    rolePolicyRevision,
    createdAt: createdAt ?? new Date().toISOString(),
  };

  scanNoSecrets(payload);

  // Never G2 invariant
  if (payload.guaranteeTier === 'G2' || payload.hostMode === 'g2') {
    throw new AiCliError('POLICY_DENIED', 'residual risk must never be G2', { exitCode: 2 });
  }

  return Object.freeze(payload);
}

export function isG2Claim(payload) {
  return payload && (payload.guaranteeTier === 'G2' || payload.hostMode === 'g2' || payload.guaranteeTier === 'G2');
}

export function assertNotG2(payload) {
  if (isG2Claim(payload)) {
    throw new AiCliError('POLICY_DENIED', 'residual risk payload claims G2 but must be G0/G1', { exitCode: 2 });
  }
}
