import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, truncateSync, writeSync } from 'node:fs';

import { AiCliError } from '../errors.mjs';

function corrupt(message, details) {
  return new AiCliError('JOURNAL_CORRUPT', message, { details });
}

/**
 * Append one complete newline-terminated JSONL delivery and fsync it before
 * the caller exposes it to waiters. Returns the byte length written.
 */
export function appendDeliveryLine(journalPath, envelope) {
  const line = `${JSON.stringify(envelope)}\n`;
  const fd = openSync(journalPath, 'a', 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return Buffer.byteLength(line, 'utf8');
}

function parseJournalBuffer(buffer) {
  const deliveries = [];
  const seenIds = new Set();
  let offset = 0;
  let sequence = 0;
  let completeLinesBytes = 0;
  while (offset < buffer.length) {
    const newlineIndex = buffer.indexOf(0x0a, offset);
    if (newlineIndex === -1) break; // trailing fragment without newline
    const raw = buffer.subarray(offset, newlineIndex).toString('utf8');
    const lineEnd = newlineIndex + 1;
    if (raw.trim()) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw corrupt('journal contains an invalid JSON record', { line: sequence + 1 });
      }
      if (typeof parsed.deliveryId !== 'string' || !Number.isInteger(parsed.sequence)) {
        throw corrupt('journal record is missing deliveryId or sequence');
      }
      if (seenIds.has(parsed.deliveryId)) {
        throw corrupt(`duplicate deliveryId in journal: ${parsed.deliveryId}`);
      }
      sequence = Math.max(sequence, parsed.sequence);
      seenIds.add(parsed.deliveryId);
      deliveries.push(parsed);
    }
    completeLinesBytes = lineEnd;
    offset = lineEnd;
  }
  const fragmentBytes = buffer.length - completeLinesBytes;
  return { deliveries, lastSequence: sequence, fragmentBytes };
}

/**
 * Replay the canonical journal. Throws JOURNAL_CORRUPT on duplicate ids or
 * invalid records; never truncates anything by itself.
 */
export function replayJournal(layout) {
  if (!existsSync(layout.journalPath)) {
    return { deliveries: [], lastSequence: 0, truncatedFragmentBytes: 0 };
  }
  const buffer = readFileSync(layout.journalPath);
  const { deliveries, lastSequence } = parseJournalBuffer(buffer);
  return { deliveries, lastSequence, truncatedFragmentBytes: 0 };
}

/**
 * Crash recovery: if the final record lacks its terminating newline (partial
 * write), truncate the journal back to the last valid newline before replay.
 * Complete valid records are never rewritten.
 */
export function recoverJournal(layout) {
  if (!existsSync(layout.journalPath)) {
    return { deliveries: [], lastSequence: 0, truncatedFragmentBytes: 0 };
  }
  const buffer = readFileSync(layout.journalPath);
  let parsed;
  try {
    parsed = parseJournalBuffer(buffer);
  } catch (error) {
    if (error?.code === 'JOURNAL_CORRUPT') throw error;
    throw error;
  }
  if (parsed.fragmentBytes > 0) {
    truncateSync(layout.journalPath, buffer.length - parsed.fragmentBytes);
  }
  return {
    deliveries: parsed.deliveries,
    lastSequence: parsed.lastSequence,
    truncatedFragmentBytes: parsed.fragmentBytes,
  };
}

export function journalSizeBytes(journalPath) {
  try {
    return statSync(journalPath).size;
  } catch {
    return 0;
  }
}
