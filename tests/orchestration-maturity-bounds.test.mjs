import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { recordCanaryReceipt, canaryAdapterDigest } from '../src/orchestration/canary.mjs';

const FIXTURES = new URL('./fixtures/orchestration/', import.meta.url).pathname;

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r10f-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---- shared supervisor harness ---------------------------------------------

let coordCounter = 0;

async function startHarness(t, name, {
  workerMode = 'ordered',
  ownedAdapterOptions = {},
} = {}) {
  const stateDir = tempDir(t, name);
  const coordinationId = `coord_r10f_${(coordCounter += 1)}`;
  const { createOwnedProcessAdapter } = await import('../src/orchestration/adapters/owned-process.mjs');
  const inner = createOwnedProcessAdapter({ stateDir: join(stateDir, 'op'), ...ownedAdapterOptions });
  const config = createTrustedCoordinatorConfig({
    stateDir,
    allowFixtureDispatch: true,
    confinement: 'disposable-workspace',
    disposableRoot: tmpdir(),
    ownedProcessCommand: {
      command: process.execPath,
      args: [join(FIXTURES, 'fake-worker.mjs')],
      env: { ...process.env, FAKE_WORKER_MODE: workerMode },
    },
  });
  const adapter = asPublicAdapter(inner, createPublicLifecycle('owned-process', inner, config));
  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'create',
    coordinationId,
    adapters: [adapter],
    trustedCoordinatorConfig: {
      allowFixtureDispatch: true,
      confinement: 'disposable-workspace',
      disposableRoot: tmpdir(),
    },
  });
  t.after(() => sup.stop());
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const coordinationDir = join(roots.stateRoot, 'coordinations', coordinationId);
  const call = async (operation, input) => requestIpc(
    deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId }),
    {
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
      coordinationId,
      fenceEpoch: sup.__store.state.fenceEpoch,
      capability: readClientCapability({ coordinationDir }),
      operation,
      input,
    },
    { timeoutMs: 20_000 },
  );
  return { sup, call, coordinationId, coordinationDir, stateDir, refsDir: join(coordinationDir, 'refs') };
}

async function seedTask(harness, packetOverrides = {}) {
  const workspace = join(harness.stateDir, `ws-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(workspace, { recursive: true });
  const created = await harness.call('task.create', {
    packet: {
      objective: 'r10f bounded evidence probe',
      workspace,
      allowedReadRoots: [workspace],
      allowedWriteRoots: [],
      ...packetOverrides,
    },
  });
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  return { taskId: created.result.taskId, workspace };
}

async function startDispatch(harness, taskId) {
  const started = await harness.call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));
  return started.result.dispatchId;
}

async function awaitSettled(harness, dispatchId, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const rec = harness.sup.__store.state.dispatches[dispatchId];
    if (rec?.state === 'settled') return rec;
    if (Date.now() > deadline) return rec ?? null;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function journalRecords(harness) {
  return readFileSync(join(harness.coordinationDir, 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// ---- A/B: executable-path identity at the REAL dispatch gate -----------------

const STUB_SOURCE = '#!/usr/bin/env node\n'
  + 'if (process.argv[2] === "--version") { process.stdout.write("10.10.10-r10f\\n"); process.exit(0); }\n'
  + 'process.stderr.write("r10f stub cannot serve\\n");\nprocess.exit(1);\n';

async function buildProviderHarness(t, binPath) {
  const stateDir = tempDir(t, 'provider');
  const coordinationId = `coord_r10f_prov_${(coordCounter += 1)}`;
  writeFileSync(binPath, STUB_SOURCE);
  chmodSync(binPath, 0o755);
  const { createOpenCodeServerAdapter } = await import('../src/orchestration/adapters/opencode-server.mjs');
  const inner = createOpenCodeServerAdapter({ stateDir: join(stateDir, 'oc'), openCodeBin: binPath });
  const config = createTrustedCoordinatorConfig({
    stateDir,
    confinement: 'disposable-workspace',
    disposableRoot: tmpdir(),
    openCodeBin: binPath,
  });
  const adapter = asPublicAdapter(inner, createPublicLifecycle('opencode-server', inner, config));
  const sup = await createSupervisor({
    env: {
      WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir,
      OPENCODE_BIN: binPath,
    },
    mode: 'create',
    coordinationId,
    adapters: [adapter],
    // NOTE: neither allowFixtureDispatch nor allowUnprovenProviderDispatch —
    // the receipt gate is fully ACTIVE.
    trustedCoordinatorConfig: {
      confinement: 'disposable-workspace',
      disposableRoot: tmpdir(),
    },
  });
  t.after(() => sup.stop());
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const coordinationDir = join(roots.stateRoot, 'coordinations', coordinationId);
  const call = async (operation, input) => requestIpc(
    deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId }),
    {
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
      coordinationId,
      fenceEpoch: sup.__store.state.fenceEpoch,
      capability: readClientCapability({ coordinationDir }),
      operation,
      input,
    },
    { timeoutMs: 30_000 },
  );
  const stateRoot = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } }).stateRoot;
  return { sup, call, stateDir, stateRoot };
}

test('R10F: identical binary bytes+version at a DIFFERENT canonical path are stale at the real dispatch gate', async (t) => {
  const bins = tempDir(t, 'bins');
  const stubA = join(bins, 'provider-a');
  const stubB = join(bins, 'provider-b-different-path');

  // Receipt earned against provider-a.
  const harnessA = await buildProviderHarness(t, stubA);
  recordCanaryReceipt(harnessA.stateRoot, {
    adapterId: 'opencode-server',
    adapterDigest: canaryAdapterDigest('opencode-server'),
    executablePathDigest: (await import('node:crypto')).createHash('sha256').update(readFileSync(stubA)).digest('hex'),
    executablePath: realpathSync(stubA),
    executableVersion: '10.10.10-r10f',
    runtimeVersion: process.version,
    platformIdentity: `${process.platform}/${process.arch}`,
    contractVersion: (await import('../src/orchestration/canary.mjs')).CANARY_CONTRACT_VERSION,
    capabilities: {
      launch: 'pass', progressStream: 'pass', promptRoundTrip: 'pass',
      cleanup: 'pass', publicSupervisorLifecycle: 'pass',
    },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    scenario: 'r10f-unit',
    evidence: {},
  });

  // Now the SAME bytes live at provider-b: content digest AND version match,
  // only the canonical path drifted. The dispatch gate MUST refuse.
  const harnessB = await buildProviderHarness(t, stubB);
  // Share the receipt state root with harness A by copying it in.
  const receiptSrc = join(harnessA.stateRoot, 'canary', 'opencode-server.json');
  const receiptDstDir = join(harnessB.stateRoot, 'canary');
  mkdirSync(receiptDstDir, { recursive: true });
  writeFileSync(join(receiptDstDir, 'opencode-server.json'), readFileSync(receiptSrc));

  const workspace = join(harnessB.stateDir, 'ws');
  mkdirSync(workspace, { recursive: true });
  const created = await harnessB.call('task.create', {
    packet: { objective: 'path drift probe', workspace, allowedReadRoots: [workspace], allowedWriteRoots: [] },
  });
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  const started = await harnessB.call('dispatch.start', { taskId: created.result.taskId, adapterId: 'opencode-server' });

  assert.equal(started.ok, false, `identical bytes at another path must be stale: ${JSON.stringify(started)}`);
  assert.equal(started.error?.code, 'POLICY_DENIED', JSON.stringify(started.error ?? {}));
  // The refusal must come from the RECEIPT GATE itself, not from some later
  // launch-side policy error that merely shares the code.
  assert.match(
    String(started.error?.message ?? ''),
    /requires current capability-specific canary evidence/,
    JSON.stringify(started.error ?? {}),
  );
}, { timeout: 90_000 });

test('R10F: control — the receipt still admits its OWN canonical path through the gate', async (t) => {
  const stubA = join(tempDir(t, 'ctrl'), 'provider-a');
  const harness = await buildProviderHarness(t, stubA);
  const canaryMod = await import('../src/orchestration/canary.mjs');
  recordCanaryReceipt(harness.stateRoot, {
    adapterId: 'opencode-server',
    adapterDigest: canaryMod.canaryAdapterDigest('opencode-server'),
    executablePathDigest: (await import('node:crypto')).createHash('sha256').update(readFileSync(stubA)).digest('hex'),
    executablePath: realpathSync(stubA),
    executableVersion: '10.10.10-r10f',
    runtimeVersion: process.version,
    platformIdentity: `${process.platform}/${process.arch}`,
    contractVersion: canaryMod.CANARY_CONTRACT_VERSION,
    capabilities: {
      launch: 'pass', progressStream: 'pass', promptRoundTrip: 'pass',
      cleanup: 'pass', publicSupervisorLifecycle: 'pass',
    },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    scenario: 'r10f-unit-control',
    evidence: {},
  });

  const workspace = join(harness.stateDir, 'ws');
  mkdirSync(workspace, { recursive: true });
  const created = await harness.call('task.create', {
    packet: { objective: 'control probe', workspace, allowedReadRoots: [workspace], allowedWriteRoots: [] },
  });
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  const started = await harness.call('dispatch.start', { taskId: created.result.taskId, adapterId: 'opencode-server' });
  // The GATE passes; the failure comes later from the stub's inability to
  // serve (config preflight / bootstrap) — maturity is honestly proven for
  // THIS exact canonical path binding.
  assert.equal(started.ok, false, JSON.stringify(started));
  assert.doesNotMatch(
    String(started.error?.message ?? ''),
    /requires current capability-specific canary evidence/,
    'the gate must NOT refuse the receipted canonical path',
  );
}, { timeout: 90_000 });

// ---- C: maxRefsTotalBytes is a COORDINATION-TOTAL quota ----------------------

const KB = 1024;

test('R10F: durable refs from ANY source count toward the coordination-total quota; recovery rebuilds from disk', async (t) => {
  const harness = await startHarness(t, 'quota', {
    workerMode: 'big',
    ownedAdapterOptions: { maxRefsTotalBytesForTest: 600 * KB },
  });

  // Durable evidence ALREADY in the coordination refs dir (another namespace/
  // prior owner): 512KB.
  mkdirSync(harness.refsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(harness.refsDir, 'ref_prior__seed.txt'), 'y'.repeat(512 * KB));

  // Dispatch #1 (fresh namespace): its own 300KB would fit per-namespace but
  // NOT against the coordination total.
  const journalBeforeD1 = journalRecords(harness).length;
  const { taskId: t1 } = await seedTask(harness);
  const d1 = await startDispatch(harness, t1);
  await awaitSettled(harness, d1);

  // Progress spills carry no top-level dispatchId; attribute them through
  // the journal WINDOW that belongs to this dispatch.
  const overflowEvents = journalRecords(harness)
    .slice(journalBeforeD1)
    .filter((record) => record.type === 'progress' && record.payload?.retentionOverflow === true);
  assert.equal(overflowEvents.length >= 1, true,
    'the spill must be dropped with typed bounded evidence when the coordination total is exceeded');
  const namesAfterFirst = readdirSync(harness.refsDir);
  assert.equal(namesAfterFirst.some((name) => name.includes(d1)), false,
    'dropped evidence must not be written');

  // Recovery/rebuild: remove the prior evidence; the recount from DISK lets
  // the next dispatch spill normally.
  rmSync(join(harness.refsDir, 'ref_prior__seed.txt'));
  const journalBeforeD2 = journalRecords(harness).length;
  const { taskId: t2 } = await seedTask(harness);
  const d2 = await startDispatch(harness, t2);
  await awaitSettled(harness, d2);
  const namesAfterSecond = readdirSync(harness.refsDir);
  assert.equal(namesAfterSecond.some((name) => name.includes(d2)), true,
    'after durable refs shrink, accounting rebuilt from disk must admit the spill');
  // Only the FIRST dispatch's spill may have been dropped; after the durable
  // refs shrank there is nothing left to drop.
  const overflow2 = journalRecords(harness)
    .slice(journalBeforeD2)
    .filter((record) => record.type === 'progress' && record.payload?.retentionOverflow === true);
  assert.equal(overflow2.length, 0);
}, { timeout: 120_000 });

test('R10F: concurrent spills stay inside the coordination-total bound without overwrite', async (t) => {
  const harness = await startHarness(t, 'conc', {
    workerMode: 'big',
    ownedAdapterOptions: { maxRefsTotalBytesForTest: 350 * KB },
  });
  const createdA = await seedTask(harness);
  const createdB = await seedTask(harness);
  const startedA = await harness.call('dispatch.start', { taskId: createdA.taskId, adapterId: 'owned-process' });
  const startedB = await harness.call('dispatch.start', { taskId: createdB.taskId, adapterId: 'owned-process' });
  assert.equal(startedA.ok, true && startedB.ok, true);
  await awaitSettled(harness, startedA.result.dispatchId);
  await awaitSettled(harness, startedB.result.dispatchId);

  const names = readdirSync(harness.refsDir);
  let totalBytes = 0;
  let spilled = 0;
  for (const name of names) {
    const size = statSync(join(harness.refsDir, name)).size;
    totalBytes += size;
    if (name.includes(startedA.result.dispatchId) || name.includes(startedB.result.dispatchId)) spilled += 1;
  }
  assert.equal(totalBytes <= 350 * KB, true,
    `coordination total ${totalBytes} exceeded the bound`);
  assert.equal(spilled <= 1, true,
    `at most ONE concurrent dispatch may spill under this bound, saw ${spilled}`);
  const overflows = journalRecords(harness)
    .filter((record) => record.type === 'progress' && record.payload?.retentionOverflow === true);
  assert.equal(overflows.length >= 1, true, 'the dropped spill must carry typed overflow evidence');
}, { timeout: 120_000 });

// ---- D: task.cancel truthfulness --------------------------------------------

test('R10F: task.cancel never claims cancelled for an awaiting_acceptance task', async (t) => {
  const harness = await startHarness(t, 'cancel-await', { workerMode: 'ordered' });
  const { taskId } = await seedTask(harness);
  const dispatchId = await startDispatch(harness, taskId);
  const rec = await awaitSettled(harness, dispatchId);
  assert.equal(rec?.terminalOutcome, 'completed');
  assert.equal(harness.sup.__store.state.tasks[taskId]?.state, 'awaiting_acceptance');

  const before = journalRecords(harness).length;
  const cancelled = await harness.call('task.cancel', { taskId, reason: 'post-terminal-probe' });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled.error ?? {}));
  assert.equal(cancelled.result?.cancelled, false,
    `a post-terminal task must not claim cancelled: ${JSON.stringify(cancelled.result ?? {})}`);
  assert.equal(cancelled.result?.alreadyTerminal, true);
  assert.equal(harness.sup.__store.state.tasks[taskId]?.state, 'awaiting_acceptance');
  const journalText = readFileSync(join(harness.coordinationDir, 'events.jsonl'), 'utf8');
  assert.equal(journalText.slice(before).includes('"state":"cancelled"'), false,
    'no cancellation commit may happen for an awaiting_acceptance task');
}, { timeout: 90_000 });

test('R10F: cancelling an already-cancelled task is idempotent and truthful', async (t) => {
  const harness = await startHarness(t, 'cancel-twice', { workerMode: 'ignore-sigint' });
  const { taskId } = await seedTask(harness);
  const dispatchId = await startDispatch(harness, taskId);
  const deadline = Date.now() + 8000;
  while (harness.sup.__store.state.dispatches[dispatchId]?.state !== 'active' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const first = await harness.call('task.cancel', { taskId, reason: 'first' });
  assert.equal(first.ok, true, JSON.stringify(first.error ?? {}));
  if (first.result?.cancelled === true) {
    assert.equal(harness.sup.__store.state.tasks[taskId]?.state, 'cancelled');
  } else {
    // The worker raced to terminal first: the truthful answer is
    // already-terminal, never a fabricated cancellation claim.
    assert.equal(first.result?.alreadyTerminal, true, JSON.stringify(first.result ?? {}));
  }

  // WHATEVER the first race produced, a SECOND cancel can never truthfully
  // claim cancelled again.
  const second = await harness.call('task.cancel', { taskId, reason: 'second' });
  assert.equal(second.ok, true, JSON.stringify(second.error ?? {}));
  assert.equal(second.result?.cancelled, false,
    `a cancelled/post-terminal task must not claim cancelled again: ${JSON.stringify(second.result ?? {})}`);
  assert.equal(second.result?.alreadyTerminal, true);
  assert.equal(['cancelled', 'awaiting_acceptance'].includes(second.result?.state), true,
    `state must be reported honestly: ${second.result?.state}`);
}, { timeout: 90_000 });
