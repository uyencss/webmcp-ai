import { AiCliError } from '../../errors.mjs';
import {
  ENTRY_POLICY_REVISION,
  CAPABILITY_PROFILE_TABLE,
  ALLOWED_PROFILE_IDS,
  computeCapabilityProfileRevision,
  profileIdForState,
  allowedCapabilitiesForState,
} from './capability-profile.mjs';
import { validateEntryPlan } from './entry-plan.mjs';

// Forbidden generic capabilities that must never be allowed at any Z4 state
const FORBIDDEN_CAPABILITY_PATTERN = /^(shell|generic-shell|curl|http|network|provider|media|browser|store\.discovery\.unbounded|execution-permit)$/i;
const FORBIDDEN_DIRECT_BROWSER = new Set(['browser.navigate', 'browser.open', 'browser.evil', 'direct-browser']);

const ALLOWED_ENTRY_STATES = new Set(Object.values(CAPABILITY_PROFILE_TABLE).map((v) => v.entryState));

function assertNoForbiddenCapabilities(requested) {
  if (!Array.isArray(requested)) return;
  for (const cap of requested) {
    if (typeof cap !== 'string') continue;
    if (FORBIDDEN_DIRECT_BROWSER.has(cap) || FORBIDDEN_CAPABILITY_PATTERN.test(cap) || cap.includes('shell') || cap.includes('curl')) {
      throw new AiCliError('WEBMCP_ENTRY_RECEIPT_REQUIRED', `capability ${cap} is not in the allow-list and requires ENTRY_READY`, { exitCode: 2 });
    }
    if (cap.startsWith('browser.') || cap.startsWith('provider.') || cap.startsWith('media.')) {
      throw new AiCliError('WEBMCP_ENTRY_RECEIPT_REQUIRED', `capability ${cap} not allowed before ENTRY_READY`, { exitCode: 2 });
    }
  }
}

export function selectCapabilityProfile(pass1Plan, hostEvidence = {}) {
  if (!pass1Plan || typeof pass1Plan !== 'object') {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'pass1Plan must be an object', { exitCode: 2 });
  }
  // Validate plan integrity first
  validateEntryPlan(pass1Plan);

  // Host evidence is trusted; model may propose no profile.
  // Derive expected state from trusted evidence, not from model-forged fields.
  const entryState = hostEvidence.entryState ?? pass1Plan.entryState;
  if (typeof entryState !== 'string' || !ALLOWED_ENTRY_STATES.has(entryState)) {
    throw new AiCliError('WEBMCP_ROUTE_REQUIRED', `unknown entryState ${String(entryState)}`, { exitCode: 2 });
  }

  // Enforce trusted revision binding: drift or absence fails closed. No defaulting.
  if (typeof hostEvidence.entryPolicyRevision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hostEvidence.entryPolicyRevision)) {
    throw new AiCliError('WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH', 'hostEvidence entryPolicyRevision is required and must be a sha256 digest', { exitCode: 2 });
  }
  const trustedEntryPolicyRevision = hostEvidence.entryPolicyRevision;
  if (pass1Plan.entryPolicyRevision !== trustedEntryPolicyRevision) {
    throw new AiCliError('WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH', 'entryPolicyRevision drift', { exitCode: 2 });
  }
  if (typeof hostEvidence.rolePolicyRevision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hostEvidence.rolePolicyRevision)) {
    throw new AiCliError('AI_ROLE_POLICY_REQUIRED', 'hostEvidence rolePolicyRevision is required and must be a sha256 digest', { exitCode: 2 });
  }
  if (pass1Plan.rolePolicyRevision !== hostEvidence.rolePolicyRevision) {
    throw new AiCliError('AI_ROLE_POLICY_DIGEST_MISMATCH', 'rolePolicyRevision drift', { exitCode: 2 });
  }

  // Guide digest on no-guide route must be null
  if (hostEvidence.guideSelectionDigest !== undefined) {
    if ((hostEvidence.guideSelectionDigest ?? null) !== (pass1Plan.guideSelectionDigest ?? null)) {
      throw new AiCliError('PROJECT_GUIDE_CONTEXT_STALE', 'guideSelectionDigest drift', { exitCode: 2 });
    }
  }
  if (pass1Plan.guideSelectionDigest !== null && pass1Plan.guideSelectionDigest !== undefined) {
    // No-guide route must not carry guide digest
    if (!hostEvidence.guideRequired) {
      throw new AiCliError('PROJECT_GUIDE_APPROVAL_REQUIRED', 'guideSelectionDigest must be null on no-guide route', { exitCode: 2 });
    }
  }

  // Determine expected profile for this state (deterministic)
  const expectedProfileId = profileIdForState(entryState);
  if (pass1Plan.capabilityProfileId !== expectedProfileId) {
    throw new AiCliError('WEBMCP_ROUTE_REQUIRED', `capabilityProfileId ${pass1Plan.capabilityProfileId} not accepted for entryState ${entryState}; expected ${expectedProfileId}`, { exitCode: 2 });
  }

  // Verify capabilityClasses match table exactly
  const expectedClasses = allowedCapabilitiesForState(entryState);
  const planClasses = pass1Plan.capabilityClassesSorted;
  if (planClasses.length !== expectedClasses.length || planClasses.some((c, i) => c !== expectedClasses[i])) {
    throw new AiCliError('WEBMCP_ROUTE_REQUIRED', `capabilityClasses drift for state ${entryState}`, { exitCode: 2 });
  }

  // Verify revision deterministically
  const computedRevision = computeCapabilityProfileRevision({
    capabilityProfileId: expectedProfileId,
    capabilityClassesSorted: expectedClasses,
    entryPolicyRevision: trustedEntryPolicyRevision,
    rolePolicyRevision: pass1Plan.rolePolicyRevision,
    guideSelectionDigestOrNull: pass1Plan.guideSelectionDigest ?? null,
  });
  if (pass1Plan.capabilityProfileRevision !== computedRevision) {
    throw new AiCliError('WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH', `capabilityProfileRevision mismatch for ${expectedProfileId}`, { exitCode: 2 });
  }

  // Project policy gate: scaffold.plan, store.discovery etc. require policy loaded
  if ((expectedClasses.includes('store.discovery') || expectedClasses.includes('guide.validate') || expectedClasses.includes('request.prepare')) &&
      hostEvidence.projectPolicyLoaded === false) {
    throw new AiCliError('WEBMCP_PROJECT_BOOTSTRAP_REQUIRED', `state ${entryState} requires PROJECT_POLICY_LOADED`, { exitCode: 2 });
  }
  if (expectedClasses.includes('runner.handoff') && hostEvidence.projectPolicyLoaded !== true) {
    throw new AiCliError('WEBMCP_ENTRY_RECEIPT_REQUIRED', 'ENTRY_READY requires PROJECT_POLICY_LOADED', { exitCode: 2 });
  }

  // Check requested capabilities against allow-list (prompt injection denial)
  const requested = hostEvidence.requestedCapabilities ?? hostEvidence.proposedCapabilities ?? null;
  if (requested !== null && requested !== undefined) {
    assertNoForbiddenCapabilities(requested);
    for (const cap of requested) {
      if (!expectedClasses.includes(cap)) {
        throw new AiCliError('WEBMCP_ENTRY_RECEIPT_REQUIRED', `capability ${cap} not allowed at ${entryState}; allowed: ${expectedClasses.join(',') || '(none)'}`, { exitCode: 2 });
      }
    }
  }

  // Model self-set state/profile/guarantee: ignore any forged fields in hostEvidence.modelProposed
  if (hostEvidence.modelProposed && typeof hostEvidence.modelProposed === 'object') {
    const forged = hostEvidence.modelProposed;
    if (forged.state !== undefined || forged.profile !== undefined || forged.guaranteeTier !== undefined || forged.skillRead !== undefined) {
      // Forged fields are ignored — validator derives from trusted evidence; do not throw, just ignore
      // But if they attempt to set guaranteeTier to G2 on unsupported host, we deny
      if (forged.guaranteeTier === 'G2') {
        throw new AiCliError('POLICY_DENIED', 'model cannot self-set guaranteeTier to G2', { exitCode: 2 });
      }
    }
  }

  // Unsupported host must not claim G2
  if (hostEvidence.guaranteeTier === 'G2' || hostEvidence.hostMode === 'g2') {
    throw new AiCliError('POLICY_DENIED', 'host cannot claim G2 on current primitives', { exitCode: 2 });
  }

  return Object.freeze({
    acceptedProfileId: expectedProfileId,
    entryState,
    allowedCapabilities: Object.freeze([...expectedClasses]),
    capabilityProfileRevision: computedRevision,
    entryPolicyRevision: trustedEntryPolicyRevision,
    rolePolicyRevision: pass1Plan.rolePolicyRevision,
    guideSelectionDigest: pass1Plan.guideSelectionDigest ?? null,
  });
}

export function isCapabilityAllowed(capability, entryState) {
  const allowed = allowedCapabilitiesForState(entryState);
  return allowed.includes(capability);
}

// Re-export for test convenience
export { ALLOWED_PROFILE_IDS, CAPABILITY_PROFILE_TABLE };
