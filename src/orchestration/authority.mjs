import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { AiCliError } from '../errors.mjs';
import { writeAtomicJson } from './atomic-file.mjs';
import { commitDelivery } from './store.mjs';

function capPath(layout) {
  return join(layout.coordinationDir, 'client.cap');
}
function capNextPath(layout) {
  return join(layout.coordinationDir, 'client.cap.next');
}
function authorityPath(layout) {
  return join(layout.coordinationDir, 'authority.json');
}
function authorityNextPath(layout) {
  return join(layout.coordinationDir, 'authority.next.json');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/** Provision the first coordination authority. */
export function createAuthority(layout) {
  if (existsSync(capPath(layout))) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'authority is already provisioned', { exitCode: 2 });
  }
  const token = randomBytes(32).toString('hex');
  const record = {
    schema: 'webmcp.ai-orchestration-authority/v0',
    authorityRevisionId: `auth_${randomUUID()}`,
    tokenHash: hashToken(token),
    owner: null,
  };
  writeAtomicJson(capPath(layout), { token });
  writeAtomicJson(authorityPath(layout), record);
  return { token, authorityRevisionId: record.authorityRevisionId };
}

/** Raw machine-local capability token; used only over protected local IPC. */
export function readClientCapability(layout) {
  if (!existsSync(capPath(layout))) {
    throw new AiCliError('COORDINATION_NOT_FOUND', 'client capability file is missing');
  }
  try {
    const parsed = JSON.parse(readFileSync(capPath(layout), 'utf8'));
    if (typeof parsed.token !== 'string') throw new Error('bad shape');
    return parsed.token;
  } catch (error) {
    if (error instanceof AiCliError) throw error;
    throw new AiCliError('JOURNAL_CORRUPT', 'client capability file is unreadable');
  }
}

export function readAuthorityRecord(layout) {
  if (!existsSync(authorityPath(layout))) {
    throw new AiCliError('COORDINATION_NOT_FOUND', 'authority record is missing');
  }
  return JSON.parse(readFileSync(authorityPath(layout), 'utf8'));
}

/**
 * Fenced verification: token-hash comparison plus an exact current-epoch
 * requirement. A wrong or unknown token surfaces WORKER_IDENTITY_UNPROVEN; a
 * valid token at a stale epoch surfaces STALE_COORDINATOR_EPOCH.
 */
export function verifyCapability(state, presentedToken, presentedEpoch, { tokenHash } = {}) {
  let matches = false;
  if (
    typeof presentedToken === 'string'
    && typeof tokenHash === 'string'
    && presentedToken.length > 0
  ) {
    const digest = Buffer.from(hashToken(presentedToken));
    const expected = Buffer.from(tokenHash);
    matches = digest.length === expected.length && timingSafeEqual(digest, expected);
  }
  if (!matches) {
    throw new AiCliError('WORKER_IDENTITY_UNPROVEN', 'coordinator capability unproven');
  }
  if (state.fenceEpoch !== presentedEpoch) {
    throw new AiCliError(
      'STALE_COORDINATOR_EPOCH',
      `Coordinator epoch ${presentedEpoch} is stale; current epoch is ${state.fenceEpoch}`,
      { details: { currentEpoch: state.fenceEpoch } },
    );
  }
  return true;
}

function removePendingAuthorityFiles(layout) {
  for (const pending of [capNextPath(layout), authorityNextPath(layout)]) {
    if (existsSync(pending)) rmSync(pending, { force: true });
  }
}

/**
 * Authority recovery across the two transfer crash windows:
 * - crash before journal append: pending files are deleted, old authority kept;
 * - crash after append before promotion: the journal proves the transfer
 *   revision, so promotion completes from the pending files and never rolls
 *   back.
 */
export function recoverAuthority(layout, state) {
  const pendingCap = existsSync(capNextPath(layout));
  const pendingRecord = existsSync(authorityNextPath(layout));

  if (!pendingCap || !pendingRecord) {
    removePendingAuthorityFiles(layout);
    return { token: readClientCapability(layout), promoted: false };
  }

  const pendingParsed = JSON.parse(readFileSync(authorityNextPath(layout), 'utf8'));
  const journalText = existsSync(layout.journalPath)
    ? readFileSync(layout.journalPath, 'utf8')
    : '';
  const journalProvesTransfer = typeof pendingParsed.authorityRevisionId === 'string'
    && journalText.includes(`"authorityRevisionId":"${pendingParsed.authorityRevisionId}"`);

  if (journalProvesTransfer) {
    renameSync(capNextPath(layout), capPath(layout));
    renameSync(authorityNextPath(layout), authorityPath(layout));
    void state;
    return {
      token: readClientCapability(layout),
      promoted: true,
      authorityRevisionId: pendingParsed.authorityRevisionId,
    };
  }

  removePendingAuthorityFiles(layout);
  return { token: readClientCapability(layout), promoted: false };
}

const TRANSFER_FIELDS = ['host', 'instanceId'];

/**
 * Planned ownership transfer in the fixed crash-recoverable order:
 * validate -> generate -> write .next files -> append transfer Delivery ->
 * promote current files -> caller invalidates stale wait/control contexts.
 * The public delivery contains owner descriptors and revision id only.
 */
export function transferAuthority(store, recipient, { clock = () => Date.now() } = {}) {
  const previousToken = readClientCapability(store.layout);
  const recipientIsObject = recipient !== null && typeof recipient === 'object' && !Array.isArray(recipient);
  if (recipient !== null && !recipientIsObject) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'transfer recipient must be an object', { exitCode: 2 });
  }
  if (recipientIsObject) {
    for (const key of Object.keys(recipient)) {
      if (!TRANSFER_FIELDS.includes(key)) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `unknown recipient field ${key}`, { exitCode: 2 });
      }
    }
  }

  const nextToken = randomBytes(32).toString('hex');
  const authorityRevisionId = `auth_${randomUUID()}`;
  const owner = recipient ? { ...recipient } : null;
  const nextFenceEpoch = store.state.fenceEpoch + 1;

  // 1+2: generate and stage next authority atomically before the journal.
  writeAtomicJson(capNextPath(store.layout), { token: nextToken }, { mode: 0o600 });
  writeAtomicJson(authorityNextPath(store.layout), {
    schema: 'webmcp.ai-orchestration-authority/v0',
    authorityRevisionId,
    tokenHash: hashToken(nextToken),
    owner,
    createdAt: new Date(clock()).toISOString(),
  }, { mode: 0o600 });

  // 3: durable proof point — after this append, recovery must promote.
  commitDelivery(store, {
    type: 'ownership_transferred',
    payload: {
      fenceEpoch: nextFenceEpoch,
      owner,
      authorityRevisionId,
    },
  });

  // 4: promote staged files to current.
  renameSync(capNextPath(store.layout), capPath(store.layout));
  renameSync(authorityNextPath(store.layout), authorityPath(store.layout));

  // 5: prior in-memory wait/control contexts are invalidated by callers that
  // observe the returned receipt's authorityRevisionId/epoch change.
  return {
    fenceEpoch: nextFenceEpoch,
    authorityRevisionId,
    owner,
    token: nextToken,
    previousToken,
  };
}
