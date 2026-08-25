import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { AiCliError } from '../errors.mjs';
import { ORCHESTRATION_LIMITS } from './constants.mjs';

/**
 * Coordination-TOTAL refs quota.
 *
 * Every durable evidence writer into the coordination `refs/` directory —
 * owned-process stdout/stderr spills, large Delivery payload spills and
 * acceptance-command output spills — MUST reserve its exact sanitized byte
 * size here before creating any file. The accounting is DISK-DERIVED (the
 * refs directory is rescanned on every decision), so the bound is shared by
 * every writer, survives restarts without extra state, and rebuilds itself
 * after recovery. Under the singleton supervisor lock each
 * reserve -> write sequence runs synchronously on one event loop, which makes
 * check+reserve+exclusive-write atomic per writer; the exclusive create is
 * the collision backstop that keeps two writers from ever overwriting or
 * racing past the bound. Overflow is TYPED (`REFS_LIMIT_REACHED`) and never
 * leaves a partially written ref behind.
 */

export function throwRefsLimitReached(details) {
  throw new AiCliError(
    'REFS_LIMIT_REACHED',
    'coordination refs retention bound reached; no bytes may be written',
    { details },
  );
}

/** Sum of every regular file currently durable under `dir` (0 when absent). */
export function durableRefsBytes(dir) {
  let total = 0;
  try {
    for (const name of readdirSync(dir)) {
      try {
        const stats = statSync(join(dir, name));
        if (stats.isFile()) total += stats.size;
      } catch { /* raced removal contributes nothing */ }
    }
  } catch { /* empty or missing refs dir */ }
  return total;
}

/**
 * One-shot reservation against `refsDir`: throws the typed overflow error
 * when the ACTUAL requested bytes would push the directory total past
 * `limitBytes` (default ORCHESTRATION_LIMITS.maxRefsTotalBytes). Call it
 * immediately before an exclusive-create write; the synchronous section is
 * the linearization point under single-writer ownership.
 */
export function reserveRefsBytes(refsDir, requestedBytes, {
  limitBytes = ORCHESTRATION_LIMITS.maxRefsTotalBytes,
  writerId = null,
} = {}) {
  if (!Number.isInteger(requestedBytes) || requestedBytes < 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'refs reservation requires a non-negative integer byte count', { exitCode: 2 });
  }
  const current = durableRefsBytes(refsDir);
  if (current + requestedBytes > limitBytes) {
    throwRefsLimitReached({
      ...(writerId ? { writerId } : {}),
      requestedBytes,
      durableBytes: current,
      limitBytes,
    });
  }
  return { reservedBytes: requestedBytes, durableBytesBefore: current, limitBytes };
}

/**
 * Stateful quota handle. Equivalent to repeated one-shot reservations but
 * tracks pending (reserved-not-yet-written) bytes so future async writers
 * keep the bound exact; recovery simply calls rebuildFromDisk() — disk state
 * remains the single source of truth.
 */
export function createRefsQuota({ refsDir, limitBytes = ORCHESTRATION_LIMITS.maxRefsTotalBytes } = {}) {
  let pendingBytes = 0;
  const quota = {
    get limitBytes() { return limitBytes; },
    get pendingBytes() { return pendingBytes; },
    durableBytes() { return durableRefsBytes(refsDir); },
    totalBytes() { return durableRefsBytes(refsDir) + pendingBytes; },
    reserve(requestedBytes, options = {}) {
      if (!Number.isInteger(requestedBytes) || requestedBytes < 0) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'refs reservation requires a non-negative integer byte count', { exitCode: 2 });
      }
      const current = durableRefsBytes(refsDir);
      if (current + pendingBytes + requestedBytes > limitBytes) {
        throwRefsLimitReached({
          ...(options.writerId ? { writerId: options.writerId } : {}),
          requestedBytes,
          durableBytes: current,
          pendingBytes,
          limitBytes,
        });
      }
      pendingBytes += requestedBytes;
      return { released: false, reservedBytes: requestedBytes };
    },
    /** Reconcile a reservation to the file's ACTUAL on-disk size. */
    commit(token, { writtenPath = null } = {}) {
      if (!token || token.released) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'refs quota commit called twice or with a foreign token');
      }
      token.released = true;
      pendingBytes = Math.max(0, pendingBytes - token.reservedBytes);
      if (writtenPath) {
        try {
          return statSync(writtenPath).size;
        } catch { /* removed before commit; report nothing */ }
      }
      return token.reservedBytes;
    },
    abort(token) {
      if (!token || token.released) return;
      token.released = true;
      pendingBytes = Math.max(0, pendingBytes - token.reservedBytes);
    },
    /** Recovery/rebuild: disk state IS the truth; drop all in-memory pending. */
    rebuildFromDisk() {
      pendingBytes = 0;
      return quota.durableBytes();
    },
  };
  return quota;
}
