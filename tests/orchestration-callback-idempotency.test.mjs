import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MANIFEST_SCHEMA, WORKER_CALLBACK_PROTOCOL } from '../src/orchestration/constants.mjs';
import {
  resolveOrchestrationRoots,
  ensureOrchestrationRoots,
  createCoordinationLayout,
} from '../src/orchestration/paths.mjs';
import { createPlatformIdentityDeps } from '../src/orchestration/process-identity.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { openCoordinationStore, commitDelivery } from '../src/orchestration/store.mjs';
import { writeAtomicJson } from '../src/orchestration/atomic-file.mjs';

const COORD = 'coord_cbid';

function tempStateDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r2-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function prepareCoordination(t, name) {
  const stateDir = tempStateDir(t, name);
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  ensureOrchestrationRoots(roots);
  const layout = createCoordinationLayout(roots.stateRoot, COORD);
  writeAtomicJson(layout.manifestPath, {
    schema: MANIFEST_SCHEMA,
    coordinationId: COORD,
    fenceEpoch: 1,
    processGeneration: 1,
    createdAt: new Date().toISOString(),
    owner: null,
  });
  void layout;
  seedPending = true;
  return stateDir;
}
let seedPending = false;

function makeCallback(operation, seq, extra = {}) {
  return {
    schema: WORKER_CALLBACK_PROTOCOL,
    callbackId: `cbk_${operation.replace('.', '_')}_${seq}`,
    coordinationId: COORD,
    taskId: 'task_cb',
    dispatchId: 'disp_cb',
    bindingId: 'worker_cb',
    fenceEpoch: 1,
    operation,
    callbackSeq: seq,
    input: { summary: `payload-${seq}` },
    ...extra,
  };
}

async function startedSupervisor(stateDir, mode = 'create') {
  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode,
    coordinationId: COORD,
  });
  if (mode === 'create' && seedPending) {
    seedPending = false;
    commitDelivery(sup.__store, { type: 'task_created', payload: { taskId: 'task_cb' } });
    commitDelivery(sup.__store, { type: 'dispatch_created', payload: { dispatchId: 'disp_cb', taskId: 'task_cb' } });
    commitDelivery(sup.__store, { type: 'dispatch_state_changed', payload: { dispatchId: 'disp_cb', taskId: 'task_cb', state: 'active' } });
  }
  return sup;
}

function journalCount(stateDir, substring) {
  const journalPath = join(
    resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } }).stateRoot,
    'coordinations', COORD, 'events.jsonl',
  );
  return readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes(substring))
    .length;
}

const SELF_IDENTITY_DEPS = createPlatformIdentityDeps();

async function registerLiveBinding(sup, capabilityToken, { dispatchId = 'disp_cb' } = {}) {
  const startIdentity = await SELF_IDENTITY_DEPS.getStartIdentity(process.pid);
  await sup.__recordRuntimeBinding(dispatchId === 'disp_cb' ? 'disp_cb' : dispatchId, {
    bindingId: 'worker_cb',
    adapterId: 'owned-process',
    taskId: 'task_cb',
    callbackCapability: capabilityToken,
    processIdentity: { pid: process.pid, startIdentity, processGroupId: process.pid },
  });
}

test('same nonterminal callback twice produces exactly one journal event and one acknowledgement', async (t) => {
  const stateDir = prepareCoordination(t, 'dup');
  const sup = await startedSupervisor(stateDir);
  try {
    await registerLiveBinding(sup, 'cap-dup-1');
    const first = await sup.processWorkerCallback(makeCallback('worker.progress', 1));
    assert.equal(first.ok, true, JSON.stringify(first.error ?? {}));
    const progressBefore = journalCount(stateDir, '"type":"progress"');
    const second = await sup.processWorkerCallback(makeCallback('worker.progress', 1));
    assert.equal(second.ok, true);
    const progressAfter = journalCount(stateDir, '"type":"progress"');
    assert.equal(progressAfter, progressBefore, 'a duplicate callback must not append a second journal event');
    assert.equal(second.acknowledgedSequence ?? second.result?.acknowledgedSequence, first.acknowledgedSequence ?? first.result?.acknowledgedSequence,
      'the duplicate must return the prior committed acknowledgement');
    assert.equal(journalCount(stateDir, '"type":"dispatch_reconciled"'), 0);
  } finally {
    await sup.stop();
  }
});

test('lost acknowledgement followed by retry appends once and replays the same ack', async (t) => {
  const stateDir = prepareCoordination(t, 'lostack');
  const sup = await startedSupervisor(stateDir);
  try {
    await registerLiveBinding(sup, 'cap-lost');
    const observed = [];
    // First attempt: response is lost before the worker sees it.
    sup.processWorkerCallback(makeCallback('worker.progress', 1)).then((r) => observed.push(r));
    await new Promise((resolveTick) => setImmediate(resolveTick));
    const retry = await sup.processWorkerCallback(makeCallback('worker.progress', 1));
    assert.equal(retry.ok, true);
    assert.equal(observed.length > 0, true);
    const ackFromLost = observed[0].acknowledgedSequence ?? observed[0].result?.acknowledgedSequence;
    const ackFromRetry = retry.acknowledgedSequence ?? retry.result?.acknowledgedSequence;
    assert.equal(ackFromRetry, ackFromLost, 'retry must observe the originally committed sequence');
    assert.equal(journalCount(stateDir, '"type":"progress"'), 1);
  } finally {
    await sup.stop();
  }
});

test('duplicate callback after a supervisor restart remains a durable no-op', async (t) => {
  const stateDir = prepareCoordination(t, 'restartdup');
  const supA = await startedSupervisor(stateDir);
  await registerLiveBinding(supA, 'cap-rd');
  const original = await supA.processWorkerCallback(makeCallback('worker.progress', 1));
  assert.equal(original.ok, true);
  const originalSeq = original.acknowledgedSequence ?? original.result?.acknowledgedSequence;
  await supA.stop();

  const supB = await startedSupervisor(stateDir, 'recover');
  try {
    // Re-registration mirrors an operator re-proving the live binding.
    await registerLiveBinding(supB, 'cap-rd');
    const progressBefore = journalCount(stateDir, '"type":"progress"');
    const replay = await supB.processWorkerCallback(makeCallback('worker.progress', 1));
    assert.equal(replay.ok, true, JSON.stringify(replay.error ?? {}));
    const replaySeq = replay.acknowledgedSequence ?? replay.result?.acknowledgedSequence;
    assert.equal(replaySeq, originalSeq, 'post-restart duplicate must return the pre-restart acknowledgement');
    const progressAfter = journalCount(stateDir, '"type":"progress"');
    assert.equal(progressAfter, progressBefore, 'post-restart duplicate must not append');
    void progressAfter;
  } finally {
    await supB.stop();
  }
});

test('out-of-order callback is typed and cannot regress snapshot state', async (t) => {
  const stateDir = prepareCoordination(t, 'ooo');
  const sup = await startedSupervisor(stateDir);
  try {
    await registerLiveBinding(sup, 'cap-ooo');
    const first = await sup.processWorkerCallback(makeCallback('worker.progress', 1));
    assert.equal(first.ok, true);
    const lastSequenceBefore = sup.__store.state.lastSequence;
    const future = await sup.processWorkerCallback(makeCallback('worker.progress', 3));
    assert.equal(future.ok, false);
    assert.equal(future.error?.code, 'ORCHESTRATION_EVENT_GAP');
    assert.equal(sup.__store.state.lastSequence, lastSequenceBefore, 'a rejected out-of-order callback must not mutate state');
  } finally {
    await sup.stop();
  }
});

test('conflicting payload with a reused event identity fails closed', async (t) => {
  const stateDir = prepareCoordination(t, 'conflict');
  const sup = await startedSupervisor(stateDir);
  try {
    await registerLiveBinding(sup, 'cap-conflict');
    const first = await sup.processWorkerCallback(makeCallback('worker.progress', 1));
    assert.equal(first.ok, true);
    const lastSequenceBefore = sup.__store.state.lastSequence;
    const hostile = makeCallback('worker.progress', 1, { input: { summary: 'tampered-content' } });
    const replay = await sup.processWorkerCallback(hostile);
    assert.equal(replay.ok, false);
    assert.equal(replay.error?.code, 'WORKER_CALLBACK_UNAUTHORIZED');
    assert.equal(sup.__store.state.lastSequence, lastSequenceBefore);
    assert.equal(journalCount(stateDir, 'tampered-content'), 0);
  } finally {
    await sup.stop();
  }
});

test('terminal callback replay is exactly-once across restart; conflicts escalate without overwrite', async (t) => {
  const stateDir = prepareCoordination(t, 'terminal');
  const supA = await startedSupervisor(stateDir);
  await registerLiveBinding(supA, 'cap-term');
  const done = makeCallback('worker.terminal', 1, { input: { outcome: 'done', summary: 'finished work' } });
  const firstTerminal = await supA.processWorkerCallback(done);
  assert.equal(firstTerminal.ok, true, JSON.stringify(firstTerminal.error ?? {}));
  assert.equal(journalCount(stateDir, '"type":"worker_done"'), 1);
  await supA.stop();

  const supB = await startedSupervisor(stateDir, 'recover');
  try {
    await registerLiveBinding(supB, 'cap-term');
    const replay = await supB.processWorkerCallback(done);
    assert.equal(replay.ok, true, JSON.stringify(replay.error ?? {}));
    assert.equal(journalCount(stateDir, '"type":"worker_done"'), 1, 'terminal replay across restart must stay exactly-once');

    const conflicting = makeCallback('worker.terminal', 2, { callbackId: 'cbk_terminal_conflict', input: { outcome: 'failed', summary: 'contradiction' } });
    const escalated = await supB.processWorkerCallback(conflicting);
    assert.equal(escalated.ok, true);
    // The conflicting PROPOSAL is journaled as evidence, but it must never
    // mutate settled state: the reducer escalates and keeps the first outcome.
    assert.equal(supB.__store.state.dispatches.disp_cb.terminalOutcome, 'completed');
    assert.equal(journalCount(stateDir, '"type":"worker_failed"'), 0, 'a conflicting terminal proposal must never append its outcome');
    assert.equal(journalCount(stateDir, 'conflicting terminal outcome'), 1);
  } finally {
    await supB.stop();
  }
});

test('concurrent identical callbacks commit exactly one event', async (t) => {
  const stateDir = prepareCoordination(t, 'concurrent');
  const sup = await startedSupervisor(stateDir);
  try {
    await registerLiveBinding(sup, 'cap-conc');
    const results = await Promise.all([
      sup.processWorkerCallback(makeCallback('worker.progress', 1)),
      sup.processWorkerCallback(makeCallback('worker.progress', 1)),
      sup.processWorkerCallback(makeCallback('worker.progress', 1)),
    ]);
    for (const result of results) assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    assert.equal(journalCount(stateDir, '"type":"progress"'), 1, 'three racing duplicates must commit one event');
  } finally {
    await sup.stop();
  }
});

test('callbacks for an unknown or terminally incompatible dispatch are typed rejections', async (t) => {
  const stateDir = prepareCoordination(t, 'unknown');
  const sup = await startedSupervisor(stateDir);
  try {
    await registerLiveBinding(sup, 'cap-unk');

    // A callback claiming a foreign dispatch id fails identity authorization.
    const stranger = makeCallback('worker.progress', 1, { callbackId: 'cbk_stranger', dispatchId: 'disp_ghost' });
    const rejected = await sup.processWorkerCallback(stranger);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, 'WORKER_CALLBACK_UNAUTHORIZED');

    // A live binding whose dispatch has reached a terminal state can no
    // longer carry nonterminal activity callbacks.
    commitDelivery(sup.__store, { type: 'dispatch_state_changed', payload: { dispatchId: 'disp_cb', taskId: 'task_cb', state: 'cancelled' } });
    const latecomer = makeCallback('worker.progress', 1, { callbackId: 'cbk_late' });
    const refused = await sup.processWorkerCallback(latecomer);
    assert.equal(refused.ok, false);
    assert.equal(refused.error?.code, 'DISPATCH_NOT_FOUND');
  } finally {
    await sup.stop();
  }
});

test('compacted dedupe history turns ancient replays into typed stale rejections', async (t) => {
  const stateDir = prepareCoordination(t, 'compact');
  const sup = await startedSupervisor(stateDir);
  try {
    await registerLiveBinding(sup, 'cap-compact');
    for (let seq = 1; seq <= 130; seq += 1) {
      const result = await sup.processWorkerCallback(makeCallback('worker.heartbeat', seq));
      assert.equal(result.ok, true, `heartbeat ${seq}: ${JSON.stringify(result.error ?? {})}`);
    }
    const lastSequenceBefore = sup.__store.state.lastSequence;
    // seq 1 fell out of the retained window long ago; its content can no
    // longer be compared, so the only safe classification is stale.
    const ancient = await sup.processWorkerCallback(makeCallback('worker.heartbeat', 1));
    assert.equal(ancient.ok, false);
    assert.equal(ancient.error?.code, 'ORCHESTRATION_EVENT_GAP');
    assert.equal(sup.__store.state.lastSequence, lastSequenceBefore);
    const record = sup.__store.state.workerCallbacks.worker_cb;
    assert.equal(record.recent.length <= 128, true, 'dedupe window stays bounded');
  } finally {
    await sup.stop();
  }
});

test('question and escalation duplicates return prior acks without appending', async (t) => {
  const stateDir = prepareCoordination(t, 'qesc');
  const sup = await startedSupervisor(stateDir);
  try {
    await registerLiveBinding(sup, 'cap-qesc');
    const q1 = await sup.processWorkerCallback(makeCallback('worker.question', 1));
    assert.equal(q1.ok, true);
    const e1 = await sup.processWorkerCallback(makeCallback('worker.escalation', 2));
    assert.equal(e1.ok, true);
    const before = sup.__store.state.lastSequence;
    const qDup = await sup.processWorkerCallback(makeCallback('worker.question', 1));
    assert.equal(qDup.ok, true);
    assert.equal(qDup.duplicate, true);
    assert.equal(qDup.acknowledgedSequence, q1.acknowledgedSequence);
    const eDup = await sup.processWorkerCallback(makeCallback('worker.escalation', 2));
    assert.equal(eDup.ok, true);
    assert.equal(eDup.duplicate, true);
    assert.equal(eDup.acknowledgedSequence, e1.acknowledgedSequence);
    assert.equal(sup.__store.state.lastSequence, before, 'duplicates must not append any event');
  } finally {
    await sup.stop();
  }
});
