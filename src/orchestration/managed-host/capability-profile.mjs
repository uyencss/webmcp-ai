import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AiCliError } from '../../errors.mjs';
import {
  computeCanonicalDigest,
  computePolicyDigest,
  canonicalJson,
} from '../role-policy.mjs';
import { validateRolePolicy } from '../role-policy.mjs';

// Frozen entry-policy revision from skills/webmcp/policy/entry-policy.json
export const ENTRY_POLICY_REVISION = 'sha256:e9822cdf5114b19ace74dd09573c01c0aa28a0e7c2ae02daf3a74ecc142fe939';

export const CAPABILITY_PROFILE_PREFIX = 'webmcp-managed-capability-profile/1:';

// Exact 11-row table derived from entry-policy.json transitions (authority-resolution §4.2)
export const CAPABILITY_PROFILE_TABLE = Object.freeze({
  'webmcp-managed-capability-profile/1:SESSION_NEW': Object.freeze({
    entryState: 'SESSION_NEW',
    capabilityClassesSorted: Object.freeze([]),
  }),
  'webmcp-managed-capability-profile/1:HOST_PREFLIGHT': Object.freeze({
    entryState: 'HOST_PREFLIGHT',
    capabilityClassesSorted: Object.freeze(['host-inspection', 'skill-inspection']),
  }),
  'webmcp-managed-capability-profile/1:ROUTE_PROPOSED': Object.freeze({
    entryState: 'ROUTE_PROPOSED',
    capabilityClassesSorted: Object.freeze(['skill.resolve']),
  }),
  'webmcp-managed-capability-profile/1:ROUTE_VALIDATED': Object.freeze({
    entryState: 'ROUTE_VALIDATED',
    capabilityClassesSorted: Object.freeze(['project.doctor', 'project.resolve', 'skill.load']),
  }),
  'webmcp-managed-capability-profile/1:GLOBAL_POLICY_LOADED': Object.freeze({
    entryState: 'GLOBAL_POLICY_LOADED',
    capabilityClassesSorted: Object.freeze(['project.doctor', 'project.resolve', 'scaffold.plan']),
  }),
  'webmcp-managed-capability-profile/1:PROJECT_RESOLVE': Object.freeze({
    entryState: 'PROJECT_RESOLVE',
    capabilityClassesSorted: Object.freeze(['project.doctor', 'project.resolve', 'scaffold.plan']),
  }),
  'webmcp-managed-capability-profile/1:PROJECT_BOOTSTRAP_REQUIRED': Object.freeze({
    entryState: 'PROJECT_BOOTSTRAP_REQUIRED',
    capabilityClassesSorted: Object.freeze(['scaffold.dry-run']),
  }),
  'webmcp-managed-capability-profile/1:PROJECT_BOOTSTRAP_PLANNED': Object.freeze({
    entryState: 'PROJECT_BOOTSTRAP_PLANNED',
    capabilityClassesSorted: Object.freeze(['scaffold.apply']),
  }),
  'webmcp-managed-capability-profile/1:PROJECT_BOOTSTRAPPED': Object.freeze({
    entryState: 'PROJECT_BOOTSTRAPPED',
    capabilityClassesSorted: Object.freeze(['context.refresh', 'project.doctor']),
  }),
  'webmcp-managed-capability-profile/1:PROJECT_POLICY_LOADED': Object.freeze({
    entryState: 'PROJECT_POLICY_LOADED',
    capabilityClassesSorted: Object.freeze(['guide.validate', 'request.prepare', 'store.discovery']),
  }),
  'webmcp-managed-capability-profile/1:ENTRY_READY': Object.freeze({
    entryState: 'ENTRY_READY',
    capabilityClassesSorted: Object.freeze(['runner.handoff']),
  }),
});

export const ALLOWED_PROFILE_IDS = Object.freeze(Object.keys(CAPABILITY_PROFILE_TABLE));
const ALLOWED_ENTRY_STATES = new Set(Object.values(CAPABILITY_PROFILE_TABLE).map((v) => v.entryState));
const CLOSED_CAPABILITY_CLASSES = new Set([
  'host-inspection',
  'skill-inspection',
  'skill.resolve',
  'skill.load',
  'project.resolve',
  'project.doctor',
  'scaffold.plan',
  'scaffold.dry-run',
  'scaffold.apply',
  'context.refresh',
  'store.discovery',
  'guide.validate',
  'request.prepare',
  'runner.handoff',
]);

export function isClosedCapabilityClass(value) {
  return typeof value === 'string' && CLOSED_CAPABILITY_CLASSES.has(value);
}

function assertSortedCapabilityClasses(classes) {
  if (!Array.isArray(classes)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'capabilityClassesSorted must be an array', { exitCode: 2 });
  }
  for (const c of classes) {
    if (!isClosedCapabilityClass(c)) {
      throw new AiCliError('WEBMCP_ROUTE_REQUIRED', `unknown capability class ${c}`, { exitCode: 2 });
    }
  }
  const sorted = [...classes].sort();
  for (let i = 0; i < classes.length; i += 1) {
    if (classes[i] !== sorted[i]) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'capabilityClassesSorted must be sorted lexicographically', { exitCode: 2 });
    }
  }
  // duplicate check
  if (new Set(classes).size !== classes.length) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'capabilityClassesSorted must not contain duplicates', { exitCode: 2 });
  }
}

export function computeCapabilityProfileRevision({
  capabilityProfileId,
  capabilityClassesSorted,
  entryPolicyRevision,
  rolePolicyRevision,
  guideSelectionDigestOrNull = null,
}) {
  if (typeof capabilityProfileId !== 'string' || !ALLOWED_PROFILE_IDS.includes(capabilityProfileId)) {
    throw new AiCliError('WEBMCP_ROUTE_REQUIRED', `unknown capabilityProfileId ${String(capabilityProfileId)}`, { exitCode: 2 });
  }
  assertSortedCapabilityClasses(capabilityClassesSorted);
  if (typeof entryPolicyRevision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(entryPolicyRevision)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'entryPolicyRevision must be a sha256 digest', { exitCode: 2 });
  }
  if (typeof rolePolicyRevision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(rolePolicyRevision)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'rolePolicyRevision must be a sha256 digest', { exitCode: 2 });
  }
  if (guideSelectionDigestOrNull !== null && guideSelectionDigestOrNull !== undefined) {
    if (typeof guideSelectionDigestOrNull !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(guideSelectionDigestOrNull)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'guideSelectionDigest must be a sha256 digest or null', { exitCode: 2 });
    }
  }
  const payload = {
    capabilityClassesSorted: [...capabilityClassesSorted].sort(),
    capabilityProfileId,
    entryPolicyRevision,
    guideSelectionDigest: guideSelectionDigestOrNull ?? null,
    rolePolicyRevision,
  };
  // Use canonical JSON + sha256 exactly as role-policy does
  const serialized = canonicalJson(payload);
  const hash = createHash('sha256').update(serialized, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

export function getTrustedRolePolicyRevision(policy = null) {
  if (policy !== null && policy !== undefined) {
    const validated = validateRolePolicy(policy);
    return computePolicyDigest(validated);
  }
  // No caller-provided policy: compute from the actual validated packaged bytes.
  // This is the only authority; absence or failure must deny, never fallback.
  const packagedPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'role-policy.json');
  if (!existsSync(packagedPath)) {
    throw new AiCliError('AI_ROLE_POLICY_REQUIRED', 'trusted role policy package bytes unavailable; cannot derive revision', { exitCode: 2 });
  }
  let raw;
  try {
    raw = readFileSync(packagedPath, 'utf8');
  } catch (error) {
    throw new AiCliError('AI_ROLE_POLICY_REQUIRED', `trusted role policy package unreadable: ${error?.code ?? 'ERROR'}`, { exitCode: 2 });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'packaged role policy is invalid JSON', { exitCode: 2 });
  }
  const validated = validateRolePolicy(parsed);
  return computePolicyDigest(validated);
}

export function validateCapabilityProfile({
  capabilityProfileId,
  capabilityClassesSorted,
  entryPolicyRevision,
  rolePolicyRevision,
  guideSelectionDigestOrNull = null,
  expectedRevision,
  trustedEntryPolicyRevision = ENTRY_POLICY_REVISION,
  trustedRolePolicyRevision = null,
  trustedGuideDigest = null,
}) {
  if (!ALLOWED_PROFILE_IDS.includes(capabilityProfileId)) {
    throw new AiCliError('WEBMCP_ROUTE_REQUIRED', `capability profile ${String(capabilityProfileId)} is not in the 11-row allow-list`, { exitCode: 2 });
  }
  const expectedClasses = CAPABILITY_PROFILE_TABLE[capabilityProfileId].capabilityClassesSorted;
  assertSortedCapabilityClasses(capabilityClassesSorted);
  // Check classes match table exactly
  if (capabilityClassesSorted.length !== expectedClasses.length ||
      capabilityClassesSorted.some((c, i) => c !== expectedClasses[i])) {
    throw new AiCliError('WEBMCP_ROUTE_REQUIRED', `capabilityClasses drift for profile ${capabilityProfileId}`, { exitCode: 2 });
  }
  // Check trusted revisions
  if (entryPolicyRevision !== trustedEntryPolicyRevision) {
    throw new AiCliError('WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH', `entryPolicyRevision drift: expected ${trustedEntryPolicyRevision}`, { exitCode: 2 });
  }
  let trustedRole;
  if (trustedRolePolicyRevision !== null && trustedRolePolicyRevision !== undefined) {
    if (typeof trustedRolePolicyRevision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(trustedRolePolicyRevision)) {
      throw new AiCliError('AI_ROLE_POLICY_DIGEST_MISMATCH', 'trustedRolePolicyRevision must be a sha256 digest', { exitCode: 2 });
    }
    trustedRole = trustedRolePolicyRevision;
  } else {
    trustedRole = getTrustedRolePolicyRevision();
  }
  if (rolePolicyRevision !== trustedRole) {
    throw new AiCliError('AI_ROLE_POLICY_DIGEST_MISMATCH', `rolePolicyRevision drift: expected ${trustedRole}`, { exitCode: 2 });
  }
  // Guide digest: for no-guide route, both must be null
  if (trustedGuideDigest === null || trustedGuideDigest === undefined) {
    if (guideSelectionDigestOrNull !== null && guideSelectionDigestOrNull !== undefined) {
      throw new AiCliError('PROJECT_GUIDE_CONTEXT_STALE', 'guideSelectionDigest must be null on no-guide route', { exitCode: 2 });
    }
  } else if (guideSelectionDigestOrNull !== trustedGuideDigest) {
    throw new AiCliError('PROJECT_GUIDE_CONTEXT_STALE', 'guideSelectionDigest drift', { exitCode: 2 });
  }
  // Revision binding
  const computed = computeCapabilityProfileRevision({
    capabilityProfileId,
    capabilityClassesSorted,
    entryPolicyRevision,
    rolePolicyRevision,
    guideSelectionDigestOrNull: guideSelectionDigestOrNull ?? null,
  });
  if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== computed) {
    // Determine which component drifted for typed code
    throw new AiCliError('WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH', `capabilityProfileRevision mismatch: computed ${computed} vs expected ${expectedRevision}`, { exitCode: 2 });
  }
  return Object.freeze({
    capabilityProfileId,
    capabilityClassesSorted: Object.freeze([...capabilityClassesSorted]),
    entryPolicyRevision,
    rolePolicyRevision,
    guideSelectionDigest: guideSelectionDigestOrNull ?? null,
    revision: computed,
    entryState: CAPABILITY_PROFILE_TABLE[capabilityProfileId].entryState,
  });
}

export function profileIdForState(entryState) {
  for (const [id, meta] of Object.entries(CAPABILITY_PROFILE_TABLE)) {
    if (meta.entryState === entryState) return id;
  }
  throw new AiCliError('WEBMCP_ROUTE_REQUIRED', `no capability profile for entryState ${String(entryState)}`, { exitCode: 2 });
}

export function allowedCapabilitiesForState(entryState) {
  const id = profileIdForState(entryState);
  return CAPABILITY_PROFILE_TABLE[id].capabilityClassesSorted;
}
