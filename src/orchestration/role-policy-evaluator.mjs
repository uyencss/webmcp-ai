import { AiCliError } from '../errors.mjs';
import {
  ASSURANCE_RANK,
  CLOSED_ASSURANCES,
  CLOSED_ROLES,
  DEFAULT_ROLE_POLICY,
  computePolicyDigest,
  deepFreeze,
  isClosedAssurance,
  isClosedRole,
  isPlainObject,
  validateRolePolicy,
} from './role-policy.mjs';
import {
  isModelDeterminate,
  validateManagedBinding,
} from './managed-binding.mjs';

export const EVALUATION_VIOLATIONS = Object.freeze({
  TASK_REQUIRED: 'TASK_REQUIRED',
  BINDING_REQUIRED: 'BINDING_REQUIRED',
  INVALID_ROLE_POLICY: 'INVALID_ROLE_POLICY',
  INVALID_BINDING: 'INVALID_BINDING',
  BINDING_EXPIRED: 'BINDING_EXPIRED',
  INVALID_ROLE: 'INVALID_ROLE',
  INVALID_ASSURANCE: 'INVALID_ASSURANCE',
  ROLE_ASSURANCE_MISMATCH: 'ROLE_ASSURANCE_MISMATCH',
  ROLE_EXPLICITLY_DENIED: 'ROLE_EXPLICITLY_DENIED',
  ROLE_NOT_ELIGIBLE: 'ROLE_NOT_ELIGIBLE',
  INDETERMINATE_MODEL: 'INDETERMINATE_MODEL',
  INSUFFICIENT_CAPABILITIES: 'INSUFFICIENT_CAPABILITIES',
  INSUFFICIENT_ASSURANCE_FOR_RISK: 'INSUFFICIENT_ASSURANCE_FOR_RISK',
  SELECTION_BINDING_MISMATCH: 'SELECTION_BINDING_MISMATCH',
  SELECTION_PROVIDER_MISMATCH: 'SELECTION_PROVIDER_MISMATCH',
  SELECTION_MODEL_MISMATCH: 'SELECTION_MODEL_MISMATCH',
  SELECTION_EFFORT_MISMATCH: 'SELECTION_EFFORT_MISMATCH',
  SELECTION_VARIANT_MISMATCH: 'SELECTION_VARIANT_MISMATCH',
  SELECTION_AGENT_MISMATCH: 'SELECTION_AGENT_MISMATCH',
  SELECTION_REVISION_MISMATCH: 'SELECTION_REVISION_MISMATCH',
  DIGEST_APPROVAL_MISMATCH: 'DIGEST_APPROVAL_MISMATCH',
  DIGEST_CALIBRATION_MISMATCH: 'DIGEST_CALIBRATION_MISMATCH',
  DIGEST_EXECUTABLE_IDENTITY_MISMATCH: 'DIGEST_EXECUTABLE_IDENTITY_MISMATCH',
  DIGEST_POLICY_MISMATCH: 'DIGEST_POLICY_MISMATCH',
  UNAPPROVED_FALLBACK: 'UNAPPROVED_FALLBACK',
  FALLBACK_DOWNGRADE_FORBIDDEN: 'FALLBACK_DOWNGRADE_FORBIDDEN',
  COORDINATOR_SELF_ACCEPT_FORBIDDEN: 'COORDINATOR_SELF_ACCEPT_FORBIDDEN',
  FINAL_AUDITOR_ASSURANCE_REQUIRED: 'FINAL_AUDITOR_ASSURANCE_REQUIRED',
  FINAL_AUDITOR_WRITE_ROOT_FORBIDDEN: 'FINAL_AUDITOR_WRITE_ROOT_FORBIDDEN',
  FINAL_AUDITOR_FRESH_SESSION_REQUIRED: 'FINAL_AUDITOR_FRESH_SESSION_REQUIRED',
  FINAL_AUDITOR_LINEAGE_NOT_DISJOINT: 'FINAL_AUDITOR_LINEAGE_NOT_DISJOINT',
});

function sanitizeViolation(violation) {
  return Object.freeze({
    code: violation.code,
    message: String(violation.message || ''),
    field: String(violation.field || ''),
  });
}

/**
 * Pure evaluator for Model Role Eligibility under webmcp-ai-role-policy/1.
 * Inputs are immutable and never modified.
 * No provider, filesystem, network, permit or Runner side effects.
 */
export function evaluateModelRoleEligibility({
  task,
  policy = DEFAULT_ROLE_POLICY,
  binding,
  selection = {},
  lineage = [],
  now = Date.now(),
} = {}) {
  const violations = [];

  // 1. Guard against missing task or binding
  if (!isPlainObject(task)) {
    violations.push({
      code: EVALUATION_VIOLATIONS.TASK_REQUIRED,
      message: 'Task definition is required and must be an object',
      field: 'task',
    });
    return deepFreeze({
      eligible: false,
      role: null,
      assurance: null,
      policyDigest: null,
      bindingId: null,
      violations: Object.freeze(violations.map(sanitizeViolation)),
      evaluatedAt: new Date(typeof now === 'number' && Number.isFinite(now) ? now : Date.now()).toISOString(),
    });
  }

  if (!isPlainObject(binding)) {
    violations.push({
      code: EVALUATION_VIOLATIONS.BINDING_REQUIRED,
      message: 'Managed model binding is required and must be an object',
      field: 'binding',
    });
    return deepFreeze({
      eligible: false,
      role: isClosedRole(task?.role) ? task.role : null,
      assurance: isClosedAssurance(task?.assurance) ? task.assurance : null,
      policyDigest: null,
      bindingId: null,
      violations: Object.freeze(violations.map(sanitizeViolation)),
      evaluatedAt: new Date(typeof now === 'number' && Number.isFinite(now) ? now : Date.now()).toISOString(),
    });
  }

  // 2. Validate Policy - Fail Closed if invalid
  let activePolicy = null;
  let policyDigest = null;
  try {
    activePolicy = validateRolePolicy(policy);
    policyDigest = computePolicyDigest(activePolicy);
  } catch {
    activePolicy = null;
    policyDigest = null;
    violations.push({
      code: EVALUATION_VIOLATIONS.INVALID_ROLE_POLICY,
      message: 'Role policy failed schema, constraint or portability validation',
      field: 'policy',
    });
  }

  // 3. Validate Binding - Fail Closed if invalid
  let activeBinding = null;
  try {
    activeBinding = validateManagedBinding(binding, { now });
  } catch (error) {
    activeBinding = null;
    if (error?.details?.expired) {
      violations.push({
        code: EVALUATION_VIOLATIONS.BINDING_EXPIRED,
        message: 'Managed model binding has expired',
        field: 'binding.expiresAt',
      });
    } else {
      violations.push({
        code: EVALUATION_VIOLATIONS.INVALID_BINDING,
        message: 'Managed model binding failed validation or contains invalid fields',
        field: 'binding',
      });
    }
  }

  const taskRole = task.role;
  const taskAssurance = task.assurance;

  // 4. Validate Task Role & Assurance (Closed Enums)
  const isRoleValid = isClosedRole(taskRole);
  if (!isRoleValid) {
    violations.push({
      code: EVALUATION_VIOLATIONS.INVALID_ROLE,
      message: 'Task role is not a recognized closed role',
      field: 'task.role',
    });
  }

  const isAssuranceValid = isClosedAssurance(taskAssurance);
  if (!isAssuranceValid) {
    violations.push({
      code: EVALUATION_VIOLATIONS.INVALID_ASSURANCE,
      message: 'Task assurance is not a recognized closed assurance',
      field: 'task.assurance',
    });
  }

  // Check role-assurance compatibility under active validated policy
  if (isRoleValid && isAssuranceValid && activePolicy?.roles?.[taskRole]) {
    const roleConfig = activePolicy.roles[taskRole];
    const allowedAssurances = roleConfig.allowedAssurances || [];
    if (!allowedAssurances.includes(taskAssurance)) {
      violations.push({
        code: EVALUATION_VIOLATIONS.ROLE_ASSURANCE_MISMATCH,
        message: 'Task assurance level is not allowed for this role under current policy',
        field: 'task.assurance',
      });
    }
  }

  // 5. Downstream checks that require active validated binding
  if (activeBinding) {
    // Role eligibility & denied roles
    if (isRoleValid) {
      const deniedRoles = Array.isArray(activeBinding.deniedRoles) ? activeBinding.deniedRoles : [];
      if (deniedRoles.includes(taskRole)) {
        violations.push({
          code: EVALUATION_VIOLATIONS.ROLE_EXPLICITLY_DENIED,
          message: 'Task role is explicitly denied in model binding',
          field: 'binding.deniedRoles',
        });
      }

      const eligibleRoles = Array.isArray(activeBinding.eligibleRoles) ? activeBinding.eligibleRoles : [];
      if (!eligibleRoles.includes(taskRole)) {
        violations.push({
          code: EVALUATION_VIOLATIONS.ROLE_NOT_ELIGIBLE,
          message: 'Task role is not present in model binding eligible roles',
          field: 'binding.eligibleRoles',
        });
      }
    }

    // Determinate model check
    if (!isModelDeterminate(activeBinding.model)) {
      violations.push({
        code: EVALUATION_VIOLATIONS.INDETERMINATE_MODEL,
        message: 'Model in binding is indeterminate or wildcard',
        field: 'binding.model',
      });
    }

    // Capabilities check
    if (task.requiredCapabilities) {
      const required = Array.isArray(task.requiredCapabilities) ? task.requiredCapabilities : [task.requiredCapabilities];
      let availableCaps = [];
      if (Array.isArray(activeBinding.capabilityTier)) {
        availableCaps = activeBinding.capabilityTier;
      } else if (isPlainObject(activeBinding.capabilityTier)) {
        availableCaps = Object.keys(activeBinding.capabilityTier).filter((k) => Boolean(activeBinding.capabilityTier[k]));
      } else if (typeof activeBinding.capabilityTier === 'string') {
        availableCaps = [activeBinding.capabilityTier];
      }
      const availableSet = new Set(availableCaps);
      const missing = required.filter((cap) => !availableSet.has(cap));
      if (missing.length > 0) {
        violations.push({
          code: EVALUATION_VIOLATIONS.INSUFFICIENT_CAPABILITIES,
          message: 'Binding does not satisfy all required task capabilities',
          field: 'task.requiredCapabilities',
        });
      }
    }

    // Exact selection criteria matching
    if (isPlainObject(selection)) {
      if (selection.expectedBindingId !== undefined && selection.expectedBindingId !== activeBinding.bindingId) {
        violations.push({
          code: EVALUATION_VIOLATIONS.SELECTION_BINDING_MISMATCH,
          message: 'Binding ID does not match expected selection binding ID',
          field: 'selection.expectedBindingId',
        });
      }

      if (selection.targetProvider !== undefined && selection.targetProvider !== activeBinding.provider) {
        violations.push({
          code: EVALUATION_VIOLATIONS.SELECTION_PROVIDER_MISMATCH,
          message: 'Binding provider does not match expected selection provider',
          field: 'selection.targetProvider',
        });
      }

      if (selection.targetModel !== undefined && selection.targetModel !== activeBinding.model) {
        violations.push({
          code: EVALUATION_VIOLATIONS.SELECTION_MODEL_MISMATCH,
          message: 'Binding model does not match expected selection model',
          field: 'selection.targetModel',
        });
      }

      if (selection.expectedEffort !== undefined && selection.expectedEffort !== (activeBinding.effort ?? null)) {
        violations.push({
          code: EVALUATION_VIOLATIONS.SELECTION_EFFORT_MISMATCH,
          message: 'Binding effort does not match expected selection effort',
          field: 'selection.expectedEffort',
        });
      }

      if (selection.expectedVariant !== undefined && selection.expectedVariant !== (activeBinding.variant ?? null)) {
        violations.push({
          code: EVALUATION_VIOLATIONS.SELECTION_VARIANT_MISMATCH,
          message: 'Binding variant does not match expected selection variant',
          field: 'selection.expectedVariant',
        });
      }

      if (selection.expectedAgent !== undefined) {
        const agentId = typeof activeBinding.agent === 'string' ? activeBinding.agent : activeBinding.agent?.id;
        if (selection.expectedAgent !== agentId) {
          violations.push({
            code: EVALUATION_VIOLATIONS.SELECTION_AGENT_MISMATCH,
            message: 'Binding agent does not match expected selection agent',
            field: 'selection.expectedAgent',
          });
        }
      }

      if (selection.expectedRevision !== undefined && selection.expectedRevision !== activeBinding.revision) {
        violations.push({
          code: EVALUATION_VIOLATIONS.SELECTION_REVISION_MISMATCH,
          message: 'Binding revision does not match expected selection revision',
          field: 'selection.expectedRevision',
        });
      }

      if (selection.expectedApprovalDigest !== undefined && selection.expectedApprovalDigest !== activeBinding.approvalDigest) {
        violations.push({
          code: EVALUATION_VIOLATIONS.DIGEST_APPROVAL_MISMATCH,
          message: 'Binding approval digest does not match expected selection digest',
          field: 'selection.expectedApprovalDigest',
        });
      }

      if (
        selection.expectedCalibrationEvidenceDigest !== undefined &&
        selection.expectedCalibrationEvidenceDigest !== activeBinding.calibrationEvidenceDigest
      ) {
        violations.push({
          code: EVALUATION_VIOLATIONS.DIGEST_CALIBRATION_MISMATCH,
          message: 'Binding calibration evidence digest does not match expected selection digest',
          field: 'selection.expectedCalibrationEvidenceDigest',
        });
      }

      if (
        selection.expectedExecutableIdentityDigest !== undefined &&
        selection.expectedExecutableIdentityDigest !== activeBinding.executableIdentityDigest
      ) {
        violations.push({
          code: EVALUATION_VIOLATIONS.DIGEST_EXECUTABLE_IDENTITY_MISMATCH,
          message: 'Binding executable identity digest does not match expected selection digest',
          field: 'selection.expectedExecutableIdentityDigest',
        });
      }

      if (selection.expectedPolicyDigest !== undefined && (policyDigest === null || selection.expectedPolicyDigest !== policyDigest)) {
        violations.push({
          code: EVALUATION_VIOLATIONS.DIGEST_POLICY_MISMATCH,
          message: 'Policy digest does not match expected selection policy digest',
          field: 'selection.expectedPolicyDigest',
        });
      }

      // Explicit Ordered Fallback Authorization
      if (selection.isFallback || selection.fallback) {
        if (!selection.allowFallback) {
          violations.push({
            code: EVALUATION_VIOLATIONS.UNAPPROVED_FALLBACK,
            message: 'Fallback selection was attempted without explicit approval',
            field: 'selection.isFallback',
          });
        }

        if (Array.isArray(selection.fallbackChain)) {
          if (!selection.fallbackChain.includes(activeBinding.bindingId)) {
            violations.push({
              code: EVALUATION_VIOLATIONS.UNAPPROVED_FALLBACK,
              message: 'Candidate binding is not in authorized fallback chain',
              field: 'selection.fallbackChain',
            });
          }
          if (selection.fallbackIndex !== undefined && Number.isInteger(selection.fallbackIndex)) {
            if (selection.fallbackChain[selection.fallbackIndex] !== activeBinding.bindingId) {
              violations.push({
                code: EVALUATION_VIOLATIONS.UNAPPROVED_FALLBACK,
                message: 'Candidate binding does not match expected position in fallback chain',
                field: 'selection.fallbackIndex',
              });
            }
          }
        }

        if (selection.primaryAssurance && isClosedAssurance(selection.primaryAssurance) && isAssuranceValid) {
          const primaryRank = ASSURANCE_RANK[selection.primaryAssurance] ?? 0;
          const candidateRank = ASSURANCE_RANK[taskAssurance] ?? 0;
          if (candidateRank < primaryRank) {
            violations.push({
              code: EVALUATION_VIOLATIONS.FALLBACK_DOWNGRADE_FORBIDDEN,
              message: 'Fallback candidate downgrades required assurance rank',
              field: 'selection.primaryAssurance',
            });
          }
        }

        // Check effort/variant substitution on fallback
        if (selection.primaryEffort !== undefined && !selection.allowEffortDowngrade) {
          if (selection.primaryEffort === 'high' && activeBinding.effort !== 'high') {
            violations.push({
              code: EVALUATION_VIOLATIONS.UNAPPROVED_FALLBACK,
              message: 'Fallback candidate does not meet required effort without explicit authorization',
              field: 'selection.primaryEffort',
            });
          }
        }
      }
    }
  }

  // 6. Risk Tier Verification
  if (task.riskTier === 'critical' || task.risk === 'critical') {
    if (taskAssurance !== 'release-final' && taskAssurance !== 'reasoning-high') {
      violations.push({
        code: EVALUATION_VIOLATIONS.INSUFFICIENT_ASSURANCE_FOR_RISK,
        message: 'Critical risk task requires reasoning-high or release-final assurance',
        field: 'task.assurance',
      });
    }
  }

  // 7. Coordinator Self-Accept Denial
  if (taskRole === 'coordinator') {
    const isAttemptingAcceptance =
      task.isFinalAcceptance === true ||
      task.action === 'accept' ||
      task.operation === 'acceptance_recorded' ||
      task.canAccept === true;

    if (isAttemptingAcceptance) {
      violations.push({
        code: EVALUATION_VIOLATIONS.COORDINATOR_SELF_ACCEPT_FORBIDDEN,
        message: 'Coordinator role is strictly denied from performing self-acceptance or final approval',
        field: 'task.isFinalAcceptance',
      });
    }
  }

  // 8. Final-Auditor Constraints
  if (taskRole === 'final-auditor') {
    if (taskAssurance !== 'release-final') {
      violations.push({
        code: EVALUATION_VIOLATIONS.FINAL_AUDITOR_ASSURANCE_REQUIRED,
        message: 'Final auditor role strictly requires release-final assurance',
        field: 'task.assurance',
      });
    }

    const hasWritePermission =
      task.writeRoot === true ||
      task.readOnly !== true ||
      task.allowWrite === true ||
      task.writeAccess === true;

    if (hasWritePermission) {
      violations.push({
        code: EVALUATION_VIOLATIONS.FINAL_AUDITOR_WRITE_ROOT_FORBIDDEN,
        message: 'Final auditor role must be strictly read-only with no write-root permission',
        field: 'task.writeRoot',
      });
    }

    if (task.freshSession !== true || task.isReusedSession === true) {
      violations.push({
        code: EVALUATION_VIOLATIONS.FINAL_AUDITOR_FRESH_SESSION_REQUIRED,
        message: 'Final auditor must execute in a fresh independent session',
        field: 'task.freshSession',
      });
    }

    // Contributor-disjoint lineage check: Missing/empty lineage cannot prove independence
    if (!Array.isArray(lineage) || lineage.length === 0) {
      violations.push({
        code: EVALUATION_VIOLATIONS.FINAL_AUDITOR_LINEAGE_NOT_DISJOINT,
        message: 'Final auditor requires verifiable non-empty contributor lineage to prove independence',
        field: 'lineage',
      });
    } else if (activeBinding) {
      for (const entry of lineage) {
        if (!isPlainObject(entry)) {
          violations.push({
            code: EVALUATION_VIOLATIONS.FINAL_AUDITOR_LINEAGE_NOT_DISJOINT,
            message: 'Lineage contains invalid non-object entry',
            field: 'lineage',
          });
          break;
        }
        const entryRole = entry.role;
        if (entryRole === 'writer' || entryRole === 'coordinator') {
          const sameBinding = Boolean(entry.bindingId && entry.bindingId === activeBinding.bindingId);
          const sameModel = Boolean(entry.model && entry.model === activeBinding.model && entry.provider === activeBinding.provider);
          const sameExecDigest = Boolean(
            entry.executableIdentityDigest &&
            entry.executableIdentityDigest === activeBinding.executableIdentityDigest,
          );
          const sameAgent = Boolean(
            entry.agentId &&
            activeBinding.agent &&
            (entry.agentId === activeBinding.agent || entry.agentId === activeBinding.agent?.id),
          );

          if (sameBinding || sameModel || sameExecDigest || sameAgent) {
            violations.push({
              code: EVALUATION_VIOLATIONS.FINAL_AUDITOR_LINEAGE_NOT_DISJOINT,
              message: 'Final auditor candidate was a prior writer or coordinator in task lineage',
              field: 'lineage',
            });
            break;
          }
        }
      }
    }
  }

  const result = {
    eligible: violations.length === 0,
    role: isRoleValid ? taskRole : null,
    assurance: isAssuranceValid ? taskAssurance : null,
    policyDigest: policyDigest ?? null,
    bindingId: activeBinding?.bindingId ?? null,
    violations: Object.freeze(violations.map(sanitizeViolation)),
    evaluatedAt: new Date(typeof now === 'number' && Number.isFinite(now) ? now : Date.now()).toISOString(),
  };

  return deepFreeze(result);
}

/**
 * Asserts that model role eligibility succeeds, throwing AiCliError('POLICY_DENIED') if not.
 */
export function assertModelRoleEligibility(params) {
  const result = evaluateModelRoleEligibility(params);
  if (!result.eligible) {
    throw new AiCliError('POLICY_DENIED', 'Model role eligibility verification failed', {
      exitCode: 2,
      details: {
        violations: result.violations,
        role: result.role,
        assurance: result.assurance,
      },
    });
  }
  return result;
}
