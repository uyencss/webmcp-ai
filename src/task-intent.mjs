import { AiCliError } from './errors.mjs';

export const VALID_TASK_INTENTS = Object.freeze(['compose', 'review', 'implement', 'plan']);

// Strict portable reviewer profiles. This is intentionally narrower than
// VALID_ACCESS_PROFILES in capabilities.mjs: provider-default and
// gateway-tool are legacy/privileged and are never valid for the portable
// taskIntent contract. `full` stays portable as the explicit write grant.
export const VALID_REVIEW_ACCESS_PROFILES = Object.freeze([
  'compose-only',
  'review-readonly',
  'bounded-edit',
  'full',
]);

const TASK_INTENT_SET = new Set(VALID_TASK_INTENTS);
const REVIEW_PROFILE_SET = new Set(VALID_REVIEW_ACCESS_PROFILES);

// Which accessProfiles are compatible with each taskIntent.
// Read-only review intents allow only review-readonly; implement allows only
// write profiles; compose allows only compose-only. review/plan intentionally
// exclude compose-only so review+compose-only fails
// TASK_INTENT_ACCESS_CONFLICT before any compose temp workspace is created.
const INTENT_PROFILE_ALLOWLIST = Object.freeze({
  compose: Object.freeze(['compose-only']),
  review: Object.freeze(['review-readonly']),
  plan: Object.freeze(['review-readonly']),
  implement: Object.freeze(['bounded-edit', 'full']),
});

const INTENT_DEFAULT_PROFILE = Object.freeze({
  compose: 'compose-only',
  review: 'review-readonly',
  plan: 'review-readonly',
});

export function normalizeTaskIntent(value) {
  if (typeof value !== 'string') {
    throw new AiCliError('INVALID_INPUT', 'taskIntent must be one of compose, review, implement, plan', {
      exitCode: 2,
      details: { taskIntent: value ?? null },
    });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AiCliError('INVALID_INPUT', 'taskIntent must be one of compose, review, implement, plan', {
      exitCode: 2,
      details: { taskIntent: value },
    });
  }
  if (!TASK_INTENT_SET.has(trimmed)) {
    throw new AiCliError('TASK_INTENT_INVALID', `Unknown taskIntent: ${trimmed} (expected compose|review|implement|plan)`, {
      exitCode: 2,
      details: { taskIntent: value },
    });
  }
  return trimmed;
}

export function normalizeReviewAccessProfile(value) {
  if (typeof value !== 'string') {
    throw new AiCliError('INVALID_INPUT', 'accessProfile must be one of compose-only, review-readonly, bounded-edit, full', {
      exitCode: 2,
      details: { accessProfile: value ?? null },
    });
  }
  const trimmed = value.trim();
  if (!REVIEW_PROFILE_SET.has(trimmed)) {
    throw new AiCliError('INVALID_INPUT', 'accessProfile must be one of compose-only, review-readonly, bounded-edit, full', {
      exitCode: 2,
      details: { accessProfile: value },
    });
  }
  return trimmed;
}

/**
 * Resolve the portable taskIntent/accessProfile pair.
 *
 * - taskIntent, when present, must be compose|review|implement|plan
 *   (unknown -> TASK_INTENT_INVALID; non-string/empty -> INVALID_INPUT).
 * - accessProfile, when present alongside taskIntent, must be the strict
 *   portable subset (compose-only|review-readonly|bounded-edit|full).
 * - Missing accessProfile defaults: review/plan -> review-readonly,
 *   compose -> compose-only. implement has no default and requires an
 *   explicit write profile (bounded-edit|full) -> TASK_INTENT_ACCESS_CONFLICT.
 * - Any allowlist mismatch is a contradiction and fails with
 *   TASK_INTENT_ACCESS_CONFLICT before any provider spawn.
 *
 * When taskIntent is absent the pair is legacy: no portable defaulting is
 * applied and the caller falls through to capabilities validation. This
 * preserves generate/tool-call/agentMode/full compatibility.
 */
export function resolveTaskIntent({ taskIntent = null, accessProfile = null } = {}) {
  const hasIntent = taskIntent !== undefined && taskIntent !== null;
  const hasProfile = accessProfile !== undefined && accessProfile !== null;
  if (!hasIntent && !hasProfile) {
    return { taskIntent: null, accessProfile: null };
  }
  if (!hasIntent && hasProfile) {
    // AccessProfile-only callers stay on the legacy capabilities path;
    // validate portability only when a taskIntent is present so legacy
    // provider-default/gateway-tool/full flows keep working.
    return { taskIntent: null, accessProfile };
  }
  const intent = normalizeTaskIntent(taskIntent);
  let profile = null;
  if (!hasProfile) {
    if (intent === 'implement') {
      throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', 'implement requires an explicit write accessProfile (bounded-edit or full)', {
        exitCode: 2,
        details: { taskIntent: intent },
      });
    }
    profile = INTENT_DEFAULT_PROFILE[intent];
  } else {
    profile = normalizeReviewAccessProfile(accessProfile);
  }
  const allowed = INTENT_PROFILE_ALLOWLIST[intent];
  if (!allowed.includes(profile)) {
    throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', `taskIntent ${intent} contradicts accessProfile ${profile}`, {
      exitCode: 2,
      details: { taskIntent: intent, accessProfile: profile },
    });
  }
  return { taskIntent: intent, accessProfile: profile };
}
