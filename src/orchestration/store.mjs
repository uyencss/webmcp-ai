import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { AiCliError } from '../errors.mjs';
import { writeAtomicJson, createAtomicExclusiveFile } from './atomic-file.mjs';
import {
  CRITICAL_DELIVERY_TYPES,
  DELIVERY_PROTOCOL,
  ID_PREFIXES,
  MANIFEST_SCHEMA,
  ORCHESTRATION_LIMITS,
  SNAPSHOT_SCHEMA,
} from './constants.mjs';
import { appendDeliveryLine, journalSizeBytes, recoverJournal } from './journal.mjs';
import { sanitizeEvent, sanitizeEnvironmentMetadata } from './redaction.mjs';
import { acknowledgeThrough, applyDelivery, classifyCallback, createInitialState } from './state-machine.mjs';
import { reserveRefsBytes } from './refs-quota.mjs';

const REF_RETENTION_MS = 24 * 60 * 60 * 1000;

function snapshotFromState(state) {
  return {
    schema: SNAPSHOT_SCHEMA,
    coordinationId: state.coordinationId,
    lastSequence: state.lastSequence,
    acknowledgedThrough: state.acknowledgedThrough,
    fenceEpoch: state.fenceEpoch,
    processGeneration: state.processGeneration,
    coordinationState: state.coordinationState,
    ...(state.owner !== undefined ? { owner: state.owner } : {}),
    tasks: state.tasks,
    dispatches: state.dispatches,
    workers: state.workers,
    workerCallbacks: state.workerCallbacks,
    gates: state.gates,
    escalations: state.escalations,
    interruptEffects: state.interruptEffects,
    updatedAt: state.updatedAt,
  };
}

function readManifest(layout) {
  if (!existsSync(layout.manifestPath)) {
    throw new AiCliError('COORDINATION_NOT_FOUND', 'coordination manifest is missing');
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(layout.manifestPath, 'utf8'));
  } catch {
    throw new AiCliError('SNAPSHOT_CORRUPT', 'coordination manifest is not valid JSON');
  }
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw new AiCliError(
      'ORCHESTRATION_UNSUPPORTED_VERSION',
      `unsupported manifest schema: ${String(manifest.schema)}`,
      { exitCode: 2 },
    );
  }
  return manifest;
}

/**
 * Open a coordination store: journal is canonical truth, the snapshot is only
 * an acceleration projection. A snapshot ahead of the journal is corrupt; a
 * stale one is rebuilt and rewritten atomically.
 */
export function openCoordinationStore(layout, { journalSizeBytes: sizeSource } = {}) {
  const manifest = readManifest(layout);
  const recovery = recoverJournal(layout);

  let storedSnapshot = null;
  if (existsSync(layout.snapshotPath)) {
    try {
      storedSnapshot = JSON.parse(readFileSync(layout.snapshotPath, 'utf8'));
    } catch {
      throw new AiCliError('SNAPSHOT_CORRUPT', 'coordination snapshot is not valid JSON');
    }
    if (storedSnapshot.schema !== SNAPSHOT_SCHEMA) {
      throw new AiCliError(
        'ORCHESTRATION_UNSUPPORTED_VERSION',
        `unsupported snapshot schema: ${String(storedSnapshot.schema)}`,
        { exitCode: 2 },
      );
    }
    if (storedSnapshot.lastSequence > recovery.lastSequence) {
      throw new AiCliError(
        'SNAPSHOT_CORRUPT',
        `snapshot claims sequence ${storedSnapshot.lastSequence} beyond journal end ${recovery.lastSequence}`,
      );
    }
  }

  let state = createInitialState(manifest);
  for (const delivery of recovery.deliveries) {
    state = applyDelivery(state, delivery);
  }

  if (!storedSnapshot || storedSnapshot.lastSequence !== state.lastSequence) {
    writeAtomicJson(layout.snapshotPath, snapshotFromState(state));
  }

  return {
    layout,
    manifest,
    state,
    truncatedFragmentBytes: recovery.truncatedFragmentBytes,
    __sizeSource: sizeSource ?? (() => journalSizeBytes(layout.journalPath)),
  };
}

function spillLargePayload(store, sequence, payload, clock) {
  const serialized = JSON.stringify(payload ?? {});
  if (Buffer.byteLength(serialized, 'utf8') <= ORCHESTRATION_LIMITS.maxInlinePayloadBytes) {
    return payload;
  }
  if (Buffer.byteLength(serialized, 'utf8') > ORCHESTRATION_LIMITS.maxRefBytes) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `delivery payload exceeds the ${ORCHESTRATION_LIMITS.maxRefBytes} byte ref ceiling`,
      { exitCode: 2 },
    );
  }
  const refName = `ref_${String(sequence).padStart(6, '0')}.json`;
  // Coordination-TOTAL refs quota: the spill reserves its EXACT serialized
  // byte size against the shared refs directory before any bytes land, so
  // large Delivery spills can never bypass maxRefsTotalBytes regardless of
  // what other writers did. The write itself is an exclusive create: durable
  // evidence is never overwritten.
  reserveRefsBytes(store.layout.refsDir, Buffer.byteLength(serialized, 'utf8'), {
    writerId: `store-spill:${sequence}`,
  });
  createAtomicExclusiveFile(join(store.layout.refsDir, refName), serialized);
  return {
    ref: join('refs', refName),
    mediaType: 'application/json',
    bytes: Buffer.byteLength(serialized, 'utf8'),
    sha256: createHash('sha256').update(serialized).digest('hex'),
    expiresAt: new Date(clock() + REF_RETENTION_MS).toISOString(),
  };
}

/**
 * The single-writer commit path: validate, assign identity, spill oversized
 * payloads, enforce journal bounds, append+fsync, reduce, snapshot atomically.
 */
export function commitDelivery(store, draft, { clock = () => Date.now(), waiters } = {}) {
  if (!draft || typeof draft.type !== 'string' || !draft.type) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'delivery draft requires a type', { exitCode: 2 });
  }
  // Durable callback identity is validated BEFORE any journal mutation:
  // duplicates replay the prior acknowledgement, everything invalid fails
  // closed without touching durable history.
  if (draft.callbackRef !== undefined) {
    const classification = classifyCallback(store.state, draft.callbackRef);
    if (classification.kind === 'duplicate') {
      return { delivery: null, duplicate: true, acknowledgedSequence: classification.acknowledgedSequence };
    }
  }
  const sequence = store.state.lastSequence + 1;
  // THE persistence ingress boundary: every durable payload is sanitized and
  // its environment metadata allowlisted before any journal/ref write.
  let payloadDraft = draft.payload ?? {};
  if (payloadDraft && typeof payloadDraft === 'object' && !Array.isArray(payloadDraft)
    && payloadDraft.env !== undefined) {
    payloadDraft = { ...payloadDraft, env: sanitizeEnvironmentMetadata(payloadDraft.env) };
  }
  const payload = spillLargePayload(store, sequence, sanitizeEvent(payloadDraft), clock);

  const envelope = {
    schema: DELIVERY_PROTOCOL,
    deliveryId: `${ID_PREFIXES.delivery}${sequence}`,
    sequence,
    coordinationId: store.manifest.coordinationId,
    ...(draft.taskId !== undefined ? { taskId: draft.taskId } : {}),
    ...(draft.dispatchId !== undefined ? { dispatchId: draft.dispatchId } : {}),
    ...(draft.bindingId !== undefined ? { bindingId: draft.bindingId } : {}),
    ...(draft.callbackRef !== undefined ? { callbackRef: draft.callbackRef } : {}),
    type: draft.type,
    time: typeof draft.time === 'string' ? draft.time : new Date(clock()).toISOString(),
    payload,
  };

  const recordBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
  if (recordBytes > ORCHESTRATION_LIMITS.maxDeliveryBytes) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `serialized delivery exceeds the ${ORCHESTRATION_LIMITS.maxDeliveryBytes} byte record limit`,
      { exitCode: 2 },
    );
  }

  const currentSize = store.__sizeSource();
  const critical = CRITICAL_DELIVERY_TYPES.includes(draft.type);
  // The reserved final band is [backpressure, hard): only critical records may
  // land there. At or beyond the hard limit everything fails closed.
  if (currentSize >= ORCHESTRATION_LIMITS.journalHardLimitBytes) {
    throw new AiCliError('JOURNAL_LIMIT_REACHED', 'journal hard limit reached; export/prune required');
  }
  if (
    !critical
    && currentSize >= ORCHESTRATION_LIMITS.journalBackpressureBytes
  ) {
    throw new AiCliError('JOURNAL_BACKPRESSURE', 'journal backpressure threshold reached');
  }

  // Validation happens BEFORE the durable append: a reducer-invalid event
  // must leave no journal record at all.
  const nextState = applyDelivery(store.state, envelope);
  appendDeliveryLine(store.layout.journalPath, envelope);
  writeAtomicJson(store.layout.snapshotPath, snapshotFromState(nextState));
  store.state = nextState;
  if (waiters) notifyWaiters(waiters);
  return { delivery: envelope, state: nextState };
}

function notifyWaiters() {
  // Waiter notification lands with the supervisor IPC loop in Task 4; kept as
  // an explicit seam so the commit order stays auditable.
}

/** Durable monotonic acknowledgement watermark; snapshot-only mutation. */
export function persistAck(store, throughSequence) {
  const nextState = acknowledgeThrough(store.state, throughSequence);
  writeAtomicJson(store.layout.snapshotPath, snapshotFromState(nextState));
  store.state = nextState;
  return store.state;
}
