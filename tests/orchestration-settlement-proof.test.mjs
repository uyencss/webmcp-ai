import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

import {
  createPublicLifecycle,
  createTrustedCoordinatorConfig,
  asPublicAdapter,
} from '../src/orchestration/public-adapters.mjs';
import { readClientCapability, createAuthority } from '../src/orchestration/authority.mjs';
import { deriveEndpoint, requestIpc } from '../src/orchestration/ipc.mjs';
import {
  resolveOrchestrationRoots,
  ensureOrchestrationRoots,
  createCoordinationLayout,
} from '../src/orchestration/paths.mjs';
import { createPlatformIdentityDeps } from '../src/orchestration/process-identity.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { openCoordinationStore, commitDelivery } from '../src/orchestration/store.mjs';
import { writeAtomicJson } from '../src/orchestration/atomic-file.mjs';
import { MANIFEST_SCHEMA, ORCHESTRATION_PROTOCOL } from '../src/orchestration/constants.mjs';

// ---- harness ---------------------------------------------------------------

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `r11a-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let coordCounter = 0;
const COORD = () => `coord_r11a_${(coordCounter += 1)}`;

async function startSupervisor(t, name, { coordinationId = null, mode = 'create', adapters = [], trustedConfig = null } = {}) {
  const stateDir = tempDir(t, name);
  const coord = coordinationId ?? COORD();
  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode,
    coordinationId: coord,
    adapters,
    ...(adapters.length > 0 ? { trustedCoordinatorConfig: trustedConfig } : {}),
  });
  t.after(() => sup.stop());
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const call = async (operation, input) => requestIpc(
    deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId: coord }),
    {
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
      coordinationId: coord,
      fenceEpoch: sup.__store.state.fenceEpoch,
      capability: readClientCapability({ coordinationDir: join(roots.stateRoot, 'coordinations', coord) }),
      operation,
      input,
    },
    { timeoutMs: 20_000 },
  );
  return { sup, stateDir, call, coordinationId: coord, roots };
}

async function seedTask(call, packet) {
  const created = await call('task.create', { packet });
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  return created.result.taskId;
}

async function waitFor(condition, deadlineMs, label) {
  const startedAt = Date.now();
  for (;;) {
    let result = false;
    try { result = await condition(); } catch { result = false; }
    if (result) return;
    if (Date.now() - startedAt > deadlineMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
}

/** Spawn a real detached sleeper and prove its exact start identity. */
async function spawnSleeper(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  const deps = createPlatformIdentityDeps();
  const startIdentity = await deps.getStartIdentity(child.pid);
  t.after(() => {
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  });
  assert.ok(typeof startIdentity === 'string' && startIdentity.length > 0, 'sleeper identity must be provable');
  return {
    pid: child.pid,
    processGroupId: child.pid,
    startIdentity,
    killGroup() {
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    },
  };
}

const ALL_BOOLEAN_CAPABILITIES = Object.fromEntries([
  'liveEvents', 'explicitResume', 'externalAttach', 'questionChannel', 'permissionControl',
  'sameTurnSteer', 'gracefulInterrupt', 'preToolGate', 'processOwnership', 'fileEvents', 'testEvents',
].map((key) => [key, false]));

/**
 * Adapter whose finalize behavior is scriptable per attempt:
 *   'throw'        -> finalizer throws
 *   'signalled'    -> returns an honest group-signalled receipt (worker survived)
 *   'prove'        -> kills the sleeper group then proves group-stopped
 */
function scriptedFinalizeAdapter(sleeper) {
  const state = { attempts: 0, behavior: 'throw' };
  const inner = {
    id: 'owned-process',
    maturity: 'fixture-only',
    capabilities: { ...ALL_BOOLEAN_CAPABILITIES },
    probe: async () => ({
      adapterId: 'owned-process', available: true, installedVersion: process.version,
      sdkVersion: null, maturity: 'fixture-only', capabilities: { ...ALL_BOOLEAN_CAPABILITIES },
    }),
    spawn: async ({ task, dispatch }) => {
      let resolveDone;
      const done = new Promise((resolve) => { resolveDone = resolve; });
      setTimeout(() => resolveDone({ terminalType: 'worker_done', exitCode: 0 }), 30);
      return {
        ok: true,
        binding: {
          sessionId: 'ses_r11a',
          guaranteeTier: 'owned-process',
          processIdentity: {
            pid: sleeper.pid,
            startIdentity: sleeper.startIdentity,
            processGroupId: sleeper.processGroupId,
          },
        },
        done,
      };
    },
    attach() { throw new Error('unsupported'); },
    subscribe() { throw new Error('unsupported'); },
    readSession: async () => null,
    sendReply() { throw new Error('unsupported'); },
    sendGuidance() { throw new Error('unsupported'); },
    resolvePermission() { throw new Error('unsupported'); },
    interrupt: async () => ({ ok: true, interrupted: true }),
    close: async () => ({ disposition: 'closed' }),
    sanitize: (event) => event,
  };
  const lifecycle = createPublicLifecycle('owned-process', inner, createTrustedCoordinatorConfig({
    stateDir: tmpdir(),
    allowFixtureDispatch: true,
    ownedProcessCommand: { command: process.execPath, args: ['-e', ''], env: {} },
  }));
  lifecycle.finalize = async () => {
    state.attempts += 1;
    if (state.behavior === 'throw') throw new Error('r11a injected finalizer failure');
    if (state.behavior === 'signalled') {
      return { ok: true, disposition: 'group-signalled', signalsAttempted: ['GROUP_SIGINT', 'GROUP_SIGTERM', 'GROUP_SIGKILL'] };
    }
    sleeper.killGroup();
    await new Promise((resolveTick) => setTimeout(resolveTick, 120));
    return { ok: true, disposition: 'group-stopped', signalsAttempted: ['GROUP_SIGKILL'] };
  };
  const adapter = asPublicAdapter(inner, lifecycle);
  return { adapter, state };
}

function trustedConf(stateDir) {
  return {
    allowFixtureDispatch: true,
    confinement: 'disposable-workspace',
    disposableRoot: stateDir,
    ownedProcessCommand: { command: process.execPath, args: ['-e', ''], env: {} },
  };
}

function bindingsRecord(stateDir, coordinationId) {
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const path = join(roots.stateRoot, 'coordinations', coordinationId, 'runtime-bindings.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'))?.bindings ?? {};
}

function journalTypes(stateDir, coordinationId) {
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const path = join(roots.stateRoot, 'coordinations', coordinationId, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function capabilityFiles(stateDir, coordinationId) {
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const dir = join(roots.stateRoot, 'coordinations', coordinationId, 'dispatch-capabilities');
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

// ---- RED tests -------------------------------------------------------------

test('R11A-1: a thrown finalizer keeps the dispatch settling with its binding retained until cleanup is proven', async (t) => {
  const sleeper = await spawnSleeper(t);
  const { adapter, state } = scriptedFinalizeAdapter(sleeper);
  const { sup, call, coordinationId, stateDir } = await startSupervisor(t, 'fin-throw', {
    adapters: [adapter],
    trustedConfig: trustedConf(tmpdir()),
  });

  const taskId = await seedTask(call, {
    objective: 'R11A-1 finalizer must fail closed',
    workspace: tempDir(t, 'ws1'),
    allowedReadRoots: [],
    allowedWriteRoots: [],
  });
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));
  const dispatchId = started.result.dispatchId;

  // Wait for the terminal bridge to reach the settlement phase (pre-fix this
  // races straight through to settled; the assertions below catch either way).
  await waitFor(
    () => ['settling', 'settled'].includes(sup.__store.state.dispatches[dispatchId]?.state),
    5_000,
    'terminal bridge to begin settlement',
  );
  await waitFor(() => state.attempts >= 1, 5_000, 'finalizer attempt');

  // Give the (failing) finalizer ample time to be wrongly honored.
  await new Promise((resolveTick) => setTimeout(resolveTick, 700));
  assert.equal(state.attempts >= 1, true, 'finalizer must have been invoked');

  // INVARIANT: a failed cleanup NEVER settles the dispatch.
  assert.equal(
    sup.__store.state.dispatches[dispatchId]?.state,
    'settling',
    'dispatch must remain settling while cleanup is unproven',
  );

  // INVARIANT: binding stays durable so a retry can keep control.
  assert.ok(
    bindingsRecord(stateDir, coordinationId)[dispatchId],
    'runtime binding must survive a failed finalize',
  );

  // Transfer must stay blocked while settlement is unproven.
  const transfer = await call('coordination.transfer', { owner: null });
  assert.equal(transfer.ok, false, 'transfer must refuse while cleanup is unproven');
  assert.equal(transfer.error.code, 'TRANSFER_BLOCKED_ACTIVE_DISPATCHES');

  // Retry succeeds -> settle exactly once.
  state.behavior = 'prove';
  await waitFor(() => sup.__store.state.dispatches[dispatchId]?.state === 'settled', 10_000, 'settled after proven retry');
  const cleanups = journalTypes(stateDir, coordinationId)
    .filter((record) => record.type === 'cleanup_recorded' && dispatchId === record.payload?.dispatchId
      && String(record.payload?.proof ?? '').startsWith('proven'));
  assert.equal(cleanups.length, 1, 'exactly one proven completion receipt');
});

test('R11A-2: recovery of a settling dispatch without binding proof never settles it', async (t) => {
  const stateDir = tempDir(t, 'rec-nb');
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
  commitDelivery(store, { type: 'task_created', payload: { taskId: 'task_r11a2' } });
  commitDelivery(store, { type: 'dispatch_created', payload: { dispatchId: 'disp_r11a2', taskId: 'task_r11a2' } });
  commitDelivery(store, {
    type: 'dispatch_state_changed',
    payload: { dispatchId: 'disp_r11a2', taskId: 'task_r11a2', state: 'active' },
  });
  commitDelivery(store, {
    type: 'worker_done',
    payload: { dispatchId: 'disp_r11a2', taskId: 'task_r11a2', outcome: 'completed', source: 'seed' },
  });
  // NO runtime-bindings.json: the crashed owner left zero proof.

  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'recover',
    coordinationId,
  });
  t.after(() => sup.stop());

  await new Promise((resolveTick) => setTimeout(resolveTick, 500));
  assert.equal(
    sup.__store.state.dispatches['disp_r11a2']?.state,
    'settling',
    'missing binding proof must park the dispatch fail-closed, never settled',
  );
  const records = journalTypes(stateDir, coordinationId).filter(
    (record) => record.type === 'cleanup_recorded' && record.payload?.dispatchId === 'disp_r11a2',
  );
  assert.equal(records.length >= 1, true, 'recovery records typed cleanup evidence');
  assert.equal(
    String(records.at(-1)?.payload?.proof),
    'failed-unproven',
    'no-provable-identity recovery evidence is failed-unproven, not cleanup-done',
  );
});

test('R11A-3: a surviving worker after the full ladder parks the dispatch and retains the binding for retry', async (t) => {
  const sleeper = await spawnSleeper(t);
  const stateDir = tempDir(t, 'ladder');
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
  commitDelivery(store, { type: 'task_created', payload: { taskId: 'task_r11a3' } });
  commitDelivery(store, { type: 'dispatch_created', payload: { dispatchId: 'disp_r11a3', taskId: 'task_r11a3' } });
  commitDelivery(store, {
    type: 'dispatch_state_changed',
    payload: { dispatchId: 'disp_r11a3', taskId: 'task_r11a3', state: 'active' },
  });
  commitDelivery(store, {
    type: 'worker_done',
    payload: { dispatchId: 'disp_r11a3', taskId: 'task_r11a3', outcome: 'completed', source: 'seed' },
  });
  // Durable binding pointing at the REAL live sleeper with proven identity.
  writeAtomicJson(join(layout.coordinationDir, 'runtime-bindings.json'), {
    schema: 'webmcp.ai-supervisor-runtime-bindings/v0',
    bindings: {
      disp_r11a3: {
        bindingId: 'worker_r11a3',
        adapterId: 'owned-process',
        capability: 'owned-process',
        taskId: 'task_r11a3',
        fenceEpoch: 1,
        processIdentity: {
          pid: sleeper.pid,
          startIdentity: sleeper.startIdentity,
          processGroupId: sleeper.processGroupId,
        },
      },
    },
  });

  // Deterministic unkillable-worker simulation: swallow every signal aimed at
  // the sleeper (or its group) while presence probes stay truthful.
  const realProcessKill = process.kill.bind(process);
  const sleeperAlive = () => {
    try { realProcessKill(sleeper.pid, 0); return true; } catch { return false; }
  };
  const swallowed = [];
  const killMock = mock.method(process, 'kill', (target, signal = 0) => {
    const normalized = typeof target === 'number' ? target : Number(target);
    const targetsSleeper = normalized === sleeper.pid || normalized === -sleeper.processGroupId;
    if (targetsSleeper && signal !== 0 && sleeperAlive()) {
      swallowed.push(`${target}:${signal}`);
      return undefined;
    }
    return realProcessKill(target, signal);
  });
  t.after(() => killMock.mock.restore());

  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'recover',
    coordinationId,
  });
  t.after(() => sup.stop());
  await waitFor(() => swallowed.filter((entry) => entry.includes('SIGKILL')).length > 0, 8_000, 'full ladder reaching SIGKILL');
  await new Promise((resolveTick) => setTimeout(resolveTick, 300));

  // The worker SURVIVED: dispatch must stay settling with binding retained.
  assert.equal(
    sup.__store.state.dispatches['disp_r11a3']?.state,
    'settling',
    'surviving worker must keep the dispatch out of settled',
  );
  assert.equal(
    sleeperAlive(),
    true,
    'the mocked survivor must still be alive after the ladder',
  );
  const retained = bindingsRecord(stateDir, coordinationId)['disp_r11a3'];
  assert.ok(retained, 'binding retained after group-signalled outcome');
  const records = journalTypes(stateDir, coordinationId).filter(
    (record) => record.type === 'cleanup_recorded' && record.payload?.dispatchId === 'disp_r11a3',
  );
  assert.equal(String(records.at(-1)?.payload?.proof), 'pending-retry', 'survival evidence is pending-retry');

  // Phase 2: restore real signalling; a second recovery proves the stop and
  // settles EXACTLY once across both boots.
  killMock.mock.restore();
  await sup.stop();
  sleeper.killGroup();
  await waitFor(() => !sleeperAlive(), 5_000, 'sleeper to die for phase two');
  const sup2 = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'recover',
    coordinationId,
  });
  t.after(() => sup2.stop());
  await waitFor(() => sup2.__store.state.dispatches['disp_r11a3']?.state === 'settled', 10_000, 'phase-two settle');
  const allCleanups = journalTypes(stateDir, coordinationId).filter(
    (record) => record.type === 'cleanup_recorded' && record.payload?.dispatchId === 'disp_r11a3'
      && String(record.payload?.proof ?? '').startsWith('proven'),
  );
  assert.equal(allCleanups.length, 1, 'exactly one proven completion receipt across recoveries');
  const settles = journalTypes(stateDir, coordinationId).filter(
    (record) => record.type === 'dispatch_state_changed' && record.payload?.dispatchId === 'disp_r11a3'
      && record.payload?.state === 'settled',
  );
  assert.equal(settles.length, 1, 'exactly one settled transition across recoveries');
});
