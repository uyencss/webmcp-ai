import { AiCliError } from '../../errors.mjs';
import {
  ENTRY_POLICY_REVISION,
  CAPABILITY_PROFILE_TABLE,
  profileIdForState,
  computeCapabilityProfileRevision,
} from './capability-profile.mjs';

// Frozen obligation IDs from skills/webmcp/policy/entry-policy.json
export const REQUIRED_OBLIGATION_IDS = Object.freeze([
  'webmcp.entry.preflight-before-action',
  'webmcp.entry.load-global-policy',
  'webmcp.entry.bootstrap-before-project-work',
  'webmcp.entry.reload-project-policy',
  'webmcp.entry.discovery-after-policy',
  'webmcp.entry.no-ambient-fallback',
  'webmcp.entry.claim-before-outward-action',
]);

const ALLOWED_ENTRY_STATES = new Set(Object.values(CAPABILITY_PROFILE_TABLE).map((v) => v.entryState));

const ALLOWED_EVIDENCE_FIELDS = new Set([
  'entryState',
  'projectPolicyLoaded',
  'entryPolicyRevision',
  'rolePolicyRevision',
  'guideSelectionDigest',
  'guideRequired',
  'obligationIds',
  'capabilityProfileId',
  'capabilityClasses',
  'hostMode',
  'workspace',
  'collectionId',
]);

export function buildEntryPlan(evidence = {}, policy = {}) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'entry plan evidence must be an object', { exitCode: 2 });
  }
  const unknown = Object.keys(evidence).filter((k) => !ALLOWED_EVIDENCE_FIELDS.has(k));
  if (unknown.length > 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `entry plan evidence has unknown field(s): ${unknown.sort().join(', ')}`, { exitCode: 2 });
  }
  // Guide-required requests must be denied on no-guide route; caller must handle.
  // But if guideRequired true, we fail closed unless D5 is present (which we don't enable)
  if (evidence.guideRequired === true || typeof evidence.collectionId === 'string') {
    throw new AiCliError('PROJECT_GUIDE_APPROVAL_REQUIRED', 'guide-required execution is blocked on no-guide route; D5 required', { exitCode: 2 });
  }
  if (evidence.guideSelectionDigest !== undefined && evidence.guideSelectionDigest !== null) {
    throw new AiCliError('PROJECT_GUIDE_CONTEXT_STALE', 'guideSelectionDigest must be null on no-guide route', { exitCode: 2 });
  }

  const entryState = evidence.entryState;
  if (typeof entryState !== 'string' || !ALLOWED_ENTRY_STATES.has(entryState)) {
    throw new AiCliError('WEBMCP_ROUTE_REQUIRED', `unknown entryState ${String(entryState)}`, { exitCode: 2 });
  }

  const entryPolicyRevision = evidence.entryPolicyRevision;
  if (typeof entryPolicyRevision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(entryPolicyRevision)) {
    throw new AiCliError('WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH', 'entryPolicyRevision is required and must be a sha256 digest matching trusted installed policy', { exitCode: 2 });
  }
  // Bind exact revision — drift fails closed; no defaulting from constant.
  if (entryPolicyRevision !== ENTRY_POLICY_REVISION) {
    throw new AiCliError('WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH', 'entryPolicyRevision does not match trusted installed policy', { exitCode: 2 });
  }

  const rolePolicyRevision = evidence.rolePolicyRevision;
  if (typeof rolePolicyRevision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(rolePolicyRevision)) {
    throw new AiCliError('AI_ROLE_POLICY_REQUIRED', 'rolePolicyRevision is required and must be a sha256 digest', { exitCode: 2 });
  }

  // Derive capability profile
  const capabilityProfileId = evidence.capabilityProfileId ?? profileIdForState(entryState);
  if (capabilityProfileId !== profileIdForState(entryState)) {
    throw new AiCliError('WEBMCP_ROUTE_REQUIRED', `capabilityProfileId ${capabilityProfileId} does not match entryState ${entryState}`, { exitCode: 2 });
  }
  const expectedClasses = CAPABILITY_PROFILE_TABLE[capabilityProfileId].capabilityClassesSorted;
  const providedClasses = evidence.capabilityClasses ?? expectedClasses;
  if (providedClasses.length !== expectedClasses.length || providedClasses.some((c, i) => c !== expectedClasses[i])) {
    throw new AiCliError('WEBMCP_ROUTE_REQUIRED', 'capabilityClasses drift for entry plan', { exitCode: 2 });
  }

  // Obligation citation: must include required IDs
  const obligationIds = evidence.obligationIds ?? [...REQUIRED_OBLIGATION_IDS];
  if (!Array.isArray(obligationIds) || obligationIds.length === 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'obligationIds must be a non-empty array', { exitCode: 2 });
  }
  for (const required of REQUIRED_OBLIGATION_IDS) {
    if (!obligationIds.includes(required)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `missing required obligationId ${required}`, { exitCode: 2 });
    }
  }

  const guideSelectionDigestOrNull = null; // no-guide route

  const capabilityProfileRevision = computeCapabilityProfileRevision({
    capabilityProfileId,
    capabilityClassesSorted: expectedClasses,
    entryPolicyRevision,
    rolePolicyRevision,
    guideSelectionDigestOrNull,
  });

  const plan = {
    schema: 'webmcp-entry-plan/1',
    entryState,
    capabilityProfileId,
    capabilityClassesSorted: Object.freeze([...expectedClasses]),
    capabilityProfileRevision,
    entryPolicyRevision,
    rolePolicyRevision,
    guideSelectionDigest: null,
    obligationIds: Object.freeze([...obligationIds].sort()),
    projectPolicyLoaded: evidence.projectPolicyLoaded === true,
    hostMode: evidence.hostMode ?? 'managed-G1',
    // No guide fields on no-guide route
  };

  // Freeze for determinism
  return Object.freeze(plan);
}

export function validateEntryPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'entry plan must be an object', { exitCode: 2 });
  }
  if (plan.schema !== 'webmcp-entry-plan/1') {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'entry plan schema must be webmcp-entry-plan/1', { exitCode: 2 });
  }
  // Re-derive and compare revision
  const recomputed = computeCapabilityProfileRevision({
    capabilityProfileId: plan.capabilityProfileId,
    capabilityClassesSorted: plan.capabilityClassesSorted,
    entryPolicyRevision: plan.entryPolicyRevision,
    rolePolicyRevision: plan.rolePolicyRevision,
    guideSelectionDigestOrNull: plan.guideSelectionDigest ?? null,
  });
  if (plan.capabilityProfileRevision !== recomputed) {
    throw new AiCliError('WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH', 'entry plan capabilityProfileRevision mismatch', { exitCode: 2 });
  }
  return plan;
}
