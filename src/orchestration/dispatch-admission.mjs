import { AiCliError } from '../errors.mjs';
import {
  ASSURANCE_RANK,
  CLOSED_ASSURANCES,
  CLOSED_ROLES,
  DEFAULT_ROLE_POLICY,
  computeCanonicalDigest,
  computePolicyDigest,
  deepFreeze,
  isClosedAssurance,
  isClosedRole,
  isPlainObject,
  validateRolePolicy,
} from './role-policy.mjs';
import {
  computeBindingDigest,
  isModelDeterminate,
  validateManagedBinding,
} from './managed-binding.mjs';
import {
  EVALUATION_VIOLATIONS,
  evaluateModelRoleEligibility,
} from './role-policy-evaluator.mjs';
import {
  checkLineageIndependence,
  computeContributorDigest,
  validateLineageRecord,
} from './lineage.mjs';
import {
  CLOSED_RISK_TIERS,
  DISPATCH_ADMISSION_CODES,
  TASK_PACKET_PROTOCOL_V1_R2,
} from './constants.mjs';

export { DISPATCH_ADMISSION_CODES };

export const CANONICAL_ADMISSION_CODES = DISPATCH_ADMISSION_CODES;

function mapR1ViolationToCanonical(v) {
  const code = v?.code;
  switch (code) {
    case EVALUATION_VIOLATIONS.TASK_REQUIRED:
    case EVALUATION_VIOLATIONS.INVALID_ROLE_POLICY:
      return DISPATCH_ADMISSION_CODES.AI_ROLE_POLICY_REQUIRED;
    case EVALUATION_VIOLATIONS.DIGEST_POLICY_MISMATCH:
      return DISPATCH_ADMISSION_CODES.AI_ROLE_POLICY_DIGEST_MISMATCH;
    case EVALUATION_VIOLATIONS.BINDING_REQUIRED:
    case EVALUATION_VIOLATIONS.INVALID_BINDING:
    case EVALUATION_VIOLATIONS.BINDING_EXPIRED:
      return DISPATCH_ADMISSION_CODES.AI_MODEL_BINDING_UNAVAILABLE;
    case EVALUATION_VIOLATIONS.INDETERMINATE_MODEL:
      return DISPATCH_ADMISSION_CODES.AI_MODEL_IDENTITY_INDETERMINATE;
    case EVALUATION_VIOLATIONS.UNAPPROVED_FALLBACK:
      return DISPATCH_ADMISSION_CODES.AI_FALLBACK_NOT_AUTHORIZED;
    case EVALUATION_VIOLATIONS.FALLBACK_DOWNGRADE_FORBIDDEN:
      return DISPATCH_ADMISSION_CODES.AI_FALLBACK_ASSURANCE_DOWNGRADE;
    case EVALUATION_VIOLATIONS.FINAL_AUDITOR_ASSURANCE_REQUIRED:
      return DISPATCH_ADMISSION_CODES.AI_FINAL_AUDITOR_UNAVAILABLE;
    case EVALUATION_VIOLATIONS.FINAL_AUDITOR_WRITE_ROOT_FORBIDDEN:
    case EVALUATION_VIOLATIONS.FINAL_AUDITOR_FRESH_SESSION_REQUIRED:
    case EVALUATION_VIOLATIONS.FINAL_AUDITOR_LINEAGE_NOT_DISJOINT:
      return DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT;
    case EVALUATION_VIOLATIONS.INVALID_ROLE:
    case EVALUATION_VIOLATIONS.INVALID_ASSURANCE:
    case EVALUATION_VIOLATIONS.ROLE_ASSURANCE_MISMATCH:
    case EVALUATION_VIOLATIONS.ROLE_EXPLICITLY_DENIED:
    case EVALUATION_VIOLATIONS.ROLE_NOT_ELIGIBLE:
    case EVALUATION_VIOLATIONS.INSUFFICIENT_CAPABILITIES:
    case EVALUATION_VIOLATIONS.INSUFFICIENT_ASSURANCE_FOR_RISK:
    case EVALUATION_VIOLATIONS.SELECTION_BINDING_MISMATCH:
    case EVALUATION_VIOLATIONS.SELECTION_PROVIDER_MISMATCH:
    case EVALUATION_VIOLATIONS.SELECTION_MODEL_MISMATCH:
    case EVALUATION_VIOLATIONS.SELECTION_EFFORT_MISMATCH:
    case EVALUATION_VIOLATIONS.SELECTION_VARIANT_MISMATCH:
    case EVALUATION_VIOLATIONS.SELECTION_AGENT_MISMATCH:
    case EVALUATION_VIOLATIONS.SELECTION_REVISION_MISMATCH:
    case EVALUATION_VIOLATIONS.DIGEST_APPROVAL_MISMATCH:
    case EVALUATION_VIOLATIONS.DIGEST_CALIBRATION_MISMATCH:
    case EVALUATION_VIOLATIONS.DIGEST_EXECUTABLE_IDENTITY_MISMATCH:
    case EVALUATION_VIOLATIONS.COORDINATOR_SELF_ACCEPT_FORBIDDEN:
    default:
      return DISPATCH_ADMISSION_CODES.AI_MODEL_ROLE_INELIGIBLE;
  }
}

function sanitizeAdmissionViolation(violation, fallbackCode) {
  const code = violation.canonicalCode || mapR1ViolationToCanonical(violation) || fallbackCode;
  const rawMsg = String(violation.message || '');
  // Sanitize path or secret information from message
  const sanitizedMsg = rawMsg
    .replace(/\/[\w./-]+/g, '[PATH]')
    .replace(/sha256:[0-9a-f]{64}/gi, '[DIGEST]');

  return Object.freeze({
    code,
    message: sanitizedMsg || 'Admission policy violation',
    field: String(violation.field || ''),
  });
}

/**
 * Pure, deterministic dispatch admission evaluator.
 * Wraps R1 evaluateModelRoleEligibility / validateRolePolicy / validateManagedBinding.
 * No filesystem, network, provider, child, writable workspace or journal side effects.
 */
export function evaluateDispatchAdmission({
  task,
  policy = DEFAULT_ROLE_POLICY,
  binding = null,
  selection = {},
  adapterId = null,
  lineage = [],
  trustedLineage = null,
  now = Date.now(),
} = {}) {
  const violations = [];
  const evaluatedAt = new Date(typeof now === 'number' && Number.isFinite(now) ? now : Date.now()).toISOString();

  // 1. Guard against missing/invalid task
  if (!isPlainObject(task)) {
    violations.push({
      canonicalCode: DISPATCH_ADMISSION_CODES.AI_ROLE_POLICY_REQUIRED,
      message: 'Task definition is required and must be an object',
      field: 'task',
    });
    return deepFreeze({
      eligible: false,
      canonicalCode: DISPATCH_ADMISSION_CODES.AI_ROLE_POLICY_REQUIRED,
      role: null,
      assurance: null,
      riskTier: null,
      policyDigest: null,
      bindingId: null,
      provider: null,
      agent: null,
      requestedModel: null,
      actualModel: 'indeterminate',
      effort: null,
      variant: null,
      rolePolicyRevision: null,
      modelBindingRevision: null,
      bindingRevision: null,
      fallbackFrom: null,
      fallbackDecision: 'denied',
      contributorLineageDigest: null,
      sessionFreshness: 'unspecified',
      decision: 'denied',
      violations: Object.freeze(violations.map((v) => sanitizeAdmissionViolation(v, DISPATCH_ADMISSION_CODES.AI_ROLE_POLICY_REQUIRED))),
      evaluatedAt,
      isLegacy: false,
    });
  }

  // 2. Validate policy strictly - never silently fall back
  let validatedPolicy = null;
  if (policy) {
    try {
      validatedPolicy = validateRolePolicy(policy);
    } catch {
      violations.push({
        canonicalCode: DISPATCH_ADMISSION_CODES.AI_ROLE_POLICY_REQUIRED,
        message: 'Role policy is invalid or malformed',
        field: 'policy',
      });
    }
  } else {
    violations.push({
      canonicalCode: DISPATCH_ADMISSION_CODES.AI_ROLE_POLICY_REQUIRED,
      message: 'Role policy is required',
      field: 'policy',
    });
  }

  const isVersioned = task.packetVersion !== undefined;
  const isFinalAuditor = task.role === 'final-auditor';

  // Unsupported packetVersion check in pure admission path
  if (isVersioned && task.packetVersion !== TASK_PACKET_PROTOCOL_V1_R2) {
    violations.push({
      canonicalCode: DISPATCH_ADMISSION_CODES.AI_ROLE_POLICY_REQUIRED,
      message: `Unsupported task packetVersion ${String(task.packetVersion)}; expected ${TASK_PACKET_PROTOCOL_V1_R2}`,
      field: 'task.packetVersion',
    });
  }

  // Legacy callers (packetVersion-less and not final-auditor and no managed binding)
  if (!isVersioned && !isFinalAuditor && !binding) {
    return deepFreeze({
      eligible: true,
      canonicalCode: null,
      role: isClosedRole(task.role) ? task.role : 'observer',
      assurance: isClosedAssurance(task.assurance) ? task.assurance : null,
      riskTier: task.riskTier ?? null,
      policyDigest: null,
      bindingId: null,
      provider: selection?.targetProvider ?? selection?.provider ?? null,
      agent: selection?.expectedAgent ?? selection?.agent ?? null,
      requestedModel: selection?.targetModel ?? selection?.model ?? selection?.requestedModel ?? null,
      actualModel: selection?.targetModel ?? selection?.model ?? 'indeterminate',
      effort: selection?.expectedEffort ?? selection?.effort ?? null,
      variant: selection?.expectedVariant ?? selection?.variant ?? null,
      rolePolicyRevision: null,
      modelBindingRevision: null,
      bindingRevision: null,
      fallbackFrom: null,
      fallbackDecision: 'none',
      contributorLineageDigest: null,
      sessionFreshness: 'unspecified',
      decision: 'eligible',
      violations: Object.freeze([]),
      evaluatedAt,
      isLegacy: true,
    });
  }

  // Versioned packets strictly require role, riskTier, modelRequirements
  if (isVersioned) {
    if (!isClosedRole(task.role)) {
      violations.push({
        canonicalCode: DISPATCH_ADMISSION_CODES.AI_MODEL_ROLE_INELIGIBLE,
        message: 'Task role must be a closed role for versioned packet',
        field: 'task.role',
      });
    }
    if (typeof task.riskTier !== 'string' || !CLOSED_RISK_TIERS.includes(task.riskTier)) {
      violations.push({
        canonicalCode: DISPATCH_ADMISSION_CODES.AI_MODEL_ROLE_INELIGIBLE,
        message: 'Task riskTier must be one of closed risk tiers for versioned packet',
        field: 'task.riskTier',
      });
    }
    if (!task.modelRequirements || !isPlainObject(task.modelRequirements)) {
      violations.push({
        canonicalCode: DISPATCH_ADMISSION_CODES.AI_ROLE_POLICY_REQUIRED,
        message: 'Task modelRequirements is required for versioned packet',
        field: 'task.modelRequirements',
      });
    }
  }

  // Versioned packets and final-auditor packets strictly require managed binding
  let validatedBinding = null;
  if (!isPlainObject(binding)) {
    violations.push({
      canonicalCode: isFinalAuditor
        ? DISPATCH_ADMISSION_CODES.AI_FINAL_AUDITOR_UNAVAILABLE
        : DISPATCH_ADMISSION_CODES.AI_MODEL_BINDING_UNAVAILABLE,
      message: 'Managed model binding is required for admission',
      field: 'binding',
    });
  } else {
    try {
      validatedBinding = validateManagedBinding(binding, { now });
    } catch {
      const indeterminateModel = Object.prototype.hasOwnProperty.call(binding, 'model')
        && !isModelDeterminate(binding.model);
      violations.push({
        canonicalCode: indeterminateModel
          ? DISPATCH_ADMISSION_CODES.AI_MODEL_IDENTITY_INDETERMINATE
          : (isFinalAuditor
            ? DISPATCH_ADMISSION_CODES.AI_FINAL_AUDITOR_UNAVAILABLE
            : DISPATCH_ADMISSION_CODES.AI_MODEL_BINDING_UNAVAILABLE),
        message: 'Managed model binding validation failed',
        field: 'binding',
      });
    }
  }

  // Normalize task packet fields to R1 evaluator shape
  const effectiveAssurance = task.assurance ?? task.modelRequirements?.minimumAssurance ?? null;
  const effectiveCaps = task.requiredCapabilities ?? task.modelRequirements?.requiredCapabilities ?? null;
  const independencePolicy = task.independencePolicy ?? {};
  const normalizedTask = {
    ...task,
    assurance: effectiveAssurance,
    ...(effectiveCaps ? { requiredCapabilities: effectiveCaps } : {}),
    ...(isFinalAuditor
      ? {
        freshSession: task.freshSession ?? independencePolicy.freshSession ?? independencePolicy.requireFresh,
        readOnly: task.readOnly ?? independencePolicy.readOnly,
      }
      : {}),
  };

  // Revisions parity checks
  const effectivePolicy = validatedPolicy;
  const effectivePolicyDigest = effectivePolicy ? computePolicyDigest(effectivePolicy) : null;
  if (task.rolePolicyRevision !== undefined && task.rolePolicyRevision !== null && effectivePolicy) {
    const matchesRevision = task.rolePolicyRevision === effectivePolicyDigest
      || task.rolePolicyRevision === effectivePolicy.revision
      || (effectivePolicy.revision !== undefined
        && String(task.rolePolicyRevision) === String(effectivePolicy.revision));
    if (!matchesRevision) {
      violations.push({
        canonicalCode: DISPATCH_ADMISSION_CODES.AI_ROLE_POLICY_DIGEST_MISMATCH,
        message: 'Task rolePolicyRevision does not match the active policy digest or revision',
        field: 'task.rolePolicyRevision',
      });
    }
  }

  const effectiveBinding = validatedBinding;
  const effectiveBindingDigest = effectiveBinding ? computeBindingDigest(effectiveBinding) : null;
  if (effectiveBinding) {
    if (adapterId !== null && effectiveBinding.adapterId !== adapterId) {
      violations.push({
        canonicalCode: DISPATCH_ADMISSION_CODES.AI_MODEL_ROLE_INELIGIBLE,
        message: 'Managed model binding is not issued for the selected adapter',
        field: 'binding.adapterId',
      });
    }
    if (!isModelDeterminate(effectiveBinding.model)) {
      violations.push({
        canonicalCode: DISPATCH_ADMISSION_CODES.AI_MODEL_IDENTITY_INDETERMINATE,
        message: 'Model identity is indeterminate or unanchored',
        field: 'binding.model',
      });
    }

    if (task.modelBindingRevision !== undefined && task.modelBindingRevision !== null) {
      const matchesRevision = task.modelBindingRevision === effectiveBindingDigest
        || task.modelBindingRevision === effectiveBinding.revision
        || String(task.modelBindingRevision) === String(effectiveBinding.revision);
      if (!matchesRevision) {
        violations.push({
          canonicalCode: DISPATCH_ADMISSION_CODES.AI_ROLE_POLICY_DIGEST_MISMATCH,
          message: 'Task modelBindingRevision does not match the active binding digest or revision',
          field: 'task.modelBindingRevision',
        });
      }
    }
    if (task.bindingRevision !== undefined && task.bindingRevision !== null) {
      if (effectiveBinding.revision !== task.bindingRevision
        && String(effectiveBinding.revision) !== String(task.bindingRevision)) {
        violations.push({
          canonicalCode: DISPATCH_ADMISSION_CODES.AI_MODEL_ROLE_INELIGIBLE,
          message: 'Task bindingRevision does not match binding revision',
          field: 'task.bindingRevision',
        });
      }
    }

    // Explicit model matching: selection requested model vs binding model
    const requestedModel = selection.targetModel ?? selection.model ?? selection.requestedModel ?? null;
    if (requestedModel !== null && requestedModel !== effectiveBinding.model) {
      violations.push({
        canonicalCode: DISPATCH_ADMISSION_CODES.AI_MODEL_ROLE_INELIGIBLE,
        message: 'Requested selection model does not match binding model',
        field: 'selection.model',
      });
    }

    const requestedProvider = selection.targetProvider ?? selection.provider ?? null;
    if (requestedProvider !== null && requestedProvider !== effectiveBinding.provider) {
      violations.push({
        canonicalCode: DISPATCH_ADMISSION_CODES.AI_MODEL_ROLE_INELIGIBLE,
        message: 'Requested selection provider does not match binding provider',
        field: 'selection.provider',
      });
    }

    const requestedEffort = selection.expectedEffort ?? selection.effort ?? null;
    if (requestedEffort !== null && effectiveBinding.effort !== undefined && requestedEffort !== effectiveBinding.effort) {
      violations.push({
        canonicalCode: DISPATCH_ADMISSION_CODES.AI_MODEL_ROLE_INELIGIBLE,
        message: 'Requested selection effort does not match binding effort',
        field: 'selection.effort',
      });
    }

    const requestedVariant = selection.expectedVariant ?? selection.variant ?? null;
    if (requestedVariant !== null && effectiveBinding.variant !== undefined && requestedVariant !== effectiveBinding.variant) {
      violations.push({
        canonicalCode: DISPATCH_ADMISSION_CODES.AI_MODEL_ROLE_INELIGIBLE,
        message: 'Requested selection variant does not match binding variant',
        field: 'selection.variant',
      });
    }

    // Fallback policy check
    const isFallback = selection.isFallback || selection.fallback;
    if (isFallback) {
      const fallbackPolicy = task.fallbackPolicy ?? {};
      const authorizedFallbackChain = Array.isArray(fallbackPolicy.allowedBindingIds)
        ? fallbackPolicy.allowedBindingIds
        : fallbackPolicy.fallbackChain;
      const allowFallback = fallbackPolicy.allowFallback === true
        || (Array.isArray(authorizedFallbackChain)
          && authorizedFallbackChain.includes(effectiveBinding.bindingId));
      if (!allowFallback) {
        violations.push({
          canonicalCode: DISPATCH_ADMISSION_CODES.AI_FALLBACK_NOT_AUTHORIZED,
          message: 'Fallback selection was attempted without explicit authorization in policy',
          field: 'task.fallbackPolicy.allowFallback',
        });
      }

      if (Array.isArray(authorizedFallbackChain)) {
        if (!authorizedFallbackChain.includes(effectiveBinding.bindingId)) {
          violations.push({
            canonicalCode: DISPATCH_ADMISSION_CODES.AI_FALLBACK_NOT_AUTHORIZED,
            message: 'Candidate model binding is not authorized in fallbackChain',
            field: 'task.fallbackPolicy.allowedBindingIds',
          });
        }
      }

      const primaryAssurance = fallbackPolicy.primaryAssurance ?? selection.primaryAssurance ?? null;
      if (primaryAssurance && isClosedAssurance(primaryAssurance) && effectiveAssurance) {
        const primaryRank = ASSURANCE_RANK[primaryAssurance] ?? 0;
        const candidateRank = ASSURANCE_RANK[effectiveAssurance] ?? 0;
        if (candidateRank < primaryRank) {
          violations.push({
            canonicalCode: DISPATCH_ADMISSION_CODES.AI_FALLBACK_ASSURANCE_DOWNGRADE,
            message: 'Fallback selection results in unauthorized assurance downgrade',
            field: 'selection.primaryAssurance',
          });
        }
      }
    }
  }

  // Reconcile trusted lineage records
  let trustedRecords = [];
  if (trustedLineage) {
    const rawRecords = Array.isArray(trustedLineage)
      ? trustedLineage
      : (Array.isArray(trustedLineage.records) ? trustedLineage.records : []);
    try {
      trustedRecords = rawRecords.map((r) => validateLineageRecord(r));
    } catch {
      violations.push({
        canonicalCode: DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT,
        message: 'Trusted lineage contains malformed or unverified records',
        field: 'trustedLineage',
      });
    }
  }

  // Final auditor strict independence checks
  if (isFinalAuditor) {
    if (effectiveAssurance !== 'release-final') {
      violations.push({
        canonicalCode: DISPATCH_ADMISSION_CODES.AI_FINAL_AUDITOR_UNAVAILABLE,
        message: 'Final auditor role strictly requires release-final assurance',
        field: 'task.assurance',
      });
    }
    const isAttestedFresh = selection?.sessionFreshness === 'fresh' && selection?.isReusedSession !== true;
    const isPolicyFresh = (task.freshSession === true || independencePolicy.freshSession === true || independencePolicy.requireFresh === true)
      && task.isReusedSession !== true && independencePolicy.isReusedSession !== true
      && task.freshSession !== false && independencePolicy.freshSession !== false;
    const isAuditorFresh = isAttestedFresh && isPolicyFresh;
    if (!isAuditorFresh) {
      violations.push({
        canonicalCode: DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT,
        message: 'Final auditor must execute in a fresh independent session',
        field: 'sessionFreshness',
      });
    }
    const hasWriteRoots = (Array.isArray(task.allowedWriteRoots) && task.allowedWriteRoots.length > 0)
      || task.writeRoot === true || task.allowWrite === true || task.readOnly === false || independencePolicy.readOnly === false;
    if (hasWriteRoots || (task.readOnly !== true && independencePolicy.readOnly !== true)) {
      violations.push({
        canonicalCode: DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT,
        message: 'Final auditor role must be strictly read-only with no write roots',
        field: 'task.allowedWriteRoots',
      });
    }

    const candidateFacts = {
      dispatchId: selection.dispatchId ?? null,
      role: 'final-auditor',
      provider: effectiveBinding?.provider ?? null,
      model: effectiveBinding?.model ?? null,
      agent: typeof effectiveBinding?.agent === 'string'
        ? effectiveBinding.agent
        : (effectiveBinding?.agent?.id ?? selection.expectedAgent ?? selection.agent ?? null),
      bindingId: effectiveBinding?.bindingId ?? null,
      sessionFreshness: selection?.sessionFreshness ?? (isAuditorFresh ? 'fresh' : 'unspecified'),
      readOnly: !hasWriteRoots && (task.readOnly === true || independencePolicy.readOnly === true),
      writeRoots: task.allowedWriteRoots ?? [],
      isReusedSession: !isAuditorFresh || selection?.isReusedSession === true,
    };

    const indepCheck = checkLineageIndependence({
      candidate: candidateFacts,
      trustedRecords,
      taskPolicy: {
        ...independencePolicy,
        freshSession: isAuditorFresh,
        readOnly: !hasWriteRoots && (task.readOnly === true || independencePolicy.readOnly === true),
        allowedWriteRoots: task.allowedWriteRoots ?? [],
      },
    });

    if (!indepCheck.independent) {
      for (const v of indepCheck.violations) {
        violations.push({
          canonicalCode: v.code || DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT,
          message: v.message,
          field: v.field,
        });
      }
    }
  }

  // Evaluate with R1 evaluator if binding and policy are available
  let r1Result = null;
  if (effectiveBinding && effectivePolicy) {
    const fallbackPolicy = task.fallbackPolicy ?? {};
    const authorizedFallbackChain = Array.isArray(fallbackPolicy.allowedBindingIds)
      ? fallbackPolicy.allowedBindingIds
      : fallbackPolicy.fallbackChain;
    const isFallback = selection.isFallback || selection.fallback;
    const evaluatorSelection = {
      ...selection,
      ...(task.rolePolicyRevision !== undefined && selection.expectedPolicyDigest === undefined
        ? { expectedPolicyDigest: task.rolePolicyRevision }
        : {}),
      ...(task.bindingRevision !== undefined && selection.expectedRevision === undefined
        ? { expectedRevision: task.bindingRevision }
        : {}),
      ...(isFallback
        ? {
          allowFallback: fallbackPolicy.allowFallback === true
            || (Array.isArray(authorizedFallbackChain)
              && authorizedFallbackChain.includes(effectiveBinding.bindingId)),
          ...(Array.isArray(authorizedFallbackChain) && selection.fallbackChain === undefined
            ? { fallbackChain: authorizedFallbackChain }
            : {}),
        }
        : {}),
    };

    const evaluatorLineage = isFinalAuditor
      ? trustedRecords.map((r) => ({
          role: r.role,
          model: r.model,
          provider: r.provider,
          bindingId: r.bindingId,
          agentId: r.agent,
        }))
      : (trustedRecords.length > 0
          ? trustedRecords.map((r) => ({
              role: r.role,
              model: r.model,
              provider: r.provider,
              bindingId: r.bindingId,
              agentId: r.agent,
            }))
          : lineage);

    r1Result = evaluateModelRoleEligibility({
      task: normalizedTask,
      policy: effectivePolicy,
      binding: effectiveBinding,
      selection: evaluatorSelection,
      lineage: evaluatorLineage,
      now,
    });

    if (!r1Result.eligible) {
      for (const v of r1Result.violations) {
        violations.push({
          canonicalCode: mapR1ViolationToCanonical(v),
          message: v.message,
          field: v.field,
        });
      }
    }
  }

  // Compute contributorLineageDigest
  let contributorLineageDigest = null;
  if (trustedRecords.length > 0) {
    try {
      contributorLineageDigest = computeCanonicalDigest(
        trustedRecords.map((r) => r.contributorDigest || computeContributorDigest(r)),
      );
    } catch {
      contributorLineageDigest = null;
    }
  } else if (!isFinalAuditor && Array.isArray(lineage) && lineage.length > 0) {
    try {
      contributorLineageDigest = computeCanonicalDigest(lineage);
    } catch {
      contributorLineageDigest = null;
    }
  }

  const CANONICAL_PRIORITY = {
    [DISPATCH_ADMISSION_CODES.AI_ROLE_POLICY_REQUIRED]: 1,
    [DISPATCH_ADMISSION_CODES.AI_ROLE_POLICY_DIGEST_MISMATCH]: 2,
    [DISPATCH_ADMISSION_CODES.AI_FINAL_AUDITOR_UNAVAILABLE]: 3,
    [DISPATCH_ADMISSION_CODES.AI_AUDITOR_NOT_INDEPENDENT]: 4,
    [DISPATCH_ADMISSION_CODES.AI_FALLBACK_ASSURANCE_DOWNGRADE]: 5,
    [DISPATCH_ADMISSION_CODES.AI_FALLBACK_NOT_AUTHORIZED]: 6,
    [DISPATCH_ADMISSION_CODES.AI_MODEL_IDENTITY_INDETERMINATE]: 7,
    [DISPATCH_ADMISSION_CODES.AI_MODEL_BINDING_UNAVAILABLE]: 8,
    [DISPATCH_ADMISSION_CODES.AI_MODEL_ROLE_INELIGIBLE]: 9,
  };

  const isEligible = violations.length === 0;
  const sortedViolations = [...violations].sort((a, b) => {
    const prioA = CANONICAL_PRIORITY[a.canonicalCode] ?? 99;
    const prioB = CANONICAL_PRIORITY[b.canonicalCode] ?? 99;
    return prioA - prioB;
  });
  const primaryCanonicalCode = isEligible
    ? null
    : (sortedViolations[0]?.canonicalCode || DISPATCH_ADMISSION_CODES.AI_MODEL_ROLE_INELIGIBLE);

  const role = r1Result?.role ?? (isClosedRole(task.role) ? task.role : null);
  const assurance = r1Result?.assurance ?? (isClosedAssurance(effectiveAssurance) ? effectiveAssurance : null);
  const riskTier = task.riskTier ?? null;
  const policyDigest = r1Result?.policyDigest ?? effectivePolicyDigest;
  const bindingId = r1Result?.bindingId ?? effectiveBinding?.bindingId ?? null;
  const provider = isEligible ? (effectiveBinding?.provider ?? null) : null;
  const agent = typeof effectiveBinding?.agent === 'string'
    ? effectiveBinding.agent
    : (effectiveBinding?.agent?.id ?? selection.expectedAgent ?? selection.agent ?? null);
  const requestedModel = selection.requestedModel ?? selection.targetModel ?? selection.model ?? null;
  const actualModel = isEligible ? (effectiveBinding?.model ?? 'indeterminate') : 'indeterminate';
  const effort = effectiveBinding?.effort ?? selection.expectedEffort ?? selection.effort ?? null;
  const variant = effectiveBinding?.variant ?? selection.expectedVariant ?? selection.variant ?? null;
  const fallbackFrom = selection.fallbackFrom ?? (selection.isFallback ? (selection.fallbackFromBindingId ?? 'previous') : null);
  const fallbackDecision = selection.isFallback
    ? (isEligible ? 'fallback-authorized' : 'denied')
    : (isEligible ? 'none' : 'denied');

  const isAuditorFreshAttested = isFinalAuditor
    && selection?.sessionFreshness === 'fresh'
    && selection?.isReusedSession !== true
    && (task.freshSession === true || independencePolicy.freshSession === true || independencePolicy.requireFresh === true)
    && task.isReusedSession !== true && independencePolicy.isReusedSession !== true
    && task.freshSession !== false && independencePolicy.freshSession !== false;

  const sessionFreshness = isFinalAuditor
    ? (isAuditorFreshAttested ? 'fresh' : (selection?.sessionFreshness ?? 'unspecified'))
    : (selection?.sessionFreshness ?? ((task.freshSession === true || independencePolicy.freshSession === true) ? 'fresh' : (isVersioned ? 'not-required' : 'unspecified')));

  const sanitizedViolations = violations.map((v) => sanitizeAdmissionViolation(v, primaryCanonicalCode));

  return deepFreeze({
    eligible: isEligible,
    canonicalCode: primaryCanonicalCode,
    role,
    assurance,
    riskTier,
    policyDigest,
    bindingId,
    provider,
    agent,
    requestedModel,
    actualModel,
    effort,
    variant,
    rolePolicyRevision: task.rolePolicyRevision ?? effectivePolicyDigest,
    modelBindingRevision: task.modelBindingRevision ?? effectiveBindingDigest,
    bindingRevision: task.bindingRevision ?? effectiveBinding?.revision ?? null,
    fallbackFrom,
    fallbackDecision,
    contributorLineageDigest,
    sessionFreshness,
    decision: isEligible ? 'eligible' : 'denied',
    violations: Object.freeze(sanitizedViolations),
    evaluatedAt,
    isLegacy: false,
  });
}

/**
 * Asserts that dispatch admission succeeds, throwing AiCliError('POLICY_DENIED') if not.
 */
export function assertDispatchAdmission(params) {
  const result = evaluateDispatchAdmission(params);
  if (!result.eligible) {
    const summary = result.violations.map((v) => v.message).join('; ') || 'Admission failed';
    throw new AiCliError('POLICY_DENIED', `Dispatch admission denied: ${summary}`, {
      exitCode: 2,
      details: {
        code: result.canonicalCode,
        violations: result.violations.map((v) => ({ code: v.code, field: v.field })),
        role: result.role,
        assurance: result.assurance,
      },
    });
  }
  return result;
}
