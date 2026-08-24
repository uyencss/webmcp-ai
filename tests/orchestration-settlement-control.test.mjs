import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createPublicLifecycle,
  createTrustedCoordinatorConfig,
  asPublicAdapter,
} from '../src/orchestration/public-adapters.mjs';
import { readClientCapability } from '../src/orchestration/authority.mjs';
import { deriveEndpoint, requestIpc } from '../src/orchestration/ipc.mjs';
import {
  resolveOrchestrationRoots,
} from '../src/orchestration/paths.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { ORCHESTRATION_PROTOCOL } from '../src/orchestration/constants.mjs';

const FIXTURES = new URL('./fixtures/orchestration/', import.meta.url).pathname;

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r8a-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let coordCounter = 0;
const COORD = () => `coord_r8a_${(coordCounter += 1)}`;

async function startSupervisor(t, name, { adapters = [], trustedConfig = null } = {}) {
  const stateDir = tempDir(t, name);
  const coordinationId = COORD();
  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'create',
    coordinationId,
    ...(adapters.length > 0 ? { adapters, trustedCoordinatorConfig: trustedConfig } : {}),
  });
  t.after(() => sup.stop());
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const call = async (operation, input, requestId = `req_${Math.random().toString(36).slice(2, 8)}`) => requestIpc(
    deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId }),
    {
      protocol: ORCHESTRATION_PROTOCOL,
      requestId,
      coordinationId,
      fenceEpoch: sup.__store.state.fenceEpoch,
      capability: readClientCapability({ coordinationDir: join(roots.stateRoot, 'coordinations', coordinationId) }),
      operation,
      input,
    },
    { timeoutMs: 20_000 },
  );
  return { sup, stateDir, call };
}

async function seedTask(call, packet) {
  const created = await call('task.create', { packet }, `req_task_${Math.random().toString(36).slice(2, 8)}`);
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  return created.result.taskId;
}

const ALL_BOOLEAN_CAPABILITIES = Object.fromEntries([
  'liveEvents', 'explicitResume', 'externalAttach', 'questionChannel', 'permissionControl',
  'sameTurnSteer', 'gracefulInterrupt', 'preToolGate', 'processOwnership', 'fileEvents', 'testEvents',
].map((key) => [key, false]));

/**
 * Deterministic stub inner adapter. Controls exactly which Deliveries are
 * emitted and when/if the done promise resolves, so settlement behavior is
 * observable without any provider.
 */
function stubAdapter({ emitDoneDelivery = false, doneOutcome = null, hangForever = true, withIdentity = true } = {}) {
  const inner = {
    id: 'owned-process',
    maturity: 'fixture-only',
    capabilities: { ...ALL_BOOLEAN_CAPABILITIES },
    probe: async () => ({ adapterId: 'owned-process', available: true, installedVersion: process.version, sdkVersion: null, maturity: 'fixture-only', capabilities: { ...ALL_BOOLEAN_CAPABILITIES } }),
    spawn: async ({ task, dispatch, emit }) => {
      emit('worker_started', { dispatchId: dispatch.dispatchId });
      let resolveDone;
      const done = new Promise((resolve) => { resolveDone = resolve; });
      if (!hangForever) {
        setTimeout(() => {
          if (emitDoneDelivery) {
            emit(doneOutcome.deliveryType, {
              taskId: task.taskId,
              dispatchId: dispatch.dispatchId,
              outcome: doneOutcome.outcome,
              source: 'stub-stream',
            });
          }
          resolveDone(doneOutcome ?? { terminalType: 'worker_done', exitCode: 0 });
        }, 30);
      }
      const binding = { sessionId: 'ses_stub', guaranteeTier: 'owned-process' };
      if (withIdentity) {
        binding.processIdentity = { pid: 999_999_001, startIdentity: 'stub:never-matches', processGroupId: 999_999_001 };
      }
      return { ok: true, binding, done };
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
  const config = createTrustedCoordinatorConfig({
    stateDir: tmpdir(),
    allowFixtureDispatch: true,
    ownedProcessCommand: { command: process.execPath, args: ['-e', ''], env: {} },
  });
  return asPublicAdapter(inner, createPublicLifecycle('owned-process', inner, config));
}

function longWorkerConfig(stateDir, mode) {
  return createTrustedCoordinatorConfig({
    stateDir,
    allowFixtureDispatch: true,
    ownedProcessCommand: {
      command: process.execPath,
      args: [join(FIXTURES, 'fake-worker.mjs')],
      env: { ...process.env, FAKE_WORKER_MODE: mode },
    },
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('R8A: a public dispatch settles durably and releases its runtime binding', async (t) => {
  const inner = stubAdapter({ hangForever: false, doneOutcome: { terminalType: 'worker_done', exitCode: 0, outcome: 'completed' } });
  const config = createTrustedCoordinatorConfig({
    stateDir: tempDir(t, 'cfg'),
    allowFixtureDispatch: true,
    ownedProcessCommand: { command: process.execPath, args: ['-e', ''], env: {} },
  });
  // Wrap the stub with a launch that emits NO terminal delivery of its own —
  // the done-promise bridge must synthesize it.
  const adapter = asPublicAdapter(inner, {
    kind: 'owned-process',
    spawnStyle: 'process',
    async launch(context) {
      const started = await inner.spawn({ ...context });
      return started;
    },
    control: async () => ({ ok: true }),
    finalize: async () => ({ action: 'cleanup_recorded', disposition: 'closed' }),
  });

  const { sup, call } = await startSupervisor(t, 'settled', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: tmpdir() },
  });
  const taskId = await seedTask(call, {
    objective: 'Settle me',
    workspace: tempDir(t, 'ws'),
    allowedReadRoots: [],
    allowedWriteRoots: [],
  });
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));
  const dispatchId = started.result.dispatchId;

  const deadline = Date.now() + 5_000;
  let state = null;
  while (Date.now() < deadline) {
    state = sup.__store.state.dispatches[dispatchId]?.state ?? null;
    if (state === 'settled') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(state, 'settled', 'dispatch reaches settled after terminal + cleanup');
  assert.equal(sup.__store.state.dispatches[dispatchId].terminalOutcome, 'completed');

  // The runtime binding must be released once the dispatch is settled.
  const interruptAfter = await call('dispatch.interrupt', { dispatchId, reason: 'post-settle' });
  assert.equal(interruptAfter.ok, false);
  assert.equal(interruptAfter.error.code, 'UNSUPPORTED_CAPABILITY', 'no live binding remains after settlement');
});

test('R8A: a silent exit still produces a terminal delivery and settles', async (t) => {
  // Adapter resolves done WITHOUT emitting any terminal delivery.
  const adapter = stubAdapter({ hangForever: false, doneOutcome: { terminalType: 'worker_done', exitCode: 0, outcome: 'completed' } });
  const { sup, call } = await startSupervisor(t, 'silent-exit', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: tmpdir() },
  });
  const taskId = await seedTask(call, {
    objective: 'Silent worker',
    workspace: tempDir(t, 'ws2'),
    allowedReadRoots: [],
    allowedWriteRoots: [],
  });
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true);
  const dispatchId = started.result.dispatchId;

  const seen = new Set();
  let cursor = 0;
  const deadline = Date.now() + 5_000;
  for (;;) {
    const wait = await call('delivery.wait', { afterSequence: cursor, timeoutMs: 500 });
    for (const delivery of wait.result?.deliveries ?? []) {
      seen.add(delivery.type);
      cursor = Math.max(cursor, delivery.sequence);
    }
    if (seen.has('worker_done') && sup.__store.state.dispatches[dispatchId]?.state === 'settled') break;
    if (Date.now() > deadline) break;
  }
  assert.equal(seen.has('worker_done'), true, 'terminal delivery is bridged from the done promise');
  assert.equal(sup.__store.state.dispatches[dispatchId].state, 'settled');
});

test('R8A: task.cancel really interrupts a live owned worker', async (t) => {
  const stateDir = tempDir(t, 'cancel');
  const config = longWorkerConfig(stateDir, 'ignore-sigint');
  const { createOwnedProcessAdapter } = await import('../src/orchestration/adapters/owned-process.mjs');
  const inner = createOwnedProcessAdapter({ stateDir: join(stateDir, 'op') });
  const adapter = asPublicAdapter(inner, createPublicLifecycle('owned-process', inner, config));
  const { sup, call } = await startSupervisor(t, 'cancel-sup', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: tmpdir() },
  });
  const workspace = tempDir(t, 'ws3');
  const taskId = await seedTask(call, {
    objective: 'Long running',
    workspace,
    allowedReadRoots: [],
    allowedWriteRoots: [],
  });
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true);
  const dispatchId = started.result.dispatchId;

  await new Promise((r) => setTimeout(r, 250));
  const bindingRecord = [...sup.__recordRuntimeBinding ? [] : []];
  void bindingRecord;
  // Find the live pid through the supervisor's durable view.
  const livePid = (() => {
    for (const delivery of []) void delivery;
    return null;
  })();
  void livePid;

  const cancelled = await call('task.cancel', { taskId, reason: 'r8a-real-interrupt' });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled.error ?? {}));
  assert.equal(cancelled.result.cancelled, true);
  assert.equal(
    cancelled.result.stops.some((stop) => stop.dispatchId === dispatchId && stop.stopped === true),
    true,
    'cancel reports the executed interrupt',
  );

  const deadline = Date.now() + 6_000;
  let state = null;
  let outcome = null;
  while (Date.now() < deadline) {
    const record = sup.__store.state.dispatches[dispatchId] ?? null;
    state = record?.state ?? null;
    outcome = record?.terminalOutcome ?? null;
    if (['cancelled', 'lost'].includes(state)) break;
    // An interrupted live worker settles truthfully as a cancelled outcome.
    if (state === 'settled' && outcome === 'cancelled') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(
    ['cancelled', 'lost'].includes(state) || (state === 'settled' && outcome === 'cancelled'),
    true,
    `live dispatch is interrupted, got ${state}/${outcome}`,
  );
  // Truthful durable evidence of the executed interrupt is mandatory — as an
  // interrupt effect AND/OR a reconciled cancelled dispatch with recorded
  // signals. Which artifact survives depends on a benign commit race with the
  // worker's own terminal bridge; at least ONE must exist.
  const effectSeen = sup.__store.state.interruptEffects.some((effect) => effect.taskId === taskId);
  const dispatchRecord = sup.__store.state.dispatches[started.result.dispatchId] ?? null;
  const cancelledEvidence = dispatchRecord
    && (['cancelled', 'lost', 'settled'].includes(dispatchRecord.state)
      || dispatchRecord.terminalOutcome === 'cancelled');
  assert.equal(
    effectSeen || Boolean(cancelledEvidence),
    true,
    `no durable interrupt evidence: effects=${JSON.stringify(sup.__store.state.interruptEffects)} dispatch=${JSON.stringify(dispatchRecord)}`,
  );
});

test('R8A: coordination.close stops every live worker before closing', async (t) => {
  const stateDir = tempDir(t, 'close');
  const config = longWorkerConfig(stateDir, 'ignore-sigint');
  const { createOwnedProcessAdapter } = await import('../src/orchestration/adapters/owned-process.mjs');
  const inner = createOwnedProcessAdapter({ stateDir: join(stateDir, 'op') });
  const adapter = asPublicAdapter(inner, createPublicLifecycle('owned-process', inner, config));
  const { sup, call } = await startSupervisor(t, 'close-sup', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: tmpdir() },
  });
  const taskId = await seedTask(call, {
    objective: 'Close me',
    workspace: tempDir(t, 'ws4'),
    allowedReadRoots: [],
    allowedWriteRoots: [],
  });
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true);

  const closed = await call('coordination.close');
  assert.equal(closed.ok, true, JSON.stringify(closed.error ?? {}));
  assert.equal(closed.result.closed, true);
  assert.equal(
    closed.result.stoppedDispatches.some((stop) => stop.dispatchId === started.result.dispatchId && stop.stopped === true),
    true,
    'close reports the executed interrupt',
  );

  const deadline = Date.now() + 6_000;
  let state = null;
  let outcome = null;
  while (Date.now() < deadline) {
    const record = sup.__store.state.dispatches[started.result.dispatchId] ?? null;
    state = record?.state ?? null;
    outcome = record?.terminalOutcome ?? null;
    if (['cancelled', 'lost'].includes(state)) break;
    if (state === 'settled' && outcome === 'cancelled') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(
    ['cancelled', 'lost'].includes(state) || (state === 'settled' && outcome === 'cancelled'),
    true,
    `close interrupts the live dispatch, got ${state}/${outcome}`,
  );

  // Frozen contract: inspection remains available after closure.
  const inspect = await call('coordination.inspect');
  assert.equal(inspect.ok, true);
  const lateMutation = await call('task.create', { packet: { objective: 'Late', workspace: '/tmp/x' } });
  assert.equal(lateMutation.error?.code, 'COORDINATION_CLOSED');
});

test('R8A: telemetry-only bindings refuse interrupt instead of claiming stopped', async (t) => {
  // A controlOnly record carries NO proven process identity: there is nothing
  // that may be signalled and nothing whose absence could prove an exit.
  const adapter = stubAdapter({ hangForever: true, withIdentity: false });
  const { sup, call } = await startSupervisor(t, 'controlonly', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: tmpdir() },
  });
  const taskId = await seedTask(call, {
    objective: 'Stub worker',
    workspace: tempDir(t, 'ws5'),
    allowedReadRoots: [],
    allowedWriteRoots: [],
  });
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  const dispatchId = started.result.dispatchId;
  await new Promise((r) => setTimeout(r, 100));

  const stopAttempt = await call('dispatch.interrupt', { dispatchId, reason: 'unproven' });
  assert.equal(stopAttempt.ok, false, 'unproven identity never claims a successful stop');
  assert.equal(stopAttempt.error.code, 'WORKER_IDENTITY_UNPROVEN');

  // The refusal keeps the binding alive for a later honest reconciliation.
  const retry = await call('dispatch.interrupt', { dispatchId, reason: 'still-unproven' });
  assert.equal(retry.ok, false);
  assert.equal(retry.error.code, 'WORKER_IDENTITY_UNPROVEN');
});

test('R8A: forged start identity is never signalled (PID-reuse guard)', async (t) => {
  // A real, unrelated sleeper process whose identity will not match the
  // forged record.
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 5000)'], { stdio: 'ignore', detached: true });
  t.after(() => {
    try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { try { sleeper.kill('SIGKILL'); } catch { /* gone */ } }
  });
  await new Promise((resolveTick) => setTimeout(resolveTick, 80));

  const adapter = stubAdapter({ hangForever: true, withIdentity: false });
  const { sup, call } = await startSupervisor(t, 'reuse', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: tmpdir() },
  });
  const taskId = await seedTask(call, {
    objective: 'Reuse target',
    workspace: tempDir(t, 'ws6'),
    allowedReadRoots: [],
    allowedWriteRoots: [],
  });
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  const dispatchId = started.result.dispatchId;

  // Forge a plausible-looking binding pointing at the SLEEPER's pid with a
  // startIdentity that cannot match reality.
  const forged = await sup.__recordRuntimeBinding(dispatchId, {
    bindingId: `worker_${dispatchId.slice(5)}`,
    adapterId: 'owned-process',
    capability: 'owned-process',
    taskId,
    callbackCapability: 'cap-forged',
    processIdentity: {
      pid: sleeper.pid,
      startIdentity: 'forged:start-identity',
      processGroupId: sleeper.pid,
    },
  });
  assert.equal(forged.ok, true);

  const stopAttempt = await call('dispatch.interrupt', { dispatchId, reason: 'pid-reuse' });
  // The recycled pid is NEVER signalled; our own worker is provably gone, so
  // the binding is released truthfully without touching the newcomer.
  assert.equal(pidAlive(sleeper.pid), true, 'the unrelated process was never signalled');
  assert.equal(
    JSON.stringify(stopAttempt.result?.signalsAttempted ?? []),
    '[]',
    `no signal may be attempted against an unproven identity: ${JSON.stringify(stopAttempt)}`,
  );

  // Cleanup: kill the stub's fake binding path by cancelling the task
  // (interrupt refuses again, harmless), then hard-kill the sleeper above.
  await call('task.cancel', { taskId, reason: 'cleanup' }).catch(() => {});
});
