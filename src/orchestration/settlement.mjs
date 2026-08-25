import { AiCliError } from '../errors.mjs';

/**
 * Typed settlement contract between adapters and the supervisor.
 *
 * A dispatch may leave `settling` ONLY on proven resource release:
 *   - proven-exit:   the worker/process group provably exited during this
 *                    finalization (exit event, ESRCH, identity-consistent
 *                    post-ladder absence).
 *   - proven-absent: the resource was already provably gone before any signal
 *                    was sent (already-exited / nothing owned).
 * Every other outcome is fail-closed and must retain the runtime binding,
 * the capability file and the `settling` state so a retry keeps control:
 *   - pending-retry:    signals were attempted but survival is possible or
 *                       unproven (`group-signalled`, retained resources).
 *   - failed-unproven:  the finalizer threw, refused, or produced no usable
 *                       evidence; nothing about release is proven.
 *
 * PLATFORM CAVEAT (`group-stopped` / PROVEN_EXIT): the "process group"
 * guarantee above is POSIX-only. It is proven by an independent
 * `kill(-pgid, 0)` probe (ESRCH) AFTER the interrupt ladder — never merely
 * by observing the group LEADER's own `exit` event, because a leader that
 * complies with SIGTERM proves nothing about grandchildren that ignored the
 * same signal and are still parented inside the group. On win32 (no POSIX
 * process groups) or whenever no valid group id was ever recorded, this
 * runtime has no Job Object substitute wired up yet: `group-stopped` there
 * degrades to proof of the single owned pid's death only, which is the best
 * available evidence but carries NO process-group-emptiness guarantee. This
 * is a deliberate, accepted alpha limitation (see the R13 remediation
 * handoff), not an oversight — a future revision may replace it with a
 * real Windows Job Object and reinstate the full guarantee on that
 * platform.
 */
export const SETTLEMENT_PROOF = Object.freeze({
  PROVEN_EXIT: 'proven-exit',
  PROVEN_ABSENT: 'proven-absent',
  PENDING_RETRY: 'pending-retry',
  FAILED_UNPROVEN: 'failed-unproven',
});

const ADAPTER_DISPOSITION_PROOF = Object.freeze({
  // Honest exit proofs.
  'group-stopped': SETTLEMENT_PROOF.PROVEN_EXIT,
  'already-exited': SETTLEMENT_PROOF.PROVEN_ABSENT,
  'no-op': SETTLEMENT_PROOF.PROVEN_ABSENT,
  // Stub/no-op finalizer convention for adapters that own no live resource.
  closed: SETTLEMENT_PROOF.PROVEN_ABSENT,
  // Signals sent but survival possible/unproven.
  'group-signalled': SETTLEMENT_PROOF.PENDING_RETRY,
  'signalled-stop-unproven': SETTLEMENT_PROOF.PENDING_RETRY,
  'identity-drift-aborted': SETTLEMENT_PROOF.PENDING_RETRY,
  // Legacy dishonest labels: "a signal was sent" or "we consider it stopped"
  // NEVER prove absence. They fail closed so the retry ladder keeps control
  // instead of settling a possibly-live worker.
  stopped: SETTLEMENT_PROOF.FAILED_UNPROVEN,
  killed: SETTLEMENT_PROOF.FAILED_UNPROVEN,
  interrupted: SETTLEMENT_PROOF.FAILED_UNPROVEN,
});

export function isSettlementProven(proof) {
  return proof === SETTLEMENT_PROOF.PROVEN_EXIT || proof === SETTLEMENT_PROOF.PROVEN_ABSENT;
}

function frozenReceipt(proof, disposition, extra = {}) {
  return Object.freeze({
    proof,
    disposition,
    reason: extra.reason ?? null,
    released: extra.released ?? null,
    retained: extra.retained ?? null,
    signalsAttempted: extra.signalsAttempted ?? null,
  });
}

/**
 * Normalize ANY adapter finalization receipt (or thrown error) into the typed
 * settlement contract. Unknown shapes fail closed: they never authorize a
 * settle. Adapters may declare `proof` directly under this contract; declared
 * values are validated against the enum.
 */
export function normalizeSettlementReceipt(receipt, error = null) {
  if (error) {
    return frozenReceipt(
      SETTLEMENT_PROOF.FAILED_UNPROVEN,
      'cleanup-error',
      { reason: String(error?.message ?? 'finalizer failed').slice(0, 200) },
    );
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return frozenReceipt(SETTLEMENT_PROOF.FAILED_UNPROVEN, 'unknown', {
      reason: 'finalizer returned no receipt',
    });
  }
  if (typeof receipt.proof === 'string') {
    if (!Object.values(SETTLEMENT_PROOF).includes(receipt.proof)) {
      return frozenReceipt(SETTLEMENT_PROOF.FAILED_UNPROVEN, String(receipt.disposition ?? 'unknown'), {
        reason: `adapter declared unknown settlement proof ${receipt.proof}`,
        released: receipt.released ?? null,
        retained: receipt.retained ?? null,
      });
    }
    return frozenReceipt(receipt.proof, String(receipt.disposition ?? 'unknown'), {
      reason: typeof receipt.reason === 'string' ? receipt.reason.slice(0, 200) : null,
      released: receipt.released ?? null,
      retained: receipt.retained ?? null,
      signalsAttempted: Array.isArray(receipt.signalsAttempted) ? receipt.signalsAttempted : null,
    });
  }
  if (receipt.ok === false) {
    return frozenReceipt(SETTLEMENT_PROOF.FAILED_UNPROVEN, String(receipt.disposition ?? 'adapter-refused'), {
      reason: typeof receipt.error?.message === 'string' ? receipt.error.message.slice(0, 200) : 'finalizer refused',
    });
  }
  // Full release receipts (opencode stopServer): release only counts when the
  // file-tree absence itself is proven.
  if (receipt.released === true && receipt.absenceProven === true) {
    return frozenReceipt(SETTLEMENT_PROOF.PROVEN_EXIT, String(receipt.disposition ?? 'released'), {
      released: true,
      retained: receipt.retained ?? false,
    });
  }
  if (receipt.released === false || receipt.retained === true) {
    return frozenReceipt(SETTLEMENT_PROOF.PENDING_RETRY, String(receipt.disposition ?? 'retained'), {
      released: receipt.released ?? null,
      retained: receipt.retained ?? true,
    });
  }
  const disposition = typeof receipt.disposition === 'string' ? receipt.disposition : 'unknown';
  const proof = ADAPTER_DISPOSITION_PROOF[disposition] ?? SETTLEMENT_PROOF.FAILED_UNPROVEN;
  return frozenReceipt(proof, disposition, {
    reason: proof === SETTLEMENT_PROOF.FAILED_UNPROVEN && disposition === 'unknown'
      ? 'finalizer receipt carried no recognizable disposition'
      : null,
    released: receipt.released ?? null,
    retained: receipt.retained ?? null,
    signalsAttempted: Array.isArray(receipt.signalsAttempted) ? receipt.signalsAttempted : null,
  });
}

/**
 * Classify a recovery orphan-stop result ({attempted, disposition, ...} from
 * stopOrphanedByProvenIdentity) into the same typed contract. Disposition
 * semantics decide the proof regardless of which branch produced them.
 */
export function classifyRecoveredStop(orphanStop) {
  const disposition = String(orphanStop?.disposition ?? 'unknown');
  // A SUCCESSFUL identity probe that mismatched the recorded startIdentity
  // proves the ORIGINAL process exited — its pid now belongs to an unrelated
  // newcomer we never signal. This is exit-proven original-exited whether it
  // surfaced before any signalling attempt (attempted:false) or as the
  // ladder's own terminal finding.
  if (disposition === 'pid-recycled-original-exited') {
    return frozenReceipt(SETTLEMENT_PROOF.PROVEN_ABSENT, disposition);
  }
  if (orphanStop?.attempted === true) {
    if (disposition === 'group-stopped') {
      return frozenReceipt(SETTLEMENT_PROOF.PROVEN_EXIT, disposition);
    }
    if (disposition === 'group-signalled' || disposition === 'identity-drift-aborted'
      || disposition === 'pid-recycled-identity-unavailable') {
      return frozenReceipt(SETTLEMENT_PROOF.PENDING_RETRY, disposition);
    }
    return frozenReceipt(SETTLEMENT_PROOF.FAILED_UNPROVEN, disposition);
  }
  if (disposition === 'already-exited') {
    return frozenReceipt(SETTLEMENT_PROOF.PROVEN_ABSENT, disposition);
  }
  if (disposition === 'pid-recycled-identity-unavailable') {
    // The pid is alive but its holder identity could not be proven: the
    // original MAY have exited. Nothing is provable — park for retry.
    return frozenReceipt(SETTLEMENT_PROOF.PENDING_RETRY, disposition);
  }
  // no-provable-identity, self-pid-refused, unknown: nothing proven, park
  // fail-closed.
  return frozenReceipt(SETTLEMENT_PROOF.FAILED_UNPROVEN, disposition);
}

/** Guard helper for callers that want a typed error on unproven settlement. */
export function settlementUnprovenError(settlement, messagePrefix = 'settlement unproven') {
  return new AiCliError(
    'WORKER_STOP_UNPROVEN',
    `${messagePrefix}: ${settlement.disposition}`,
    { details: { proof: settlement.proof, disposition: settlement.disposition } },
  );
}
