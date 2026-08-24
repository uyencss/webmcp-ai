import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { resolveOrchestrationRoots } from '../src/orchestration/paths.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { ORCHESTRATION_PROTOCOL } from '../src/orchestration/constants.mjs';
import { createPlatformIdentityDeps } from '../src/orchestration/process-identity.mjs';

const FIXTURES = new URL('./fixtures/orchestration/', import.meta.url).pathname;

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r9b-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let coordCounter = 0;
const COORD = () => `coord_r9b_${(coordCounter += 1)}`;

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
  const call = async (operation, input) => requestIpc(
    deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId }),
    {
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
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

/** Stub owned-process adapter with a fabricated, never-matching identity. */
function stubOwnedAdapter() {
  const inner = {
    id: 'owned-process',
    maturity: 'fixture-only',
    capabilities: { ...ALL_BOOLEAN_CAPABILITIES },
    probe: async () => ({ adapterId: 'owned-process', available: true, maturity: 'fixture-only', capabilities: { ...ALL_BOOLEAN_CAPABILITIES } }),
    spawn: async ({ task, dispatch, emit }) => {
      emit('worker_started', { dispatchId: dispatch.dispatchId });
      const binding = {
        sessionId: 'ses_stub',
        guaranteeTier: 'owned-process',
        processIdentity: { pid: 999_999_001, startIdentity: 'stub:never-matches', processGroupId: 999_999_001 },
      };
      return { ok: true, binding, done: new Promise(() => {}) };
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

/**
 * Stub adapter whose lifecycle.control deliberately DOES NOT stop anything:
 * the honest runtime must notice the worker survived and refuse success.
 */
function stubbornAdapter(sleeperPid, startIdentity, controlCalls) {
  const inner = {
    id: 'owned-process',
    maturity: 'fixture-only',
    capabilities: { ...ALL_BOOLEAN_CAPABILITIES },
    probe: async () => ({ adapterId: 'owned-process', available: true, maturity: 'fixture-only', capabilities: { ...ALL_BOOLEAN_CAPABILITIES } }),
    spawn: async ({ task, dispatch, emit }) => {
      emit('worker_started', { dispatchId: dispatch.dispatchId });
      return {
        ok: true,
        binding: {
          sessionId: 'ses_stubborn',
          guaranteeTier: 'owned-process',
          processIdentity: { pid: sleeperPid, startIdentity, processGroupId: sleeperPid },
        },
        done: new Promise(() => {}),
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
  const config = createTrustedCoordinatorConfig({
    stateDir: tmpdir(),
    allowFixtureDispatch: true,
    ownedProcessCommand: { command: process.execPath, args: ['-e', ''], env: {} },
  });
  const lifecycle = createPublicLifecycle('owned-process', inner, config);
  lifecycle.control = async (context) => {
    controlCalls.push(context?.reason ?? '');
    return { ok: true, mode: 'no-op-control', signalsAttempted: [] };
  };
  return asPublicAdapter(inner, lifecycle);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnSleeper(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore', detached: true });
  t.after(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  });
  return child;
}

test('R9B: task.cancel never claims cancelled over an unproven stop', async (t) => {
  const adapter = stubOwnedAdapter();
  const { sup, call } = await startSupervisor(t, 'cancel-dishonest', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: tmpdir() },
  });
  const taskId = await seedTask(call, {
    objective: 'Stub worker',
    workspace: tempDir(t, 'ws1'),
    allowedReadRoots: [],
    allowedWriteRoots: [],
  });
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));
  const dispatchId = started.result.dispatchId;
  await new Promise((r) => setTimeout(r, 120));

  const cancelled = await call('task.cancel', { taskId, reason: 'r9b-probe' });

  // THE INVARIANT: a successful cancel may never report an unproven stop.
  assert.equal(
    cancelled.ok === true && (cancelled.result?.stops ?? []).some((stop) => !stop.stopped),
    false,
    JSON.stringify(cancelled),
  );
  // Whenever the durable task state claims cancelled, every stop is proven.
  const taskState = sup.__store.state.tasks[taskId]?.state;
  if (taskState === 'cancelled') {
    assert.equal(
      (cancelled.result?.stops ?? []).every((stop) => stop.stopped === true),
      true,
      `durable cancelled over unproven stops: ${JSON.stringify(cancelled.result?.stops)}`,
    );
  }
});

test('R9B: a surviving worker keeps its binding and defers cancellation', async (t) => {
  const sleeper = spawnSleeper(t);
  await new Promise((resolveTick) => setTimeout(resolveTick, 120));
  const identityDeps = createPlatformIdentityDeps();
  const startIdentity = await identityDeps.getStartIdentity(sleeper.pid);
  assert.ok(startIdentity, 'test prerequisite: sleeper identity must be provable');

  const controlCalls = [];
  const adapter = stubbornAdapter(sleeper.pid, startIdentity, controlCalls);
  const { sup, call } = await startSupervisor(t, 'survivor', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: tmpdir() },
  });
  const taskId = await seedTask(call, {
    objective: 'Survivor',
    workspace: tempDir(t, 'ws2'),
    allowedReadRoots: [],
    allowedWriteRoots: [],
  });
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true);
  const dispatchId = started.result.dispatchId;
  await new Promise((r) => setTimeout(r, 150));

  const firstCancel = await call('task.cancel', { taskId, reason: 'first-attempt' });
  assert.equal(firstCancel.ok, false, `unproven stop must fail typed: ${JSON.stringify(firstCancel)}`);
  assert.equal(firstCancel.error?.code, 'WORKER_STOP_UNPROVEN');

  // Durable truth: the task is NOT cancelled, the dispatch is NOT reconciled.
  assert.notEqual(sup.__store.state.tasks[taskId]?.state, 'cancelled');
  assert.equal(['active', 'assigned'].includes(sup.__store.state.dispatches[dispatchId]?.state), true);

  // The worker survived the control attempt.
  assert.equal(pidAlive(sleeper.pid), true, 'a surviving worker must stay alive after an unproven control');

  // Retry remains possible: the binding was retained, control runs again.
  const secondCancel = await call('task.cancel', { taskId, reason: 'retry-attempt' });
  assert.equal(secondCancel.ok, false);
  assert.equal(secondCancel.error?.code, 'WORKER_STOP_UNPROVEN');
  assert.equal(controlCalls.filter((reason) => reason === 'first-attempt').length, 1);
  assert.equal(controlCalls.filter((reason) => reason === 'retry-attempt').length, 1);

  // Cleanup: end the sleeper so the suite leaves no strays.
  try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { /* gone */ }
});

test('R9B: coordination.close stays closing and fails typed while a stop is unproven', async (t) => {
  const sleeper = spawnSleeper(t);
  await new Promise((resolveTick) => setTimeout(resolveTick, 120));
  const identityDeps = createPlatformIdentityDeps();
  const startIdentity = await identityDeps.getStartIdentity(sleeper.pid);

  const controlCalls = [];
  const adapter = stubbornAdapter(sleeper.pid, startIdentity, controlCalls);
  const { sup, call } = await startSupervisor(t, 'close-deferred', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: tmpdir() },
  });
  const taskId = await seedTask(call, {
    objective: 'Close target',
    workspace: tempDir(t, 'ws3'),
    allowedReadRoots: [],
    allowedWriteRoots: [],
  });
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true);
  await new Promise((r) => setTimeout(r, 150));

  const firstClose = await call('coordination.close');
  assert.equal(firstClose.ok, false, `unproven close must fail typed: ${JSON.stringify(firstClose)}`);
  assert.equal(firstClose.error?.code, 'WORKER_STOP_UNPROVEN');
  assert.equal(
    firstClose.ok === true && (firstClose.result?.stoppedDispatches ?? []).some((stop) => !stop.stopped),
    false,
    'close may never claim closed:true over an unproven stop',
  );

  const inspect = await call('coordination.inspect');
  assert.equal(inspect.ok, true);
  assert.equal(inspect.result.coordinationState, 'closing', 'state stays closing while workers remain');

  // Retry close is permitted from the closing state and stays honest.
  const retryClose = await call('coordination.close');
  assert.equal(retryClose.ok, false);
  assert.equal(retryClose.error?.code, 'WORKER_STOP_UNPROVEN');
  assert.equal(pidAlive(sleeper.pid), true, 'the surviving worker is never falsely reported dead');

  try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { /* gone */ }
});

test('R9B: dispatch.interrupt routes through adapter control (session abort, no server kill)', async (t) => {
  const sleeper = spawnSleeper(t);
  await new Promise((resolveTick) => setTimeout(resolveTick, 120));
  const identityDeps = createPlatformIdentityDeps();
  const startIdentity = await identityDeps.getStartIdentity(sleeper.pid);

  const abortCalls = [];
  const inner = {
    id: 'opencode-server',
    maturity: 'fixture-only',
    capabilities: { ...ALL_BOOLEAN_CAPABILITIES },
    probe: async () => ({ adapterId: 'opencode-server', available: true, maturity: 'fixture-only', capabilities: { ...ALL_BOOLEAN_CAPABILITIES } }),
    spawn: async ({ task, dispatch, emit }) => {
      emit('worker_started', { dispatchId: dispatch.dispatchId });
      return {
        ok: true,
        binding: {
          sessionId: 'ses_oc',
          guaranteeTier: 'owned-process',
          ownershipMode: 'runtime-owned',
          processIdentity: { pid: sleeper.pid, startIdentity, processGroupId: sleeper.pid },
        },
        done: new Promise(() => {}),
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
    abortSession: async () => {
      abortCalls.push(1);
      return { ok: true };
    },
  };
  const config = createTrustedCoordinatorConfig({
    stateDir: tmpdir(),
    allowFixtureDispatch: true,
    openCodeBin: process.execPath,
    openCodeArgs: ['-e', ''],
  });
  const lifecycle = createPublicLifecycle('opencode-server', inner, config);
  lifecycle.launch = async (context) => inner.spawn(context);
  const adapter = asPublicAdapter(inner, lifecycle);

  const { call } = await startSupervisor(t, 'oc-abort', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: tmpdir() },
  });
  const taskId = await seedTask(call, {
    objective: 'Abort me',
    workspace: tempDir(t, 'ws4'),
    allowedReadRoots: [],
    allowedWriteRoots: [],
  });
  const started = await call('dispatch.start', { taskId, adapterId: 'opencode-server' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));
  const dispatchId = started.result.dispatchId;
  await new Promise((r) => setTimeout(r, 150));

  const interrupt = await call('dispatch.interrupt', { dispatchId, reason: 'r9b-abort' });
  assert.equal(interrupt.ok, true, JSON.stringify(interrupt));
  assert.equal(abortCalls.length >= 1, true, 'interrupt must abort the SESSION through the adapter');
  assert.equal(interrupt.result?.mode ?? '', 'session-abort', 'the typed control mode names the session abort');
  assert.equal(pidAlive(sleeper.pid), true, 'the server process must NOT be killed by default');
  assert.deepEqual(interrupt.result?.signalsAttempted ?? [], []);

  // Binding retained: a second interrupt still reaches the live session.
  const second = await call('dispatch.interrupt', { dispatchId, reason: 'r9b-abort-2' });
  assert.equal(second.ok, true);
  assert.equal(abortCalls.length >= 2, true);

  try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { /* gone */ }
});

test('R9B: stale fence epoch bindings are refused before any control', async (t) => {
  const adapter = stubOwnedAdapter();
  const { sup, call } = await startSupervisor(t, 'stale-epoch', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: tmpdir() },
  });
  const taskId = await seedTask(call, {
    objective: 'Stale binding',
    workspace: tempDir(t, 'ws5'),
    allowedReadRoots: [],
    allowedWriteRoots: [],
  });
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  const dispatchId = started.result.dispatchId;
  await new Promise((r) => setTimeout(r, 120));

  // Re-record the binding with a future epoch through the machine-local seam,
  // then require the typed refusal before any control.
  const forgedRecord = {
    bindingId: `worker_forged_${dispatchId.slice(5, 17)}`,
    adapterId: 'owned-process',
    capability: 'owned-process',
    taskId,
    fenceEpoch: sup.__store.state.fenceEpoch + 5,
    processIdentity: { pid: 999_999_002, startIdentity: 'stub:never-matches-2', processGroupId: 999_999_002 },
  };
  const recorded = await sup.__recordRuntimeBinding(dispatchId, forgedRecord);
  assert.equal(recorded.ok, true);

  const interrupt = await call('dispatch.interrupt', { dispatchId, reason: 'stale' });
  assert.equal(interrupt.ok, false);
  assert.equal(interrupt.error?.code, 'STALE_COORDINATOR_EPOCH', JSON.stringify(interrupt.error ?? {}));
});

test('R9B: owned-process interrupt ladders SIGINT before SIGTERM/SIGKILL', async (t) => {
  const stateDir = tempDir(t, 'ladder');
  const { createOwnedProcessAdapter } = await import('../src/orchestration/adapters/owned-process.mjs');
  const inner = createOwnedProcessAdapter({ stateDir: join(stateDir, 'op') });
  const config = createTrustedCoordinatorConfig({
    stateDir,
    allowFixtureDispatch: true,
    ownedProcessCommand: {
      command: process.execPath,
      args: [join(FIXTURES, 'fake-worker.mjs')],
      env: { ...process.env, FAKE_WORKER_MODE: 'ignore-sigint' },
    },
  });
  const adapter = asPublicAdapter(inner, createPublicLifecycle('owned-process', inner, config));
  const { sup, call } = await startSupervisor(t, 'ladder-sup', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: tmpdir() },
  });
  const taskId = await seedTask(call, {
    objective: 'Ladder me',
    workspace: tempDir(t, 'ws6'),
    allowedReadRoots: [],
    allowedWriteRoots: [],
  });
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true);
  const dispatchId = started.result.dispatchId;
  await new Promise((r) => setTimeout(r, 400));

  const cancelled = await call('task.cancel', { taskId, reason: 'ladder-order' });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled.error ?? {}));
  const stop = (cancelled.result?.stops ?? []).find((entry) => entry.dispatchId === dispatchId);
  assert.equal(stop?.stopped, true, 'an ignorable-SIGINT worker is still stopped by the full ladder');

  // The recorded cleanup evidence must show SIGINT tried FIRST. Evidence is
  // read through the PUBLIC delivery stream, never a private seam.
  const seen = [];
  let cursor = 0;
  const deadline = Date.now() + 5_000;
  for (;;) {
    const wait = await call('delivery.wait', { afterSequence: cursor, timeoutMs: 500 });
    if (!wait.ok) break;
    for (const delivery of wait.result?.deliveries ?? []) {
      seen.push(delivery);
      cursor = Math.max(cursor, delivery.sequence ?? 0);
    }
    if (seen.some((entry) => entry.type === 'cleanup_recorded') || Date.now() > deadline) break;
  }
  const signals = seen
    .filter((entry) => entry.type === 'cleanup_recorded')
    .flatMap((entry) => entry.payload?.signalsAttempted ?? []);
  assert.equal(signals.includes('SIGINT'), true, `ladder must attempt SIGINT: ${JSON.stringify(signals)}`);
  const sigintIndex = signals.indexOf('SIGINT');
  const harderSignals = ['SIGTERM', 'GROUP_SIGTERM', 'SIGKILL', 'GROUP_SIGKILL'];
  assert.equal(
    signals.slice(0, sigintIndex).some((signal) => harderSignals.includes(signal)),
    false,
    `no harder signal may precede SIGINT: ${JSON.stringify(signals)}`,
  );
});
