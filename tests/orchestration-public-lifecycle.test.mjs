import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createPublicAdapters,
  createPublicLifecycle,
  createTrustedCoordinatorConfig,
} from '../src/orchestration/public-adapters.mjs';
import { createOwnedProcessAdapter } from '../src/orchestration/adapters/owned-process.mjs';
import { createClaudeStreamAdapter } from '../src/orchestration/adapters/claude-stream.mjs';
import { createCodexExecAdapter } from '../src/orchestration/adapters/codex-exec.mjs';
import { MANIFEST_SCHEMA, ORCHESTRATION_PROTOCOL } from '../src/orchestration/constants.mjs';
import { readClientCapability } from '../src/orchestration/authority.mjs';
import { deriveEndpoint, requestIpc } from '../src/orchestration/ipc.mjs';
import {
  resolveOrchestrationRoots,
  ensureOrchestrationRoots,
  createCoordinationLayout,
} from '../src/orchestration/paths.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { openCoordinationStore, commitDelivery } from '../src/orchestration/store.mjs';
import { writeAtomicJson } from '../src/orchestration/atomic-file.mjs';

const FIXTURES = new URL('./fixtures/orchestration/', import.meta.url).pathname;

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r3-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitWorkspace(t, name) {
  const dir = tempDir(t, name);
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'Fixture']);
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  return dir;
}

let coordCounter = 0;
const COORD = () => `coord_r3_${(coordCounter += 1)}`;

async function startSupervisor(t, name, { adapters = [], trustedConfig = null, seed = true } = {}) {
  const stateDir = tempDir(t, name);
  const coordinationId = COORD();
  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'create',
    coordinationId,
    ...(adapters.length > 0 ? { adapters, trustedCoordinatorConfig: trustedConfig } : {}),
  });
  if (seed) {
    // Default task used across tests; individual tests add more via ops.
  }
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
  return { sup, stateDir, coordinationId, roots, call };
}

async function seedTask(call, packet) {
  const created = await call('task.create', { packet }, `req_task_${Math.random().toString(36).slice(2, 8)}`);
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  return created.result.taskId;
}

function ownedProcessAdapterPair(t, workerMode = 'ordered') {
  const stateDir = tempDir(t, `op-${workerMode}`);
  const inner = createOwnedProcessAdapter({ stateDir });
  const config = createTrustedCoordinatorConfig({
    stateDir,
    allowFixtureDispatch: true,
    ownedProcessCommand: {
      command: process.execPath,
      args: [join(FIXTURES, 'fake-worker.mjs')],
      env: { ...process.env, FAKE_WORKER_MODE: workerMode },
    },
  });
  const adapter = { ...inner, lifecycle: createPublicLifecycle('owned-process', inner, config) };
  return { adapter, config, stateDir };
}

test('public runtime drives an owned-process fixture dispatch end to end through the operation table', async (t) => {
  const { adapter } = ownedProcessAdapterPair(t, 'ordered');
  const workspace = tempDir(t, 'ws-ordered');
  const started = await startSupervisor(t, 'e2e-owned', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true },
  });
  const { sup, call } = started;
  const taskId = await seedTask(call, {
    objective: 'Run the ordered fixture',
    workspace,
    allowedReadRoots: [workspace],
    allowedWriteRoots: [],
  });

  const startResponse = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(startResponse.ok, true, JSON.stringify(startResponse.error ?? {}));
  const dispatchId = startResponse.result.dispatchId;

  // Follow the stream until terminal + cleanup evidence lands.
  const seen = new Set();
  let cursor = 0;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const wait = await call('delivery.wait', { afterSequence: cursor, timeoutMs: 2_000 });
    assert.equal(wait.ok, true);
    for (const delivery of wait.result.deliveries) {
      seen.add(delivery.type);
      cursor = Math.max(cursor, delivery.sequence);
    }
    if (seen.has('worker_done') && seen.has('cleanup_recorded')) break;
    if (Date.now() > deadline) break;
  }
  assert.equal(seen.has('worker_started'), true, 'worker_started must be ingested');
  assert.equal(seen.has('progress'), true, 'stdout/stderr progress must be ingested');
  assert.equal(seen.has('worker_done'), true, 'provider terminal must be ingested');
  assert.equal(seen.has('cleanup_recorded'), true, 'resource reconciliation must be recorded');

  const inspect = await call('coordination.inspect', {});
  assert.equal(inspect.ok, true);
  assert.equal(inspect.result.dispatches[dispatchId].state, 'settled', 'terminal provider state + cleanup settle the dispatch');
  assert.equal(inspect.result.tasks[taskId].state, 'awaiting_acceptance', 'task awaits independent acceptance');
});

test('public stop control interrupts a live owned-process worker through the same dispatch identity', async (t) => {
  const { adapter } = ownedProcessAdapterPair(t, 'ignore-sigint');
  const workspace = tempDir(t, 'ws-stop');
  const { sup, call } = await startSupervisor(t, 'e2e-stop', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true },
  });
  const taskId = await seedTask(call, { objective: 'Long work', workspace });

  // Start must return promptly with an active dispatch and retained control.
  const startResponse = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(startResponse.ok, true, JSON.stringify(startResponse.error ?? {}));
  const dispatchId = startResponse.result.dispatchId;

  const inspectActive = await call('coordination.inspect', {}, 'req_status_active');
  assert.equal(inspectActive.result.dispatches[dispatchId].state, 'active');

  const pidFile = join(tempDir(t, 'pidloc'), 'ignored.pid');
  void pidFile;
  const stop = await call('dispatch.interrupt', { dispatchId, reason: 'r3-stop' }, 'req_stop');
  assert.equal(stop.ok, true, JSON.stringify(stop.error ?? {}));
  assert.equal(Array.isArray(stop.result.signalsAttempted) && stop.result.signalsAttempted.length > 0, true);

  await new Promise((resolveTick) => setTimeout(resolveTick, 150));
  const inspectAfter = await call('coordination.inspect', {}, 'req_status_after');
  const afterState = inspectAfter.result.dispatches[dispatchId];
  assert.equal(
    afterState.state === 'cancelled'
      || (afterState.state === 'settling' && afterState.terminalOutcome === 'cancelled')
      || (afterState.state === 'settled' && afterState.terminalOutcome === 'cancelled'),
    true,
    JSON.stringify(afterState),
  );
  void sup;
});

test('request-supplied executables, environment, database paths and maturity bypasses are forbidden fields', async (t) => {
  const { adapter } = ownedProcessAdapterPair(t);
  const workspace = tempDir(t, 'ws-forbidden');
  const { sup, call } = await startSupervisor(t, 'forbidden', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true },
  });
  const taskId = await seedTask(call, { objective: 'x', workspace });

  for (const hostileField of [
    { command: '/bin/sh' },
    { executable: '/bin/sh' },
    { env: { PATH: '/evil' } },
    { databasePath: '/tmp/evil.db' },
    { maturityBypass: true },
    { argv: ['sh', '-c', 'evil'] },
  ]) {
    const response = await call('dispatch.start', { taskId, adapterId: 'owned-process', ...hostileField });
    assert.equal(response.ok, false, JSON.stringify(hostileField));
    assert.equal(response.error?.code, 'ORCHESTRATION_INVALID_INPUT', JSON.stringify(hostileField));
  }

  const unknownAdapter = await call('dispatch.start', { taskId, adapterId: 'ghost-adapter' });
  assert.equal(unknownAdapter.ok, false);
  assert.equal(unknownAdapter.error?.code, 'UNSUPPORTED_CAPABILITY');
});

test('provider-backed dispatch without current capability evidence is blocked by maturity', async (t) => {
  const stateDir = tempDir(t, 'maturity');
  const inner = createClaudeStreamAdapter({ stateDir, claudeBin: process.execPath, claudeArgs: ['--version'] });
  const adapter = { ...inner, lifecycle: createPublicLifecycle('claude-stream', inner, createTrustedCoordinatorConfig({ stateDir })) };
  const { sup, call } = await startSupervisor(t, 'maturity-block', {
    adapters: [adapter],
    trustedConfig: null, // no dual opt-in
  });
  const workspace = tempDir(t, 'ws-mat');
  const taskId = await seedTask(call, { objective: 'x', workspace });
  const response = await call('dispatch.start', { taskId, adapterId: 'claude-stream' });
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, 'POLICY_DENIED');
  assert.match(response.error?.message ?? '', /canary evidence/i);
});

test('a reducer-invalid event leaves no journal record at all', async (t) => {
  const stateDir = tempDir(t, 'invalid-append');
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  ensureOrchestrationRoots(roots);
  const layout = createCoordinationLayout(roots.stateRoot, 'coord_invalid');
  writeAtomicJson(layout.manifestPath, {
    schema: MANIFEST_SCHEMA, coordinationId: 'coord_invalid', fenceEpoch: 1,
    processGeneration: 1, createdAt: new Date().toISOString(), owner: null,
  });
  const store = openCoordinationStore(layout);
  commitDelivery(store, { type: 'task_created', payload: { taskId: 'task_inv' } });
  commitDelivery(store, { type: 'dispatch_created', payload: { dispatchId: 'disp_inv', taskId: 'task_inv' } });
  const journalBytesBefore = statSync(layout.journalPath).size;

  // assigned -> settled is illegal in the frozen transition map.
  assert.throws(() => commitDelivery(store, {
    type: 'dispatch_state_changed',
    payload: { dispatchId: 'disp_inv', taskId: 'task_inv', state: 'settled' },
  }));

  assert.equal(statSync(layout.journalPath).size, journalBytesBefore, 'an invalid event must not be appended');
});

test('mutable dispatch without preventive confinement fails before launch', async (t) => {
  const { adapter, stateDir: adapterState } = ownedProcessAdapterPair(t);
  const { sup, call } = await startSupervisor(t, 'no-confinement', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true }, // note: no confinement declared
  });
  const workspace = tempDir(t, 'ws-mutable');
  const taskId = await seedTask(call, {
    objective: 'mutate',
    workspace,
    allowedWriteRoots: [join(workspace, 'out')],
  });
  const lastSequenceBefore = sup.__store.state.lastSequence;
  const bindingsFileExistsAtStart = true;
  void bindingsFileExistsAtStart;

  const response = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, 'POLICY_DENIED');
  assert.match(response.error?.message ?? '', /confinement|disposable/i);
  assert.equal(sup.__store.state.lastSequence, lastSequenceBefore, 'refusal must happen before any durable dispatch state');
  void adapterState;
});

test('worker success plus independently failing verification can never become accepted', async (t) => {
  const { adapter } = ownedProcessAdapterPair(t);
  const workspace = gitWorkspace(t, 'ws-verify-fail');
  const { sup, call } = await startSupervisor(t, 'verify-fail', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: workspace },
  });
  const taskId = await seedTask(call, {
    objective: 'work then fail verification',
    workspace,
    allowedWriteRoots: [workspace],
    commandPolicy: { allowedExecutables: [process.execPath] },
  });
  const start = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(start.ok, true, JSON.stringify(start.error ?? {}));
  const dispatchId = start.result.dispatchId;
  let vCursor = 0;
  const vDeadline = Date.now() + 15_000;
  for (;;) {
    const wait = await call('delivery.wait', { afterSequence: vCursor, timeoutMs: 2_000 });
    for (const delivery of wait.result?.deliveries ?? []) vCursor = Math.max(vCursor, delivery.sequence);
    if ((wait.result?.deliveries ?? []).some((d) => d.type === 'worker_done')) break;
    if (Date.now() > vDeadline) break;
  }

  const verify = await call('dispatch.verify', {
    taskId,
    dispatchId,
    commands: [[process.execPath, '-e', 'process.exit(3)']],
  }, 'req_verify_fail');
  assert.equal(verify.ok, true, JSON.stringify(verify.error ?? {}));
  assert.equal(verify.result.receipt.verdict, 'rejected');

  const inspect = await call('coordination.inspect', {});
  assert.equal(inspect.result.tasks[taskId].state, 'rejected', 'failing verification must reject despite a completed worker');
  void dispatchId;
});

test('accepted verification records the canonical acceptance payload and survives replay', async (t) => {
  const { adapter } = ownedProcessAdapterPair(t);
  const workspace = gitWorkspace(t, 'ws-verify-ok');
  const { sup, call, stateDir, coordinationId } = await startSupervisor(t, 'verify-ok', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: workspace },
  });
  const taskId = await seedTask(call, {
    objective: 'work that passes',
    workspace,
    allowedWriteRoots: [workspace],
    commandPolicy: { allowedExecutables: [process.execPath] },
  });
  const start = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(start.ok, true, JSON.stringify(start.error ?? {}));
  let vCursor = 0;
  const vDeadline = Date.now() + 15_000;
  for (;;) {
    const wait = await call('delivery.wait', { afterSequence: vCursor, timeoutMs: 2_000 });
    for (const delivery of wait.result?.deliveries ?? []) vCursor = Math.max(vCursor, delivery.sequence);
    if ((wait.result?.deliveries ?? []).some((d) => d.type === 'worker_done')) break;
    if (Date.now() > vDeadline) break;
  }

  const verify = await call('dispatch.verify', {
    taskId,
    commands: [[process.execPath, '-e', 'process.exit(0)']],
  }, 'req_verify_ok');
  assert.equal(verify.ok, true, JSON.stringify(verify.error ?? {}));
  assert.equal(verify.result.receipt.verdict, 'accepted');

  const journalText = readFileSync(join(
    resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } }).stateRoot,
    'coordinations', coordinationId, 'events.jsonl',
  ), 'utf8');
  assert.equal(journalText.includes('"acceptance":"accepted"'), true, 'canonical acceptance field must persist');

  await sup.stop();
  const recovered = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'recover',
    coordinationId,
  });
  try {
    assert.equal(recovered.__store.state.tasks[taskId].state, 'accepted', 'acceptance must survive replay');
  } finally {
    await recovered.stop();
    t.after(() => { /* supervisor already stopped */ });
  }
});

function claudeAdapterPair(t) {
  const stateDir = tempDir(t, 'claude');
  const inner = createClaudeStreamAdapter({
    stateDir,
    claudeBin: process.execPath,
    claudeArgs: [join(FIXTURES, 'fake-claude.mjs')],
    fakeModeEnv: { FAKE_CLAUDE_MODE: 'assert-args' },
  });
  return { ...inner, lifecycle: createPublicLifecycle('claude-stream', inner, createTrustedCoordinatorConfig({ stateDir, allowFixtureDispatch: true })) };
}

test('public runtime drives a claude-stream fixture dispatch end to end', async (t) => {
  const adapter = claudeAdapterPair(t);
  const workspace = tempDir(t, 'ws-claude');
  const { sup, call } = await startSupervisor(t, 'e2e-claude', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true },
  });
  const taskId = await seedTask(call, { objective: 'Reply with args-ok', workspace });
  const start = await call('dispatch.start', { taskId, adapterId: 'claude-stream' });
  assert.equal(start.ok, true, JSON.stringify(start.error ?? {}));
  const seen = new Set();
  let cursor = 0;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const wait = await call('delivery.wait', { afterSequence: cursor, timeoutMs: 2_000 });
    for (const delivery of wait.result.deliveries) {
      seen.add(delivery.type);
      cursor = Math.max(cursor, delivery.sequence);
    }
    if (seen.has('worker_done') && seen.has('cleanup_recorded')) break;
    if (Date.now() > deadline) break;
  }
  assert.equal(seen.has('worker_started'), true);
  assert.equal(seen.has('worker_done'), true, `terminal missing; saw ${[...seen].join(',')}`);
  assert.equal(seen.has('cleanup_recorded'), true);
  const inspect = await call('coordination.inspect', {});
  assert.equal(inspect.result.tasks[taskId].state, 'awaiting_acceptance');
});

function codexAdapterPair(t) {
  const stateDir = tempDir(t, 'codex');
  const inner = createCodexExecAdapter({
    stateDir,
    codexBin: process.execPath,
    codexArgs: [join(FIXTURES, 'fake-codex.mjs')],
    fakeModeEnv: { FAKE_CODEX_MODE: 'assert-args' },
  });
  return { ...inner, lifecycle: createPublicLifecycle('codex-exec', inner, createTrustedCoordinatorConfig({ stateDir, allowFixtureDispatch: true })) };
}

test('public runtime drives a codex-exec fixture dispatch end to end in a git workspace', async (t) => {
  const adapter = codexAdapterPair(t);
  const workspace = gitWorkspace(t, 'ws-codex');
  const { sup, call } = await startSupervisor(t, 'e2e-codex', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true },
  });
  const taskId = await seedTask(call, { objective: 'Reply ok', workspace });
  const start = await call('dispatch.start', { taskId, adapterId: 'codex-exec' });
  assert.equal(start.ok, true, JSON.stringify(start.error ?? {}));
  const seen = new Set();
  let cursor = 0;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const wait = await call('delivery.wait', { afterSequence: cursor, timeoutMs: 2_000 });
    for (const delivery of wait.result.deliveries) {
      seen.add(delivery.type);
      cursor = Math.max(cursor, delivery.sequence);
    }
    if (seen.has('worker_done')) break;
    if (Date.now() > deadline) break;
  }
  assert.equal(seen.has('worker_done'), true, `terminal missing; saw ${[...seen].join(',')}`);
  const inspect = await call('coordination.inspect', {});
  assert.equal(inspect.result.tasks[taskId].state, 'awaiting_acceptance');
});

const opencodeMod = await import('../src/orchestration/adapters/opencode-server.mjs');

function openCodeAdapterPair(t, streamFile) {
  const stateDir = tempDir(t, 'ocserver');
  const inner = opencodeMod.createOpenCodeServerAdapter({
    stateDir,
    openCodeBin: process.execPath,
    openCodeArgs: [join(FIXTURES, 'fake-opencode-server.mjs')],
    streamFile,
  });
  return {
    inner,
    adapter: {
      ...inner,
      lifecycle: createPublicLifecycle('opencode-server', inner, createTrustedCoordinatorConfig({ stateDir, allowFixtureDispatch: true })),
    },
    stateDir,
  };
}

test('public runtime drives an opencode-server fixture dispatch end to end with isolated db cleanup', async (t) => {
  const streamFile = join(tempDir(t, 'streamdir'), 'opencode.ndjson');
  writeFileSync(streamFile, `${JSON.stringify({ type: 'session.status', properties: { status: { type: 'idle' } } })}\n`);
  const { adapter } = openCodeAdapterPair(t, streamFile);
  const workspace = tempDir(t, 'ws-oc');
  const { sup, call } = await startSupervisor(t, 'e2e-oc', {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true },
  });
  const taskId = await seedTask(call, { objective: 'Say ok', workspace });
  const start = await call('dispatch.start', { taskId, adapterId: 'opencode-server' });
  assert.equal(start.ok, true, JSON.stringify(start.error ?? {}));
  const seen = new Set();
  let cursor = 0;
  const deadline = Date.now() + 20_000;
  for (;;) {
    const wait = await call('delivery.wait', { afterSequence: cursor, timeoutMs: 3_000 });
    for (const delivery of wait.result.deliveries) {
      seen.add(delivery.type);
      cursor = Math.max(cursor, delivery.sequence);
    }
    if (seen.has('worker_done') && seen.has('cleanup_recorded')) break;
    if (Date.now() > deadline) break;
  }
  assert.equal(seen.has('worker_done'), true, `terminal missing; saw ${[...seen].join(',')}`);
  assert.equal(seen.has('cleanup_recorded'), true);
  const inspect = await call('coordination.inspect', {});
  assert.equal(inspect.result.tasks[taskId].state, 'awaiting_acceptance');
});
