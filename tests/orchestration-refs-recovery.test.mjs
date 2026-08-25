import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
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
import { createAtomicExclusiveFile } from '../src/orchestration/atomic-file.mjs';

const FIXTURES = new URL('./fixtures/orchestration/', import.meta.url).pathname;
const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r9f-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let coordCounter = 0;

async function startSupervisor(t, name, { adapters, workerMode }) {
  const stateDir = tempDir(t, name);
  const coordinationId = `coord_r9f_${(coordCounter += 1)}`;
  const { createOwnedProcessAdapter } = await import('../src/orchestration/adapters/owned-process.mjs');
  const inner = createOwnedProcessAdapter({ stateDir: join(stateDir, 'op') });
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
  // Central leak containment: EVERY supervisor this helper creates is closed
  // through t.after, so `node --test` can always exit on its own. stop() is
  // idempotent, explicit per-test stops stay safe.
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
  return { sup, call, coordinationId, coordinationDir, stateDir };
}

async function seedAndDispatch(call, objective) {
  const created = await call('task.create', {
    packet: { objective, workspace: tmpdir(), allowedReadRoots: [], allowedWriteRoots: [] },
  });
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  const started = await call('dispatch.start', { taskId: created.result.taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));
  return started.result.dispatchId;
}

async function awaitSettled(sup, dispatchId, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const rec = sup.__store.state.dispatches[dispatchId];
    if (rec?.state === 'settled') return rec;
    if (Date.now() > deadline) return rec ?? null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('R9F: sequential spills across dispatches never overwrite prior evidence', async (t) => {
  const harness = await startSupervisor(t, 'seq', { workerMode: 'big' });

  const firstId = await seedAndDispatch(harness.call, 'big one');
  await awaitSettled(harness.sup, firstId);
  const refsAfterFirst = readdirSync(join(harness.coordinationDir, 'refs')).sort();
  assert.equal(refsAfterFirst.length >= 1, true, 'first dispatch must spill a bounded ref');
  const firstFile = join(harness.coordinationDir, 'refs', refsAfterFirst[0]);
  const firstDigestBefore = createHash('sha256').update(readFileSync(firstFile)).digest('hex');

  const secondId = await seedAndDispatch(harness.call, 'big two');
  await awaitSettled(harness.sup, secondId);
  const refsAfterSecond = readdirSync(join(harness.coordinationDir, 'refs')).sort();
  assert.equal(refsAfterSecond.length >= 2, true, 'second dispatch adds its own refs');
  // Namespaced names differ per dispatch and the FIRST evidence is untouched.
  assert.equal(
    createHash('sha256').update(readFileSync(firstFile)).digest('hex'),
    firstDigestBefore,
    'the second dispatch may never overwrite the first dispatch evidence',
  );
  assert.match(refsAfterFirst[0], /big-one|big-two|[0-9a-f-]{36}/);
  assert.notEqual(
    refsAfterSecond.find((name) => !refsAfterFirst.includes(name)),
    undefined,
  );
});

test('R9F: concurrent spills land in disjoint, fully-namespaced files', async (t) => {
  const harness = await startSupervisor(t, 'conc', { workerMode: 'big' });
  const idA = await seedAndDispatch(harness.call, 'concurrent alpha');
  const idB = await seedAndDispatch(harness.call, 'concurrent beta');
  const recA = await awaitSettled(harness.sup, idA);
  const recB = await awaitSettled(harness.sup, idB);
  assert.equal(recA?.state, 'settled');
  assert.equal(recB?.state, 'settled');

  const refs = readdirSync(join(harness.coordinationDir, 'refs'));
  const aRefs = refs.filter((name) => name.includes(idA));
  const bRefs = refs.filter((name) => name.includes(idB));
  assert.equal(aRefs.length >= 1, true, `dispatch A namespaces its refs: ${JSON.stringify(refs)}`);
  assert.equal(bRefs.length >= 1, true, `dispatch B namespaces its refs: ${JSON.stringify(refs)}`);
  // No shared filenames between the two concurrent dispatches.
  assert.equal(aRefs.some((name) => bRefs.includes(name)), false);
});

test('R9F: exclusive atomic creation refuses collisions without overwriting', (t) => {
  const dir = tempDir(t, 'xlock');
  const target = join(dir, 'ref.txt');
  createAtomicExclusiveFile(target, 'original\n');
  assert.equal(readFileSync(target, 'utf8'), 'original\n');
  assert.throws(
    () => createAtomicExclusiveFile(target, 'overwritten\n'),
    (error) => /collision|exists/i.test(error.message),
    'second exclusive create on the same path must refuse',
  );
  assert.equal(readFileSync(target, 'utf8'), 'original\n', 'content survives the refused collision');
});

test('R9F: a dead worker after restart reconciles to a truthful lost state', async (t) => {
  const harness = await startSupervisor(t, 'restart', { workerMode: 'ignore-sigint' });
  const dispatchId = await seedAndDispatch(harness.call, 'survive nothing');

  // Wait until active, then capture the proven worker pid from the durable
  // binding table before taking the supervisor down.
  let sawActive = false;
  let workerPid = null;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !sawActive) {
    sawActive = harness.sup.__store.state.dispatches[dispatchId]?.state === 'active';
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(sawActive, true);
  try {
    const bindings = JSON.parse(readFileSync(
      join(harness.coordinationDir, 'runtime-bindings.json'),
      'utf8',
    ));
    workerPid = bindings.bindings?.[dispatchId]?.processIdentity?.pid ?? null;
  } catch { /* binding file unreadable; pid stays null */ }
  assert.equal(Number.isInteger(workerPid), true, 'a live owned worker must have a recorded pid');

  await harness.sup.stop();
  // The worker DIES while no supervisor exists.
  try { process.kill(-workerPid, 'SIGKILL'); } catch { try { process.kill(workerPid, 'SIGKILL'); } catch { /* gone */ } }
  const workerGone = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      try { process.kill(workerPid, 0); } catch { return true; }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  })();
  assert.equal(workerGone, true, 'test prerequisite: the worker must actually die');

  const restarted = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: harness.stateDir },
    mode: 'recover',
    coordinationId: harness.coordinationId,
    adapters: [],
  });
  t.after(() => restarted.stop());

  const record = restarted.__store.state.dispatches[dispatchId];
  // Truthful reconciliation after a worker death around a restart is EITHER
  // a typed lost state (crash window: nobody proved the exit live) OR a
  // durably settled cancelled outcome (the dying owner recorded the exit).
  // What it may NEVER be is a stale 'active' pretending nothing happened.
  const truthfullyReconciled = record?.state === 'lost'
    || (record?.state === 'settled' && record?.terminalOutcome === 'cancelled');
  assert.equal(
    truthfullyReconciled,
    true,
    `dead worker must reconcile truthfully, got ${record?.state}/${record?.terminalOutcome}`,
  );
});

test('R9F: telemetry-only bindings degrade honestly instead of staying active forever', async (t) => {
  const ALL_FALSE = Object.fromEntries([
    'liveEvents', 'explicitResume', 'externalAttach', 'questionChannel', 'permissionControl',
    'sameTurnSteer', 'gracefulInterrupt', 'preToolGate', 'processOwnership', 'fileEvents', 'testEvents',
  ].map((k) => [k, false]));
  const inner = {
    id: 'owned-process',
    maturity: 'fixture-only',
    capabilities: { ...ALL_FALSE },
    probe: async () => ({ adapterId: 'owned-process', available: true, maturity: 'fixture-only', capabilities: { ...ALL_FALSE } }),
    spawn: async ({ task, dispatch, emit }) => {
      emit('worker_started', { dispatchId: dispatch.dispatchId });
      return { ok: true, binding: { sessionId: 'ses_t', guaranteeTier: 'owned-process' }, done: new Promise(() => {}) };
    },
    attach() { throw new Error('unsupported'); },
    subscribe() { throw new Error('unsupported'); },
    readSession: async () => null,
    sendReply() { throw new Error('unsupported'); },
    sendGuidance() { throw new Error('unsupported'); },
    resolvePermission() { throw new Error('unsupported'); },
    interrupt: async () => ({ ok: true }),
    close: async () => ({ disposition: 'closed' }),
    sanitize: (e) => e,
  };
  const config = createTrustedCoordinatorConfig({
    stateDir: tmpdir(),
    allowFixtureDispatch: true,
    confinement: 'disposable-workspace',
    disposableRoot: tmpdir(),
    ownedProcessCommand: { command: process.execPath, args: ['-e', ''], env: {} },
  });
  const adapter = asPublicAdapter(inner, createPublicLifecycle('owned-process', inner, config));

  const stateDir = tempDir(t, 'telemetry');
  const coordinationId = `coord_r9f_tel_${(coordCounter += 1)}`;
  const sup1 = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'create',
    coordinationId,
    adapters: [adapter],
    trustedCoordinatorConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: tmpdir() },
  });
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const coordinationDir = join(roots.stateRoot, 'coordinations', coordinationId);
  const call1 = async (operation, input) => requestIpc(
    deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId }),
    {
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
      coordinationId,
      fenceEpoch: sup1.__store.state.fenceEpoch,
      capability: readClientCapability({ coordinationDir }),
      operation,
      input,
    },
    { timeoutMs: 20_000 },
  );
  const created = await call1('task.create', {
    packet: { objective: 'Telemetry only', workspace: tmpdir(), allowedReadRoots: [], allowedWriteRoots: [] },
  });
  const started = await call1('dispatch.start', { taskId: created.result.taskId, adapterId: 'owned-process' });
  const dispatchId = started.result.dispatchId;
  await sup1.stop();

  const sup2 = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'recover',
    coordinationId,
    adapters: [],
  });
  t.after(() => sup2.stop());
  const record = sup2.__store.state.dispatches[dispatchId];
  assert.equal(record?.state, 'lost', `unattachable telemetry dispatch must type lost: ${record?.state}`);

  // The reconciliation evidence names the degradation explicitly.
  const journalText = readFileSync(join(coordinationDir, 'events.jsonl'), 'utf8');
  assert.match(journalText, /degraded|unattachable|telemetry/i,
    'reconciliation reason must describe WHY the dispatch was lost');
});

test('R9F: kill switch checks run against the INSTALLED artifact, never the source checkout', () => {
  const script = readFileSync(join(ROOT, 'scripts/orchestration-package-closure.mjs'), 'utf8');
  // The disabled-CLI probes must point at the installed package directory.
  assert.ok(
    script.includes("join(installedPkgDir, 'bin/webmcp-ai.mjs'), ...args"),
    'kill switch must execute the INSTALLED bin/webmcp-ai.mjs',
  );
  assert.equal(script.includes("join(repoRoot, 'bin/webmcp-ai.mjs')"), false,
    'kill switch may never fall back to the repo checkout binary');
});
