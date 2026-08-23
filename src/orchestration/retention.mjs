import { existsSync, readdirSync, rmSync } from 'node:fs';

import { AiCliError } from '../errors.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const ABANDON_AFTER_MS = 7 * DAY_MS;
const CLOSED_RETENTION_MS = 7 * DAY_MS;
const CLOSED_REF_RETENTION_MS = DAY_MS;

function decision(overrides) {
  return { maySignalWorkers: false, ...overrides };
}

/**
 * Pure retention evaluation. Prune decisions never signal workers; an
 * attached-observer binding can never be signalled or deleted by prune.
 */
export function evaluateRetention(state, nowMs, context = {}) {
  const updatedAtMs = Date.parse(state.updatedAt);
  const age = Number.isFinite(updatedAtMs) ? nowMs - updatedAtMs : Number.POSITIVE_INFINITY;

  if (state.coordinationState === 'closed' || state.coordinationState === 'abandoned') {
    if (age >= CLOSED_RETENTION_MS) {
      return decision({ eligible: true, action: 'delete-closed-state', reason: 'closed-retention-expired' });
    }
    if (age >= CLOSED_REF_RETENTION_MS) {
      return decision({ eligible: true, action: 'delete-large-refs', reason: 'closed-ref-retention-expired' });
    }
    return decision({ eligible: false, action: 'retain', reason: 'within-retention-window' });
  }

  // Active/closing coordinations become abandon-eligible only after the
  // seven-day gate with no liveness and no unacknowledged critical Delivery.
  if (context.supervisorAlive === true) {
    return decision({ eligible: false, action: 'retain', reason: 'supervisor-live' });
  }
  if (context.ownedWorkerLive !== false && context.ownedWorkerLive !== undefined) {
    // true or explicit null (indeterminate): abandonment stays blocked.
    return decision({ eligible: false, action: 'retain', reason: 'owned-worker-live-or-indeterminate' });
  }
  if (context.hasUnacknowledgedCriticalDelivery === true) {
    return decision({
      eligible: false,
      action: 'retain',
      reason: 'unacknowledged-critical-delivery',
    });
  }
  if (age >= ABANDON_AFTER_MS) {
    return decision({ eligible: true, action: 'mark-abandoned', reason: 'active-abandoned-eligible' });
  }
  return decision({ eligible: false, action: 'retain', reason: 'not-abandon-eligible-yet' });
}

/**
 * Execute a retention decision. Observer sessions and identity-indeterminate
 * workers are never touched; every executed prune returns a receipt.
 */
export async function pruneCoordination(layout, decisionInput) {
  if (decisionInput.maySignalWorkers !== false) {
    throw new AiCliError('POLICY_DENIED', 'prune decisions must never signal workers');
  }

  switch (decisionInput.action) {
    case 'delete-closed-state': {
      if (!existsSync(layout.coordinationDir)) {
        return { action: decisionInput.action, pruned: [], reason: 'already-absent' };
      }
      rmSync(layout.coordinationDir, { recursive: true, force: true });
      return {
        action: decisionInput.action,
        pruned: [layout.coordinationDir],
        reason: decisionInput.reason,
      };
    }
    case 'delete-large-refs': {
      if (!existsSync(layout.refsDir)) {
        return { action: decisionInput.action, pruned: [], reason: 'already-absent' };
      }
      const removed = readdirSync(layout.refsDir).map((name) => name);
      rmSync(layout.refsDir, { recursive: true, force: true });
      return {
        action: decisionInput.action,
        pruned: [layout.refsDir],
        refCount: removed.length,
        reason: decisionInput.reason,
      };
    }
    default:
      return {
        action: 'skipped',
        reason: `${decisionInput.action}:${decisionInput.reason ?? 'no-decision'}`,
        pruned: [],
      };
  }
}
