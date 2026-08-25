import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readClientCapability, createAuthority } from '../src/orchestration/authority.mjs';
import {
  resolveOrchestrationRoots,
  ensureOrchestrationRoots,
  createCoordinationLayout,
} from '../src/orchestration/paths.mjs';
import { createPlatformIdentityDeps } from '../src/orchestration/process-identity.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { openCoordinationStore, commitDelivery } from '../src/orchestration/store.mjs';
import { writeAtomicJson } from '../src/orchestration/atomic-file.mjs';
import { writeDispatchCapability } from '../src/orchestration/worker-callback.mjs';
import { MANIFEST_SCHEMA } from '../src/orchestration/constants.mjs';

// ---- harness ---------------------------------------------------------------

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `r11b-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let coordCounter = 0;
const COORD = () => `coord_r11b_${(coordCounter += 1)}`;

async function deadPid() {
  const { spawnSync } = await import('node:child_process');
  const done = spawnSync(process.execPath, ['-e', '']);
  const pid = done.pid;
  const deadline = Date.now() + 2_000;
  for (;;) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') return pid;
    }
    if (Date.now() > deadline) throw new Error(`pid ${pid} did not exit`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function spawnSleeper(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  const deps = createPlatformIdentityDeps();
  const startIdentity = await deps.getStartIdentity(child.pid);
  t.after(() => {
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  });
  assert.ok(typeof startIdentity === 'string' && startIdentity.length > 0);
  return { pid: child.pid, startIdentity, killGroup() {
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  } };
}

/**
 * Seed a coordination with two nonterminal dispatches and hand-written
 * durable binding records. disp_first is provider-kind (never control
 * capable), disp_second is owned-process with a REAL live sleeper identity.
 */
async function seedMixedCoordination(t, sleeper) {
  const stateDir = tempDir(t, 'mixed');
  const coordinationId = COORD();
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
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
  const seedSeq = [
    ['task_created', { taskId: 'task_first' }],
    ['dispatch_created', { dispatchId: 'disp_first', taskId: 'task_first' }],
    ['dispatch_state_changed', { dispatchId: 'disp_first', taskId: 'task_first', state: 'active' }],
    ['task_created', { taskId: 'task_second' }],
    ['dispatch_created', { dispatchId: 'disp_second', taskId: 'task_second' }],
    ['dispatch_state_changed', { dispatchId: 'disp_second', taskId: 'task_second', state: 'active' }],
  ];
  for (const [type, payload] of seedSeq) commitDelivery(store, { type, payload });
  const gonePid = await deadPid();
  writeAtomicJson(join(layout.coordinationDir, 'runtime-bindings.json'), {
    schema: 'webmcp.ai-supervisor-runtime-bindings/v0',
    bindings: {
      disp_first: {
        bindingId: 'worker_first',
        adapterId: 'opencode-server',
        capability: 'opencode-server',
        taskId: 'task_first',
        fenceEpoch: 1,
        // Dead provider-owned process: recovery may prove absence safely.
        processIdentity: { pid: gonePid, startIdentity: 'fixture:dead-provider', processGroupId: gonePid },
      },
      disp_second: {
        bindingId: 'worker_second',
        adapterId: 'owned-process',
        capability: 'owned-process',
        taskId: 'task_second',
        fenceEpoch: 1,
        processIdentity: {
          pid: sleeper.pid,
          startIdentity: sleeper.startIdentity,
          processGroupId: sleeper.pid,
        },
      },
    },
  });
  return { stateDir, coordinationId };
}

function bindingsRecord(stateDir, coordinationId) {
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const path = join(roots.stateRoot, 'coordinations', coordinationId, 'runtime-bindings.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'))?.bindings ?? {};
}

function journalRecords(stateDir, coordinationId) {
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const path = join(roots.stateRoot, 'coordinations', coordinationId, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

async function recoverSupervisor(t, stateDir, coordinationId) {
  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'recover',
    coordinationId,
  });
  t.after(() => sup.stop());
  return sup;
}

// ---- RED tests -------------------------------------------------------------

test('R11B-1: mixed recovery keeps the live owned binding durably across a lost provider record', async (t) => {
  const sleeper = await spawnSleeper(t);
  const { stateDir, coordinationId } = await seedMixedCoordination(t, sleeper);

  const sup = await recoverSupervisor(t, stateDir, coordinationId);
  await new Promise((resolveTick) => setTimeout(resolveTick, 600));

  // The live owned-process dispatch must be reattached AND its record must
  // survive DURABLY in the sidecar (not merely in memory).
  assert.equal(sup.__store.state.dispatches['disp_second']?.state, 'active');
  const durable = bindingsRecord(stateDir, coordinationId);
  assert.ok(
    durable['disp_second'],
    'the reapproved live binding must be persisted atomically after recovery',
  );
  assert.equal(durable['disp_second'].bindingId, 'worker_second');

  // The provider dispatch is truthfully lost.
  assert.equal(sup.__store.state.dispatches['disp_first']?.state, 'lost');
  assert.equal(durable['disp_first'], undefined);

  // The live worker must still be controllable through the restored binding.
  const interrupt = await (async () => {
    const { requestIpc } = await import('../src/orchestration/ipc.mjs');
    const { deriveEndpoint } = await import('../src/orchestration/ipc.mjs');
    const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
    return requestIpc(
      deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId }),
      {
        protocol: 'webmcp.ai-orchestration/v0',
        requestId: 'req_r11b_interrupt',
        coordinationId,
        fenceEpoch: sup.__store.state.fenceEpoch,
        capability: readClientCapability({ coordinationDir: join(roots.stateRoot, 'coordinations', coordinationId) }),
        operation: 'dispatch.interrupt',
        input: { dispatchId: 'disp_second', reason: 'r11b control proof' },
      },
      { timeoutMs: 20_000 },
    );
  })();
  assert.equal(interrupt.ok, true, JSON.stringify(interrupt.error ?? {}));
});

test('R11B-2: repeated recovery still reattaches and controls the same live worker', async (t) => {
  const sleeper = await spawnSleeper(t);
  const { stateDir, coordinationId } = await seedMixedCoordination(t, sleeper);

  // First recovery (crashed owner #2).
  const sup2 = await recoverSupervisor(t, stateDir, coordinationId);
  await new Promise((resolveTick) => setTimeout(resolveTick, 500));
  assert.ok(bindingsRecord(stateDir, coordinationId)['disp_second'], 'first recovery persists the live binding');

  // Simulate the recovered owner crashing again: stop it hard and recover.
  await sup2.stop();
  const sup3 = await recoverSupervisor(t, stateDir, coordinationId);
  await new Promise((resolveTick) => setTimeout(resolveTick, 500));

  assert.equal(sup3.__store.state.dispatches['disp_second']?.state, 'active',
    'third owner must STILL see the live dispatch as active/reattached');
  assert.ok(bindingsRecord(stateDir, coordinationId)['disp_second'],
    'second recovery must persist the live binding again');

  const lostCleanups = journalRecords(stateDir, coordinationId).filter(
    (record) => record.type === 'cleanup_recorded'
      && record.payload?.dispatchId === 'disp_second'
      && String(record.payload?.disposition ?? '').includes('reconciled-lost'),
  );
  assert.equal(lostCleanups.length, 0, 'a controllable live worker must never be typed lost');
  sleeper.killGroup();
});

test('R11B-3: residual bindings/capabilities behind settled journals are swept idempotently', async (t) => {
  const stateDir = tempDir(t, 'residual');
  const coordinationId = COORD();
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
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
    ['task_created', { taskId: 'task_res' }],
    ['dispatch_created', { dispatchId: 'disp_res', taskId: 'task_res' }],
    ['dispatch_state_changed', { dispatchId: 'disp_res', taskId: 'task_res', state: 'active' }],
    ['worker_done', { dispatchId: 'disp_res', taskId: 'task_res', outcome: 'completed', source: 'seed' }],
    ['cleanup_recorded', { dispatchId: 'disp_res', taskId: 'task_res', disposition: 'group-stopped', proof: 'proven-exit', idempotencyKey: 'disp_res:settle' }],
    ['dispatch_state_changed', { dispatchId: 'disp_res', taskId: 'task_res', state: 'settled' }],
  ]) {
    commitDelivery(store, { type, payload });
  }

  // Crash window leftovers: binding + capability survived the settle.
  writeAtomicJson(join(layout.coordinationDir, 'runtime-bindings.json'), {
    schema: 'webmcp.ai-supervisor-runtime-bindings/v0',
    bindings: {
      disp_res: {
        bindingId: 'worker_res',
        adapterId: 'owned-process',
        capability: 'owned-process',
        taskId: 'task_res',
        fenceEpoch: 1,
        callbackCapabilityDigest: 'sha256:fixture',
      },
    },
  });
  writeDispatchCapability({
    coordinationDir: layout.coordinationDir,
    endpoint: join(layout.coordinationDir, 'fixture.sock'),
    coordinationId,
    taskId: 'task_res',
    dispatchId: 'disp_res',
    bindingId: 'worker_res',
    fenceEpoch: 1,
    capabilityToken: 'cap_fixture_residual',
  });

  const sup = await recoverSupervisor(t, stateDir, coordinationId);
  await new Promise((resolveTick) => setTimeout(resolveTick, 400));
  void sup;

  assert.equal(bindingsRecord(stateDir, coordinationId)['disp_res'], undefined,
    'residual binding behind a settled journal must be removed');
  const capPath = join(layout.coordinationDir, 'dispatch-capabilities', 'disp_res.cap');
  assert.equal(existsSync(capPath), false, 'residual capability file must be revoked');

  const sweeps = journalRecords(stateDir, coordinationId).filter(
    (record) => record.type === 'cleanup_recorded'
      && record.payload?.disposition === 'residual-artifact-swept',
  );
  assert.equal(sweeps.length, 1, 'exactly one typed residual sweep receipt');

  // Idempotency: a second recovery adds ZERO new sweep receipts.
  await sup.stop();
  const sup2 = await recoverSupervisor(t, stateDir, coordinationId);
  void sup2;
  await new Promise((resolveTick) => setTimeout(resolveTick, 400));
  const sweepsAfter = journalRecords(stateDir, coordinationId).filter(
    (record) => record.type === 'cleanup_recorded'
      && record.payload?.disposition === 'residual-artifact-swept',
  );
  assert.equal(sweepsAfter.length, 1, 'repeat recovery must not append another sweep receipt');
});
