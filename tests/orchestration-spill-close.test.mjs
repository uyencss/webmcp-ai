import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import {
  asPublicAdapter,
  createPublicLifecycle,
  createTrustedCoordinatorConfig,
} from '../src/orchestration/public-adapters.mjs';
import { readClientCapability } from '../src/orchestration/authority.mjs';
import { deriveEndpoint, requestIpc } from '../src/orchestration/ipc.mjs';
import {
  createCoordinationLayout,
  ensureOrchestrationRoots,
  resolveOrchestrationRoots,
} from '../src/orchestration/paths.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { commitDelivery, openCoordinationStore } from '../src/orchestration/store.mjs';
import { writeAtomicJson } from '../src/orchestration/atomic-file.mjs';
import { MANIFEST_SCHEMA, ORCHESTRATION_PROTOCOL, ORCHESTRATION_LIMITS } from '../src/orchestration/constants.mjs';

const TEST_BASE = mkdtempSync(join(tmpdir(), 'r12h-'));
after(() => {
  try { rmSync(TEST_BASE, { recursive: true, force: true }); } catch { /* best effort */ }
});

function tempDir(name) {
  const dir = join(TEST_BASE, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---------------- spill transactionality (unit-level store) ----------- */

function freshStore(t, name) {
  const stateDir = tempDir(name);
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  ensureOrchestrationRoots(roots);
  const layout = createCoordinationLayout(roots.stateRoot, `coord_${name}`);
  writeAtomicJson(layout.manifestPath, {
    schema: MANIFEST_SCHEMA,
    coordinationId: `coord_${name}`,
    fenceEpoch: 1,
    processGeneration: 1,
    createdAt: new Date().toISOString(),
    owner: null,
  });
  const store = openCoordinationStore(layout);
  return { store, layout };
}

function bigPayload(bytes) {
  // A single long string survives sanitization and exceeds the inline bound
  // while staying far under the ref ceiling.
  return { summary: 'head', blob: 'y'.repeat(bytes) };
}

test('R12H: a reducer-invalid oversized event leaves NO orphan ref and does not advance the sequence', (t) => {
  const { store, layout } = freshStore(t, 'spill-invalid');
  commitDelivery(store, { type: 'task_created', payload: { taskId: 'task_s' } });
  commitDelivery(store, { type: 'dispatch_created', payload: { dispatchId: 'disp_s', taskId: 'task_s' } });

  const sequenceBefore = store.state.lastSequence;
  const refsBefore = existsSync(layout.refsDir) ? readdirSync(layout.refsDir).sort() : [];
  const quotaFile = join(layout.coordinationDir, 'refs-quota.json');
  const quotaBefore = existsSync(quotaFile) ? JSON.parse(readFileSync(quotaFile, 'utf8')) : null;

  // ILLEGAL transition AND oversized: the reducer rejects it.
  assert.throws(
    () => commitDelivery(store, {
      type: 'dispatch_state_changed',
      payload: { dispatchId: 'disp_s', taskId: 'task_s', state: 'settled', ...bigPayload(400 * 1024) },
    }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  assert.equal(store.state.lastSequence, sequenceBefore, 'a rejected event must not advance the sequence');
  const refsAfter = existsSync(layout.refsDir) ? readdirSync(layout.refsDir).sort() : [];
  assert.deepEqual(refsAfter, refsBefore, `no orphan ref may remain (${refsAfter})`);
  const quotaAfter = existsSync(quotaFile) ? JSON.parse(readFileSync(quotaFile, 'utf8')) : null;
  if (quotaBefore !== null && quotaAfter !== null) {
    assert.equal(JSON.stringify(quotaAfter), JSON.stringify(quotaBefore), 'quota accounting must be untouched by a rejected spill');
  }

  // The SAME next sequence must now accept a VALID oversized event — no
  // EEXIST wedge from any leftover.
  const ok = commitDelivery(store, {
    type: 'progress',
    payload: { dispatchId: 'disp_s', taskId: 'task_s', summary: 'big-but-valid', ...bigPayload(320 * 1024) },
  });
  assert.ok(ok.delivery, 'the valid oversized event must commit on the same sequence slot');
  assert.equal(ok.delivery.sequence, sequenceBefore + 1);
  const finalRefs = readdirSync(layout.refsDir);
  assert.equal(finalRefs.length >= 1, true, 'the committed spill ref exists');
});

test('R12H: a crash-leftover ref at the natural name cannot wedge the NEXT spill of that sequence', (t) => {
  const { store, layout } = freshStore(t, 'spill-wedge');
  commitDelivery(store, { type: 'task_created', payload: { taskId: 'task_w' } });
  commitDelivery(store, { type: 'dispatch_created', payload: { dispatchId: 'disp_w', taskId: 'task_w' } });

  const sequence = store.state.lastSequence + 1;
  mkdirSync(layout.refsDir, { recursive: true });
  // Simulate an ancient crash-leftover occupying the natural name.
  writeFileSync(join(layout.refsDir, `ref_${String(sequence).padStart(6, '0')}.json`), '{"orphan":true}');

  const ok = commitDelivery(store, {
    type: 'progress',
    payload: { dispatchId: 'disp_w', taskId: 'task_w', summary: 'retry-slot', ...bigPayload(320 * 1024) },
  });
  assert.ok(ok.delivery, 'spill must find a suffix slot instead of failing');
  assert.match(String(ok.delivery.payload.ref ?? ''), /-r\d+\.json$/, 'the retry suffix proves the wedge bypass');
});

/* ---------------- coordination.close honesty (supervisor-level) ------- */

const ALL_FALSE_CAPABILITIES = Object.fromEntries([
  'liveEvents', 'explicitResume', 'externalAttach', 'questionChannel', 'permissionControl',
  'sameTurnSteer', 'gracefulInterrupt', 'preToolGate', 'processOwnership', 'fileEvents', 'testEvents',
].map((key) => [key, key === 'processOwnership']));

test('R12H: terminal-before-cleanup DEFERS close; a later proven settle lets it close once', { timeout: 30_000 }, async (t) => {
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},10000)'], { stdio: 'ignore', detached: true });
  t.after(() => {
    try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { try { sleeper.kill('SIGKILL'); } catch { /* gone */ } }
  });
  await new Promise((r) => setTimeout(r, 120));

  let resolveDone;
  const donePromise = new Promise((resolve) => { resolveDone = resolve; });
  let finalizeCalls = 0;
  const deferredFinalizes = [];

  const inner = {
    id: 'owned-process',
    maturity: 'fixture-only',
    capabilities: { ...ALL_FALSE_CAPABILITIES },
    probe: async () => ({ adapterId: 'owned-process', available: true, maturity: 'fixture-only', capabilities: { ...ALL_FALSE_CAPABILITIES } }),
    spawn: async ({ task, dispatch, emit }) => {
      emit('worker_started', { dispatchId: dispatch.dispatchId });
      return {
        ok: true,
        binding: {
          sessionId: 'ses_h',
          guaranteeTier: 'owned-process',
          processIdentity: {
            pid: sleeper.pid,
            processGroupId: sleeper.pid,
            startIdentity: await (await import('../src/orchestration/process-identity.mjs'))
              .createPlatformIdentityDeps().getStartIdentity(sleeper.pid),
            identityProven: true,
          },
        },
        done: donePromise,
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
    stateDir: TEST_BASE,
    allowFixtureDispatch: true,
    confinement: 'disposable-workspace',
    disposableRoot: tmpdir(),
    ownedProcessCommand: { command: process.execPath, args: ['-e', ''], env: {} },
  });
  const lifecycle = createPublicLifecycle('owned-process', inner, config);
  lifecycle.finalize = async () => {
    finalizeCalls += 1;
    const deferred = { resolved: false };
    const promise = new Promise((resolve) => {
      deferred.resolve = (value) => { deferred.resolved = true; resolve(value); };
    });
    deferredFinalizes.push(deferred);
    return promise;
  };
  const adapter = asPublicAdapter(inner, lifecycle);

  const stateDir = tempDir('close-defer');
  const coordinationId = 'coord_r12h_close';
  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'create',
    coordinationId,
    adapters: [adapter],
    trustedCoordinatorConfig: createTrustedCoordinatorConfig({
      stateDir: TEST_BASE,
      allowFixtureDispatch: true,
      confinement: 'disposable-workspace',
      disposableRoot: tmpdir(),
    }),
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

  const created = await call('task.create', { packet: { objective: 'x', workspace: tempDir('ws-close'), allowedReadRoots: [], allowedWriteRoots: [] } });
  const started = await call('dispatch.start', { taskId: created.result.taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));

  // Terminal lands FIRST; cleanup/finalization is still parked.
  resolveDone({ terminalType: 'worker_done', exitCode: 0 });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(sup.__store.state.dispatches[started.result.dispatchId].state, 'settling');

  // Close MUST defer while settlement is unresolved.
  const earlyClose = await call('coordination.close', {});
  assert.equal(earlyClose.ok, false, `close must defer during unresolved settlement (${JSON.stringify(earlyClose)})`);
  assert.equal(earlyClose.error?.code, 'WORKER_STOP_UNPROVEN');
  assert.equal(sup.__store.state.coordinationState, 'closing', 'deferred close stays retryable in closing');

  // The finalizer completes PROVENLY now → the dispatch settles.
  deferredFinalizes[0]?.resolve({ ok: true, disposition: 'group-stopped', exitProven: true, signalsAttempted: ['GROUP_SIGTERM'] });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sup.__store.state.dispatches[started.result.dispatchId].state, 'settled');

  // Retry path intact: the SAME closing coordination can now close ONCE.
  const lateClose = await call('coordination.close', {});
  assert.equal(lateClose.ok, true, JSON.stringify(lateClose.error ?? {}));
  assert.equal(lateClose.result.closed, true);
  assert.equal(sup.__store.state.coordinationState, 'closed');
  void finalizeCalls;
});
