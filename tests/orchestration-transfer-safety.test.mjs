import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { readAuthorityRecord, readClientCapability } from '../src/orchestration/authority.mjs';
import { deriveEndpoint, requestIpc } from '../src/orchestration/ipc.mjs';
import { resolveOrchestrationRoots } from '../src/orchestration/paths.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import {
  ORCHESTRATION_PROTOCOL,
  WORKER_CALLBACK_PROTOCOL,
} from '../src/orchestration/constants.mjs';
import {
  createPublicLifecycle,
  createTrustedCoordinatorConfig,
  asPublicAdapter,
} from '../src/orchestration/public-adapters.mjs';

const FIXTURES = new URL('./fixtures/orchestration/', import.meta.url).pathname;
const NONTERMINAL = new Set(['created', 'assigned', 'active', 'waiting', 'settling']);

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r10a-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function killWorkerGroup(binding) {
  const pid = binding?.processIdentity?.pid;
  if (!Number.isInteger(pid)) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

let coordCounter = 0;

async function startOwnedSupervisor(t, name, workerMode) {
  const stateDir = tempDir(t, name);
  const coordinationId = `coord_r10a_${(coordCounter += 1)}`;
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
  t.after(async () => {
    // Safety sweep: no fixture worker may outlive the test process.
    try {
      const parsed = JSON.parse(readFileSync(join(
        resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } }).stateRoot,
        'coordinations', coordinationId, 'runtime-bindings.json',
      ), 'utf8'));
      for (const record of Object.values(parsed?.bindings ?? {})) killWorkerGroup(record);
    } catch { /* nothing recorded */ }
    await sup.stop();
  });
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const coordinationDir = join(roots.stateRoot, 'coordinations', coordinationId);
  const call = async (operation, input, epochOverride) => requestIpc(
    deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId }),
    {
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
      coordinationId,
      fenceEpoch: epochOverride ?? sup.__store.state.fenceEpoch,
      capability: readClientCapability({ coordinationDir }),
      operation,
      input,
    },
    { timeoutMs: 20_000 },
  );
  return { sup, call, coordinationId, coordinationDir, stateDir };
}

function readBindingRecord(coordinationDir, dispatchId) {
  try {
    const parsed = JSON.parse(readFileSync(join(coordinationDir, 'runtime-bindings.json'), 'utf8'));
    return parsed.bindings?.[dispatchId] ?? null;
  } catch {
    return null;
  }
}

async function launchLiveWorker(harness, objective) {
  const created = await harness.call('task.create', {
    packet: { objective, workspace: tmpdir(), allowedReadRoots: [], allowedWriteRoots: [] },
  });
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  const started = await harness.call('dispatch.start', { taskId: created.result.taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));
  const dispatchId = started.result.dispatchId;
  const deadline = Date.now() + 10_000;
  let record = null;
  for (;;) {
    record = readBindingRecord(harness.coordinationDir, dispatchId);
    if (record?.processIdentity?.pid && harness.sup.__store.state.dispatches[dispatchId]?.state === 'active') break;
    if (Date.now() > deadline) break;
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
  assert.equal(harness.sup.__store.state.dispatches[dispatchId]?.state, 'active', 'worker must reach active for this proof');
  assert.ok(Number.isInteger(record?.processIdentity?.pid), 'a live owned worker must have a durable binding record with a pid');
  return { taskId: created.result.taskId, dispatchId, binding: record };
}

async function sendWorkerHeartbeat(harness, dispatchId, callbackSeq) {
  const capFile = join(harness.coordinationDir, 'dispatch-capabilities', `${dispatchId}.cap`);
  const cap = JSON.parse(readFileSync(capFile, 'utf8'));
  const fenceEpoch = harness.sup.__store.state.fenceEpoch;
  return requestIpc(cap.endpoint, {
    protocol: ORCHESTRATION_PROTOCOL,
    requestId: `req_cbk_${Math.random().toString(36).slice(2, 8)}`,
    coordinationId: cap.coordinationId,
    fenceEpoch,
    capability: cap.capabilityToken,
    operation: 'worker.heartbeat',
    input: {
      schema: WORKER_CALLBACK_PROTOCOL,
      callbackId: `cbk_r10a_${callbackSeq}_${Math.random().toString(36).slice(2, 8)}`,
      coordinationId: cap.coordinationId,
      taskId: cap.taskId,
      dispatchId: cap.dispatchId,
      bindingId: cap.bindingId,
      fenceEpoch,
      callbackSeq,
      operation: 'worker.heartbeat',
      input: {},
    },
  }, { timeoutMs: 10_000 });
}

async function awaitTerminal(harness, dispatchId, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const record = harness.sup.__store.state.dispatches[dispatchId];
    if (record && !NONTERMINAL.has(record.state)) return record;
    if (Date.now() > deadline) return record ?? null;
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
}

test('R10A: ownership transfer refuses while a live owned dispatch runs and control stays intact', async (t) => {
  const harness = await startOwnedSupervisor(t, 'refuse', 'ignore-sigint');
  const { dispatchId } = await launchLiveWorker(harness, 'long-running r10a canary payload');

  const epochBefore = harness.sup.__store.state.fenceEpoch;
  const tokenBefore = readClientCapability({ coordinationDir: harness.coordinationDir });
  const authorityBefore = readAuthorityRecord({ coordinationDir: harness.coordinationDir });

  const refused = await harness.call('coordination.transfer', { owner: { host: 'elsewhere' } });

  assert.equal(refused.ok, false, `transfer under an active dispatch must refuse, got ${JSON.stringify(refused)}`);
  assert.equal(refused.error?.code, 'TRANSFER_BLOCKED_ACTIVE_DISPATCHES', 'refusal must be the stable typed error');
  assert.deepEqual(refused.error?.details?.activeDispatches, [dispatchId], 'refusal must name the live dispatch');

  // Refusal mutates NOTHING.
  assert.equal(harness.sup.__store.state.fenceEpoch, epochBefore, 'refusal must not bump the fence epoch');
  assert.equal(
    readClientCapability({ coordinationDir: harness.coordinationDir }),
    tokenBefore,
    'refusal must not rotate the coordinator token',
  );
  const authorityAfter = readAuthorityRecord({ coordinationDir: harness.coordinationDir });
  assert.equal(authorityAfter.authorityRevisionId, authorityBefore.authorityRevisionId, 'refusal must not rotate authority');
  assert.deepEqual(authorityAfter.owner, authorityBefore.owner, 'refusal must not change the owner');

  // The live worker keeps every control surface.
  const heartbeat = await sendWorkerHeartbeat(harness, dispatchId, 1);
  assert.equal(heartbeat.ok, true, `worker callbacks must survive a refused transfer: ${JSON.stringify(heartbeat.error ?? {})}`);

  const interrupt = await harness.call('dispatch.interrupt', { dispatchId, reason: 'r10a-control-proof' });
  assert.equal(interrupt.ok, true, `interrupt must keep controlling the worker after refusal: ${JSON.stringify(interrupt)}`);
  assert.equal(interrupt.result?.stopped, true);

  const terminal = await awaitTerminal(harness, dispatchId);
  assert.equal(NONTERMINAL.has(terminal?.state), false, `dispatch must reconcile terminal, got ${terminal?.state}`);

  // Quiescent at last: the SAME operation succeeds only now.
  const accepted = await harness.call('coordination.transfer', { owner: { host: 'elsewhere' } });
  assert.equal(accepted.ok, true, `transfer must succeed once quiescent: ${JSON.stringify(accepted.error ?? {})}`);
  assert.equal(accepted.result.fenceEpoch, epochBefore + 1);

  // A successful transfer fences the old epoch exactly as before.
  const staleFrame = await harness.call('coordination.inspect', {}, epochBefore);
  assert.equal(staleFrame.ok, false);
  assert.equal(staleFrame.error?.code, 'STALE_COORDINATOR_EPOCH');
}, { timeout: 60_000 });

test('R10A: quiescent transfer rotates authority and fences the old epoch', async (t) => {
  const harness = await startOwnedSupervisor(t, 'quiesce', 'ordered');
  const tokenBefore = readClientCapability({ coordinationDir: harness.coordinationDir });

  const transferred = await harness.call('coordination.transfer', { owner: { host: 'new-owner' } });
  assert.equal(transferred.ok, true, JSON.stringify(transferred));
  assert.equal(transferred.result.fenceEpoch, 2);
  assert.notEqual(
    readClientCapability({ coordinationDir: harness.coordinationDir }),
    tokenBefore,
    'a real transfer rotates the coordinator token',
  );
  const authority = readAuthorityRecord({ coordinationDir: harness.coordinationDir });
  assert.equal(authority.owner.host, 'new-owner');

  const stale = await harness.call('coordination.inspect', {}, 1);
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, 'STALE_COORDINATOR_EPOCH');
  const fresh = await harness.call('coordination.inspect', {});
  assert.equal(fresh.ok, true);
}, { timeout: 30_000 });
