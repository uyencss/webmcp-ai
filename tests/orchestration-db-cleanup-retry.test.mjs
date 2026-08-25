import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';

import {
  createAuthority,
} from '../src/orchestration/authority.mjs';
import { ORCHESTRATION_PROTOCOL, MANIFEST_SCHEMA } from '../src/orchestration/constants.mjs';
import { deriveEndpoint } from '../src/orchestration/ipc.mjs';
import {
  createCoordinationLayout,
  ensureOrchestrationRoots,
  resolveOrchestrationRoots,
} from '../src/orchestration/paths.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { openCoordinationStore, commitDelivery } from '../src/orchestration/store.mjs';
import { writeAtomicJson } from '../src/orchestration/atomic-file.mjs';
import { resolveOpencodeDataRoot } from '../src/orchestration/adapters/opencode-server.mjs';
import { createPlatformIdentityDeps } from '../src/orchestration/process-identity.mjs';

const TEST_BASE = mkdtempSync(join(tmpdir(), 'r12e-'));
after(() => {
  try { rmSync(TEST_BASE, { recursive: true, force: true }); } catch { /* best effort */ }
});

function tempDir(name) {
  const dir = join(TEST_BASE, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition, deadlineMs, label) {
  const startedAt = Date.now();
  for (;;) {
    let result = false;
    try { result = await condition(); } catch { result = false; }
    if (result) return result;
    if (Date.now() - startedAt > deadlineMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
}

/**
 * Build the full two-phase fixture:
 *  - an ACTIVE dispatch whose runtime binding carries a provider cleanup
 *    lease over a REAL database tree under the fake HOME data root;
 *  - `livePid`: when provided, a LIVE sleeper matching the lease identity
 *    so the first recovery sees death as UNPROVEN.
 */
async function seedFixture(t, name, { livePid = null, startIdentity = null } = {}) {
  const stateDir = tempDir(name);
  const coordinationId = `coord_r12e_${name}`;
  const fakeHome = join(stateDir, 'home');
  const env = { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir, HOME: fakeHome };
  const roots = resolveOrchestrationRoots({ env });
  ensureOrchestrationRoots(roots);
  const layout = createCoordinationLayout(roots.stateRoot, coordinationId);
  writeAtomicJson(layout.manifestPath, {
    schema: MANIFEST_SCHEMA,
    coordinationId,
    fenceEpoch: 1,
    processGeneration: 1,
    createdAt: new Date().toISOString(),
    owner: null,
  });
  createAuthority(layout);
  const store = openCoordinationStore(layout);
  for (const [type, payload] of [
    ['task_created', { taskId: 'task_e' }],
    ['dispatch_created', { dispatchId: 'disp_e', taskId: 'task_e' }],
    ['dispatch_state_changed', { dispatchId: 'disp_e', taskId: 'task_e', state: 'active' }],
    // Crash window AFTER terminal BEFORE settlement: the reducer parks the
    // dispatch in settling with its terminal outcome durably recorded.
    ['worker_done', { taskId: 'task_e', dispatchId: 'disp_e', outcome: 'completed', exitCode: 0, source: 'owned-process-exit' }],
  ]) {
    commitDelivery(store, { type, payload });
  }

  const dataRoot = resolveOpencodeDataRoot({ env });
  if (!dataRoot.startsWith(stateDir)) throw new Error('fixture guard: data root escaped');
  mkdirSync(dataRoot, { recursive: true });
  const dbDir = join(dataRoot, 'webmcp-ai-runtime', 'worker_e1');
  const dbPath = join(dbDir, 'opencode.db');
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(dbPath, 'runtime-db\n');
  writeFileSync(join(dbDir, 'opencode.db-wal'), 'wal\n');
  // The USER default db sentinel lives in the SAME fake root and must never
  // be touched by any recovery.
  const defaultDb = join(dataRoot, 'opencode.db');
  writeFileSync(defaultDb, 'USER DEFAULT — DO NOT TOUCH\n');

  const identity = livePid ?? null;
  const recordedStartIdentity = identity
    ? startIdentity
    : 'darwin:fixture-gone';
  const record = {
    bindingId: 'worker_e1',
    adapterId: 'opencode-server',
    capability: 'opencode-server',
    taskId: 'task_e',
    fenceEpoch: 1,
    controlOnly: false,
    processIdentity: {
      pid: livePid ?? 999_999_909,
      ...(recordedStartIdentity ? { startIdentity: recordedStartIdentity } : {}),
      processGroupId: livePid ?? 999_999_909,
      identityProven: true,
    },
    cleanupLease: {
      ownershipMode: 'runtime-owned',
      canonicalRuntimeDbPath: dbPath,
      canonicalRuntimeDbDir: dbDir,
      databaseIdentity: createHash('sha256').update(dbPath).digest('hex'),
      processIdentity: {
        pid: livePid ?? 999_999_909,
        processGroupId: livePid ?? 999_999_909,
        ...(recordedStartIdentity ? { startIdentity: recordedStartIdentity } : {}),
      },
    },
  };
  writeAtomicJson(join(layout.coordinationDir, 'runtime-bindings.json'), {
    schema: 'webmcp.ai-supervisor-runtime-bindings/v0',
    bindings: { disp_e: record },
  });

  return {
    stateDir,
    env,
    coordinationId,
    roots,
    layout,
    dbDir,
    dbPath,
    defaultDb,
    bindingsPath: join(layout.coordinationDir, 'runtime-bindings.json'),
    journalRecords: () => readFileSync(layout.journalPath, 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  };
}

function bootRecovery(t, fixture, { hidePids = [] } = {}) {
  let identityDepsFactory;
  if (hidePids.length > 0) {
    identityDepsFactory = () => {
      const real = createPlatformIdentityDeps();
      return {
        platform: real.platform,
        getStartIdentity: async (pid) => (hidePids.includes(pid) ? null : real.getStartIdentity(pid)),
        getProcessGroupId: async (pid) => real.getProcessGroupId(pid),
        getRuntimeNonce: () => null,
      };
    };
  }
  return createSupervisor({
    env: fixture.env,
    mode: 'recover',
    coordinationId: fixture.coordinationId,
    ...(identityDepsFactory ? { identityDepsFactory } : {}),
  });
}

test('R12E: unproven DB cleanup retries across recoveries; release receipt appears exactly once', { timeout: 30_000 }, async (t) => {
  // A LIVE holder matching the lease identity keeps the first recovery honest
  // about death being unproven.
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},10000)'], { stdio: 'ignore', detached: true });
  t.after(() => {
    try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { try { sleeper.kill('SIGKILL'); } catch { /* gone */ } }
  });
  await waitFor(() => pidAlive(sleeper.pid), 3_000, 'sleeper start');

  const fixture = await seedFixture(t, 'two-recovery', {
    livePid: sleeper.pid,
    startIdentity: await createPlatformIdentityDeps().getStartIdentity(sleeper.pid),
  });

  // ---- Recovery #1: worker ALIVE and force-stop FAILS (identity probes
  // unavailable for this pid) → cleanup unproven, everything retained.
  const sup1 = await bootRecovery(t, fixture, { hidePids: [sleeper.pid] });
  await sup1.stop();

  let receipts = fixture.journalRecords().filter((r) => r.type === 'cleanup_recorded'
    && String(r.payload?.disposition ?? '').includes('runtime-database'));
  assert.equal(receipts.filter((r) => r.payload.disposition === 'recovered-runtime-database-released').length, 0,
    'no released receipt may exist while the worker is alive');
  assert.equal(receipts.length >= 1, true, 'an unproven attempt must still journal its evidence');
  assert.equal(existsSync(fixture.dbDir), true, 'the database tree must survive the unproven attempt');
  let bindings = JSON.parse(readFileSync(fixture.bindingsPath, 'utf8')).bindings ?? {};
  assert.ok(bindings.disp_e?.cleanupLease, 'the lease must remain in the durable binding');

  // ---- Worker REALLY exits now.
  try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { /* gone */ }
  await waitFor(() => !pidAlive(sleeper.pid), 5_000, 'real worker exit');

  // ---- Recovery #2: retry completes the release AND drops ownership once.
  const sup2 = await bootRecovery(t, fixture);
  await sup2.stop();

  receipts = fixture.journalRecords().filter((r) => r.type === 'cleanup_recorded'
    && String(r.payload?.disposition ?? '').includes('runtime-database'));
  const releasedReceipts = receipts.filter((r) => r.payload.disposition === 'recovered-runtime-database-released');
  assert.equal(releasedReceipts.length, 1, `exactly one released receipt expected (${receipts.length} receipts)`);
  assert.equal(releasedReceipts[0].payload.absenceProven, true);
  assert.equal(existsSync(fixture.dbDir), false, 'the second recovery releases the tree');
  bindings = JSON.parse(readFileSync(fixture.bindingsPath, 'utf8')).bindings ?? {};
  assert.equal(bindings.disp_e, undefined, 'ownership drops only after BOTH settlement obligations complete');

  // ---- Recovery #3: idempotent — no double-delete, no duplicate receipt.
  const sup3 = await bootRecovery(t, fixture);
  await sup3.stop();
  const receiptsAfterThird = fixture.journalRecords().filter((r) => r.type === 'cleanup_recorded'
    && r.payload?.disposition === 'recovered-runtime-database-released');
  assert.equal(receiptsAfterThird.length, 1, 'released receipt stays exactly-once across repeated recoveries');
  assert.equal(readFileSync(fixture.defaultDb, 'utf8'), 'USER DEFAULT — DO NOT TOUCH\n',
    'the user default database was never touched in any phase');
});
