import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createAuthority,
  readAuthorityRecord,
  readClientCapability,
  recoverAuthority,
  transferAuthority,
  verifyCapability,
} from '../src/orchestration/authority.mjs';
import { readProcessIdentity } from '../src/orchestration/process-identity.mjs';
import { acquireSupervisorLock, releaseSupervisorLock } from '../src/orchestration/lock.mjs';
import { evaluateRetention, pruneCoordination } from '../src/orchestration/retention.mjs';
import { createCoordinationLayout, ensureOrchestrationRoots, resolveOrchestrationRoots } from '../src/orchestration/paths.mjs';
import { openCoordinationStore } from '../src/orchestration/store.mjs';

function fixture(t, name = 'auth') {
  const override = join(tmpdir(), `webmcp-ai-t3-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  t.after(() => rmSync(override, { recursive: true, force: true }));
  const roots = resolveOrchestrationRoots({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: override },
    platform: 'darwin',
    homeDir: '/Users/tester',
  });
  ensureOrchestrationRoots(roots);
  const layout = createCoordinationLayout(roots.stateRoot, 'coord_test');
  mkdirSync(layout.coordinationDir, { recursive: true });
  writeFileSync(layout.manifestPath, `${JSON.stringify({
    schema: 'webmcp.ai-orchestration-manifest/v0',
    coordinationId: 'coord_test',
    fenceEpoch: 1,
    processGeneration: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
  })}\n`, 'utf8');
  return { roots, layout };
}

test('capability tokens live only in mode-0600 files; state stores hashes', (t) => {
  const fx = fixture(t);
  const authority = createAuthority(fx.layout);

  assert.match(authority.token, /^[0-9a-f]{64}$/);
  assert.equal(statSync(fx.layout.journalPath.replace('events.jsonl', 'client.cap')).mode & 0o777, 0o600);

  const stored = JSON.parse(readFileSync(join(fx.layout.coordinationDir, 'client.cap'), 'utf8'));
  assert.equal(stored.token, authority.token, 'raw token persisted for local IPC use');

  const record = readAuthorityRecord(fx.layout);
  assert.equal(record.tokenHash.includes(authority.token), false, 'hash file must not contain the token');
  assert.notEqual(record.tokenHash, authority.token);

  assert.deepEqual(readClientCapability(fx.layout), authority.token);
});

function verifyFixture(fx, authority) {
  return (epoch = 1) => verifyCapability(
    { fenceEpoch: epoch },
    authority.token,
    epoch,
    { tokenHash: readAuthorityRecord(fx.layout).tokenHash },
  );
}

test('planned transfer rotates authority and fences an in-flight owner', (t) => {
  const fx = fixture(t);
  createAuthority(fx.layout);
  const store = openCoordinationStore(fx.layout);

  const transfer = transferAuthority(store, { host: 'claude', instanceId: 'host-b' });

  assert.equal(transfer.fenceEpoch, 2);
  assert.equal(store.state.fenceEpoch, 2);
  const newHash = readAuthorityRecord(fx.layout).tokenHash;
  assert.equal(verifyCapability({ fenceEpoch: 2 }, transfer.token, 2, { tokenHash: newHash }), true);

  // The rotated-out token is unproven against the new hash.
  assert.throws(
    () => verifyCapability({ fenceEpoch: 2 }, transfer.previousToken, 2, { tokenHash: newHash }),
    (error) => error.code === 'WORKER_IDENTITY_UNPROVEN',
  );
  // A stale epoch cannot control even with the correct new token.
  assert.throws(
    () => verifyCapability({ fenceEpoch: 2 }, transfer.token, 1, { tokenHash: newHash }),
    (error) => error.code === 'STALE_COORDINATOR_EPOCH',
  );

  // The public transfer delivery carries descriptors and epoch, never secrets.
  const journal = readFileSync(fx.layout.journalPath, 'utf8');
  assert.match(journal, /ownership_transferred/);
  assert.doesNotMatch(journal, /token/i);
  assert.equal(journal.includes(transfer.token), false);
});

test('transfer crash windows recover deterministically', async (t) => {
  // Window A: crash before journal append — pending files exist, old
  // authority retained, pending files removed on recovery.
  const fxA = fixture(t, 'crashA');
  const firstA = createAuthority(fxA.layout);
  writeFileSync(join(fxA.layout.coordinationDir, 'client.cap.next'), `${JSON.stringify({ token: 'pending-token' })}\n`);
  writeFileSync(join(fxA.layout.coordinationDir, 'authority.next.json'), `${JSON.stringify({ authorityRevisionId: 'auth_pending' })}\n`);
  const recoveredA = recoverAuthority(fxA.layout, { lastSequence: 0 });
  assert.equal(recoveredA.token, firstA.token, 'old authority retained');
  assert.equal(existsSync(join(fxA.layout.coordinationDir, 'client.cap.next')), false, 'pending removed');

  // Window B: crash after append before promotion — journal proves the
  // transfer; promotion completes from pending files and never rolls back.
  const fxB = fixture(t, 'crashB');
  createAuthority(fxB.layout);
  const storeB = openCoordinationStore(fxB.layout);
  const pendingToken = 'a'.repeat(64);
  const { createHash } = await import('node:crypto');
  writeFileSync(join(fxB.layout.coordinationDir, 'client.cap.next'), `${JSON.stringify({ token: pendingToken })}\n`);
  writeFileSync(join(fxB.layout.coordinationDir, 'authority.next.json'), `${JSON.stringify({
    authorityRevisionId: 'auth_next',
    tokenHash: createHash('sha256').update(pendingToken).digest('hex'),
  })}\n`);
  const { commitDelivery } = await import('../src/orchestration/store.mjs');
  commitDelivery(storeB, {
    type: 'ownership_transferred',
    payload: { fenceEpoch: 2, owner: { host: 'claude', instanceId: 'host-b' }, authorityRevisionId: 'auth_next' },
  });
  const recoveredB = recoverAuthority(fxB.layout, storeB.state);
  assert.equal(recoveredB.token, pendingToken, 'promotion completed from pending files');
  assert.equal(JSON.parse(readFileSync(join(fxB.layout.coordinationDir, 'client.cap'), 'utf8')).token, pendingToken);
  assert.equal(existsSync(join(fxB.layout.coordinationDir, 'client.cap.next')), false);
});

const baseIdentity = {
  pid: 4123,
  startIdentity: 'darwin:Fri Aug 22 11:58:02 2026',
  processGroupId: 4123,
  processGeneration: 2,
  runtimeNonce: 'nonce_018f47ad',
};

function lockDeps(overrides = {}) {
  return {
    inspectPid: async () => overrides.inspectResult ?? null,
    ...overrides,
  };
}

test('process identity requires every proof component', async () => {
  assert.deepEqual(
    await readProcessIdentity(99, {
      getStartIdentity: () => 'darwin:x',
      getProcessGroupId: () => 99,
    }),
    null,
    'missing runtime nonce source means indeterminate',
  );
  const full = await readProcessIdentity(99, {
    getStartIdentity: () => 'darwin:x',
    getProcessGroupId: () => 99,
    getRuntimeNonce: () => 'nonce_x',
  });
  assert.equal(full.startIdentity.startsWith('darwin:'), true);
  assert.equal(full.runtimeNonce, 'nonce_x');

  // Indeterminate inspection never authorizes anything.
  assert.equal(await readProcessIdentity(99, { getStartIdentity: () => null }), null);
});

test('dual writers are fenced by live identity proof', async (t) => {
  const fx = fixture(t, 'lock');
  const lock = await acquireSupervisorLock(fx.layout, baseIdentity);

  // Live PID with matching start identity: second lock rejected.
  await assert.rejects(
    acquireSupervisorLock(fx.layout, { ...baseIdentity, runtimeNonce: 'nonce_other' }, lockDeps({
      inspectResult: { alive: true, startIdentity: baseIdentity.startIdentity },
    })),
    (error) => error.code === 'COORDINATION_LOCKED',
  );

  // Dead PID: stale lock archived and generation increments.
  const dead = await acquireSupervisorLock(
    fx.layout,
    { ...baseIdentity, runtimeNonce: 'nonce_gen3', processGeneration: 3 },
    lockDeps({ inspectResult: { alive: false } }),
  );
  assert.equal(dead.identity.processGeneration, 3);
  const archived = existsSync(`${fx.layout.lockPath}.stale`);
  assert.equal(archived, true, 'stale lock archived for audit');

  // Reused PID with a different start identity is treated as stale.
  const reused = await acquireSupervisorLock(
    fx.layout,
    { ...baseIdentity, runtimeNonce: 'nonce_gen4', processGeneration: 4 },
    lockDeps({ inspectResult: { alive: true, startIdentity: 'darwin:different-boot' } }),
  );
  assert.equal(reused.identity.processGeneration, 4);

  // Same PID/start but wrong runtime nonce cannot release the lock.
  await assert.rejects(
    releaseSupervisorLock(reused, 'nonce_wrong'),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.equal(existsSync(fx.layout.lockPath), true, 'lock survived the rejected release');
  await releaseSupervisorLock(reused, 'nonce_gen4');
  assert.equal(existsSync(fx.layout.lockPath), false);
});

test('indeterminate process identity blocks lock takeover instead of deleting locks', async (t) => {
  const fx = fixture(t, 'lock-indeterminate');
  await acquireSupervisorLock(fx.layout, baseIdentity);
  await assert.rejects(
    acquireSupervisorLock(
      fx.layout,
      { ...baseIdentity, runtimeNonce: 'nonce_new' },
      lockDeps({ inspectResult: null }),
    ),
    (error) => error.code === 'COORDINATION_LOCKED',
  );
  assert.equal(existsSync(fx.layout.lockPath), true);
});

const DAY = 24 * 60 * 60 * 1000;

function retentionState(overrides = {}) {
  return {
    coordinationState: 'open',
    updatedAt: new Date(0).toISOString(),
    acknowledgedThrough: 5,
    lastSequence: 5,
    escalations: [],
    ...overrides,
  };
}

test('retention decisions never signal workers and respect the seven-day gates', () => {
  const now = 8 * DAY;

  // Closed beyond retention -> deletable, no signalling.
  assert.deepEqual(
    evaluateRetention(retentionState({ coordinationState: 'closed' }), now),
    { eligible: true, action: 'delete-closed-state', reason: 'closed-retention-expired', maySignalWorkers: false },
  );

  // Closed but recent -> retain everything except expired refs after 24h.
  assert.deepEqual(
    evaluateRetention(retentionState({ coordinationState: 'closed', updatedAt: new Date(2 * DAY).toISOString() }), now),
    { eligible: true, action: 'delete-large-refs', reason: 'closed-ref-retention-expired', maySignalWorkers: false },
  );

  // Open with a live supervisor -> never abandoned regardless of age.
  assert.equal(
    evaluateRetention(retentionState(), now, { supervisorAlive: true }).eligible,
    false,
  );

  // Open, old, no liveness, fully acknowledged -> abandon eligible.
  assert.deepEqual(
    evaluateRetention(retentionState(), now, {}),
    { eligible: true, action: 'mark-abandoned', reason: 'active-abandoned-eligible', maySignalWorkers: false },
  );

  // Unacknowledged critical delivery blocks abandonment.
  assert.equal(
    evaluateRetention(
      retentionState({ lastSequence: 6 }),
      now,
      { hasUnacknowledgedCriticalDelivery: true },
    ).eligible,
    false,
  );

  // Proven owned-worker liveness blocks abandonment.
  assert.equal(
    evaluateRetention(retentionState(), now, { ownedWorkerLive: true }).eligible,
    false,
  );
});

test('attached-observer sessions are never signalled or deleted by prune', async (t) => {
  const fx = fixture(t, 'prune');
  const decision = evaluateRetention(
    retentionState({ coordinationState: 'abandoned' }),
    8 * DAY,
    { observerBindings: ['worker_observer'] },
  );
  assert.equal(decision.maySignalWorkers, false);

  const receipt = await pruneCoordination(fx.layout, decision);
  assert.match(JSON.stringify(receipt), /pruned|skipped|retained/);

  // A hostile decision claiming signalling rights is refused outright.
  await assert.rejects(
    pruneCoordination(fx.layout, { ...decision, maySignalWorkers: true }),
    (error) => error.code === 'POLICY_DENIED',
  );
});
