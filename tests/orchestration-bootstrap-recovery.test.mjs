import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { MANIFEST_SCHEMA, ORCHESTRATION_PROTOCOL } from '../src/orchestration/constants.mjs';
import { deriveEndpoint, requestIpc } from '../src/orchestration/ipc.mjs';
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

const ENTRY_PATH = new URL('../src/orchestration/supervisor-entry.mjs', import.meta.url).pathname;

// ---- harness-wide leak containment -----------------------------------------
// Every supervisor/child this file creates registers a closer here. A single
// top-level sweep plus a non-unref'd failsafe guarantee this suite can never
// pin the runner open, no matter how the production code misbehaves.
const CLOSERS = [];
function registerCloser(closer) { CLOSERS.push(closer); }
after(async () => {
  for (const closer of CLOSERS.splice(0)) {
    try { await closer(); } catch { /* best effort */ }
  }
});
// Unref'd failsafe: never pins a healthy run, still fires if any leak keeps
// the event loop alive past the suite's wall-clock budget.
setTimeout(() => {
  console.error('FAILSAFE: bootstrap-recovery suite exceeded its wall-clock budget; forcing exit');
  try {
    console.error('active resources:', JSON.stringify(process.getActiveResourcesInfo()));
    for (const handle of new Set(process._getActiveHandles())) {
      const name = handle?.constructor?.name;
      let detail = '';
      if (name === 'Timeout') detail = `idle=${handle._idleTimeout}`;
      else if (name === 'Socket') {
        detail = `readable=${handle.readable} writable=${handle.writable} destroyed=${handle.destroyed} fd=${handle._handle?.fd}`;
      } else if (name === 'ChildProcess') {
        detail = `pid=${handle.pid} exit=${handle.exitCode} file=${handle.spawnfile}`;
      } else if (name === 'Server') detail = `listening=${handle.listening}`;
      console.error(`  handle ${name}: ${detail}`);
    }
  } catch { /* diagnostics only */ }
  process.exit(42);
}, 150_000).unref();

function tempStateDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r1-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function entryEnv(stateDir) {
  return { ...process.env, WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir };
}

/**
 * Spawn one real supervisor entry subprocess. The bootstrap payload is written
 * and stdin ended BEFORE the ready line is awaited, mirroring the required
 * parent-first bootstrap order.
 */
function startEntry(t, { stateDir, mode = 'create', coordinationId = null, payload = null, rawStdin = null, hardExitMs = 12_000 }) {
  const args = [ENTRY_PATH, '--mode', mode];
  if (coordinationId) args.push('--coordination-id', coordinationId);
  const child = spawn(process.execPath, args, {
    env: entryEnv(stateDir),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stdoutText = '';
  let stderrText = '';
  let settledExit = false;
  const exited = new Promise((resolveExit) => {
    child.stdout.on('data', (chunk) => { stdoutText += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderrText += chunk.toString('utf8'); });
    child.once('exit', (code, signal) => {
      if (settledExit) return;
      settledExit = true;
      resolveExit({ code, signal });
    });
    setTimeout(() => {
      // A supervisor is a long-running owner; the harness bounds each entry
      // lifecycle so a bootstrap deadlock fails the test instead of hanging.
      if (!settledExit && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }
      if (!settledExit) {
        settledExit = true;
        resolveExit({ code: 'TIMEOUT' });
      }
    }, hardExitMs).unref?.();
  });
  if (rawStdin !== null) child.stdin.write(rawStdin);
  else if (payload !== null) child.stdin.write(`${JSON.stringify(payload)}\n`);
  child.stdin.end();
  const killChild = () => {
    try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* gone */ }
  };
  t.after(killChild);
  registerCloser(async () => {
    killChild();
  });
  return {
    child,
    lines: () => stdoutText.split('\n').map((line) => line.trim()).filter(Boolean),
    stderr: () => stderrText,
    exited,
  };
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

function withDeadline(promise, deadlineMs, label) {
  return Promise.race([
    promise,
    new Promise((_, rejectDeadline) => {
      setTimeout(() => rejectDeadline(new Error(`deadline exceeded: ${label}`)), deadlineMs).unref?.();
    }),
  ]);
}

async function deadPid() {
  const done = spawnSync(process.execPath, ['-e', '']);
  const pid = done.pid;
  await waitFor(() => {
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  }, 2000, `pid ${pid} to die`);
  return pid;
}

function layoutForDir(stateDir, coordinationId) {
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  return {
    roots,
    coordinationDir: join(roots.stateRoot, 'coordinations', coordinationId),
    ipcDir: join(roots.stateRoot, 'ipc'),
    endpoint: deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId }),
    lockPath: join(roots.stateRoot, 'coordinations', coordinationId, 'supervisor.lock'),
    journalPath: join(roots.stateRoot, 'coordinations', coordinationId, 'events.jsonl'),
  };
}

function seedCrashFixture(t, name, coordinationId) {
  const stateDir = tempStateDir(t, name);
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
  commitDelivery(store, { type: 'task_created', payload: { taskId: 'task_c1' } });
  commitDelivery(store, { type: 'dispatch_created', payload: { dispatchId: 'disp_c1', taskId: 'task_c1' } });
  commitDelivery(store, { type: 'dispatch_state_changed', payload: { dispatchId: 'disp_c1', taskId: 'task_c1', state: 'active' } });
  return { stateDir, layout, sequencesBefore: store.state.lastSequence };
}

function fabricateCrashedOwner(lockPath, pid, generation = 1) {
  writeAtomicJson(lockPath, {
    schema: 'webmcp.ai-supervisor-lock/v0',
    identity: {
      pid,
      startIdentity: `${process.platform}:fabricated-crash`,
      processGroupId: pid,
      processGeneration: generation,
      runtimeNonce: 'nonce_fabricated',
    },
    acquiredAt: new Date().toISOString(),
  });
}

test('real owner bootstrap reaches ready, serves one request, and records the owner descriptor without ReferenceError', async (t) => {
  const stateDir = tempStateDir(t, 'bootstrap');
  const ownerDescriptor = { host: 'r1-host', instanceId: 'inst-r1' };
  const run = startEntry(t, {
    stateDir,
    coordinationId: 'coord_boot1',
    payload: { owner: ownerDescriptor },
  });

  // The ready acknowledgement must arrive promptly; a bootstrap deadlock
  // fails here instead of hanging the suite.
  const firstLine = await new Promise((resolveLine, rejectLine) => {
    const timer = setTimeout(() => rejectLine(new Error('bootstrap must never deadlock when an owner descriptor is supplied')), 10_000);
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      const newlineIndex = text.indexOf('\n');
      if (newlineIndex === -1) return;
      clearTimeout(timer);
      run.child.stdout.off('data', onData);
      resolveLine(text.slice(0, newlineIndex).trim());
    };
    run.child.stdout.on('data', onData);
  });
  assert.equal(run.stderr().includes('ReferenceError'), false, 'bootstrap must not leak a ReferenceError');
  const ready = JSON.parse(firstLine);
  assert.equal(ready.ok, true);
  assert.equal(ready.protocol, ORCHESTRATION_PROTOCOL);

  const { coordinationDir, endpoint } = layoutForDir(stateDir, 'coord_boot1');
  const manifest = JSON.parse(readFileSync(join(coordinationDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.owner, ownerDescriptor, 'the owner descriptor must survive bootstrap');

  const capability = readClientCapability({ coordinationDir });
  const response = await requestIpc(endpoint, {
    protocol: ORCHESTRATION_PROTOCOL,
    requestId: 'req_r1_serve',
    coordinationId: 'coord_boot1',
    fenceEpoch: ready.fenceEpoch,
    capability,
    operation: 'coordination.inspect',
    input: {},
  }, { timeoutMs: 5000 });
  assert.equal(response.ok, true, 'a bootstrapped owner must serve authenticated requests');

  // Graceful stop releases ownership deterministically.
  run.child.kill('SIGTERM');
  const exit = await Promise.race([
    run.exited,
    new Promise((resolveTick) => setTimeout(() => resolveTick({ code: 'TIMEOUT' }), 8_000)),
  ]);
  assert.equal(exit.code, 0, `graceful shutdown must exit cleanly (got ${JSON.stringify(exit)})`);
  await waitFor(() => !existsSync(layoutForDir(stateDir, 'coord_boot1').lockPath), 5000, 'owner lock release after SIGTERM');
});

test('two simultaneous starters yield exactly one owner', async (t) => {
  const stateDir = tempStateDir(t, 'race');
  const payload = { owner: { host: 'race-host', instanceId: 'inst-race' } };
  const a = startEntry(t, { stateDir, coordinationId: 'coord_race1', payload });
  const b = startEntry(t, { stateDir, coordinationId: 'coord_race1', payload });

  // Classify as soon as each entry prints its single status line.
  const classify = (run) => new Promise((resolveOutcome) => {
    const timer = setTimeout(() => resolveOutcome({ kind: 'silent' }), 10_000);
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      const newlineIndex = text.indexOf('\n');
      if (newlineIndex === -1) return;
      clearTimeout(timer);
      run.child.stdout.off('data', onData);
      let envelope = null;
      try { envelope = JSON.parse(text.slice(0, newlineIndex).trim()); } catch { /* unparseable */ }
      resolveOutcome({ kind: envelope?.ok === true ? 'winner' : 'loser', envelope });
    };
    run.child.stdout.on('data', onData);
  });
  const [outcomeA, outcomeB] = await Promise.all([classify(a), classify(b)]);
  const winners = [outcomeA, outcomeB].filter((outcome) => outcome.kind === 'winner');
  const losers = [outcomeA, outcomeB].filter((outcome) => outcome.kind === 'loser');
  assert.equal(winners.length, 1, `exactly one starter may win, got ${JSON.stringify([outcomeA, outcomeB])}`);
  assert.equal(losers.length, 1, 'the losing starter must fail closed with a typed envelope');
  assert.equal(losers[0].envelope?.error?.code, 'COORDINATION_LOCKED',
    `the loser must surface COORDINATION_LOCKED, got ${JSON.stringify(losers[0].envelope)}`);

  // The surviving owner releases the singleton lock deterministically on
  // SIGTERM; no orphan lock or socket may outlive it.
  const winnerRun = outcomeA.kind === 'winner' ? a : b;
  winnerRun.child.kill('SIGTERM');
  const winnerExit = await Promise.race([
    winnerRun.exited,
    new Promise((resolveTick) => setTimeout(() => resolveTick({ code: 'TIMEOUT' }), 8_000)),
  ]);
  assert.equal(winnerExit.code, 0, `graceful owner shutdown must exit cleanly (got ${JSON.stringify(winnerExit)})`);
  const { lockPath } = layoutForDir(stateDir, 'coord_race1');
  await waitFor(() => !existsSync(lockPath), 5_000, 'winner lock release');
});

test('generation sequence is strictly increasing across graceful stops and restarts', async (t) => {
  const stateDir = tempStateDir(t, 'generations');
  const clientMod = await import('../src/orchestration/client.mjs');

  // Harness-side bounded bootstrap so a client-side deadlock fails the test
  // instead of orphaning a supervisor that pins this suite open.
  const tracked = new Set();
  const harnessSpawn = (entryArgs, childEnv) => new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(process.execPath, [ENTRY_PATH, ...entryArgs], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    tracked.add(child);
    let buffered = '';
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      try { child.stdout.destroy(); child.stderr.destroy(); } catch { /* gone */ }
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      settle(rejectSpawn, new Error('harness bootstrap deadline exceeded'));
    }, 10_000);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      const newlineIndex = buffered.indexOf('\n');
      if (newlineIndex === -1 || settled) return;
      clearTimeout(timer);
      let ready = null;
      try { ready = JSON.parse(buffered.slice(0, newlineIndex).trim()); } catch { /* unparseable */ }
      if (ready?.ok === true) settle(resolveSpawn, { child, ready });
      else {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        settle(rejectSpawn, new Error(`bootstrap failed: ${buffered.slice(0, newlineIndex)}`));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      settle(rejectSpawn, new Error(`supervisor exited during bootstrap (code ${code})`));
    });
    child.stdin.end();
  });
  const killAllTracked = async () => {
    for (const child of [...tracked]) {
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* gone */ }
    }
  };
  t.after(killAllTracked);
  registerCloser(killAllTracked);

  const makeClient = () => clientMod.createOrchestrationClient({
    env: { ...process.env, WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    spawnImpl: harnessSpawn,
  });

  const clientA = makeClient();
  t.after(() => clientA.dispose());
  const created = await withDeadline(clientA.create({
    protocol: ORCHESTRATION_PROTOCOL,
    requestId: 'req_gen_create',
  }), 20_000, 'client create');
  const generation1 = created.processGeneration;

  await withDeadline(clientA.dispose(), 10_000, 'dispose A');

  const clientB = makeClient();
  t.after(() => clientB.dispose());
  const second = await withDeadline(clientB.call(created.coordinationId, {
    protocol: ORCHESTRATION_PROTOCOL,
    requestId: 'req_gen_2',
    operation: 'coordination.inspect',
    input: {},
  }), 25_000, 'recover call 2');
  const generation2 = second.result.processGeneration;
  assert.ok(generation2 > generation1, `generation must increase after graceful stop (${generation1} -> ${generation2})`);

  await withDeadline(clientB.dispose(), 10_000, 'dispose B');
  const clientC = makeClient();
  t.after(() => clientC.dispose());
  const third = await withDeadline(clientC.call(created.coordinationId, {
    protocol: ORCHESTRATION_PROTOCOL,
    requestId: 'req_gen_3',
    operation: 'coordination.inspect',
    input: {},
  }), 25_000, 'recover call 3');
  const generation3 = third.result.processGeneration;
  assert.ok(generation3 > generation2, `generation must keep increasing (${generation2} -> ${generation3}; observed 1,2,2 bug)`);
});

test('crash after durable dispatch creation but before any callback reconciles deterministically to a typed lost state', async (t) => {
  const coordinationId = 'coord_crash1';
  const { stateDir, layout, sequencesBefore } = seedCrashFixture(t, 'crash', coordinationId);
  const crashedPid = await deadPid();
  fabricateCrashedOwner(layout.lockPath, crashedPid);

  const { endpoint, ipcDir } = layoutForDir(stateDir, coordinationId);
  mkdirSync(ipcDir, { recursive: true });
  writeFileSync(endpoint, ''); // stale socket inode left by a crash

  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'recover',
    coordinationId,
  });
  try {
    const state = sup.__store.state;
    assert.equal(state.dispatches.disp_c1.state, 'lost', 'an unrecoverable active dispatch must reconcile to the typed lost state');
    assert.equal(state.lastSequence, sequencesBefore + 1, 'exactly one reconciliation delivery may be appended');
    assert.equal(state.dispatches.disp_c1.terminalOutcome, null, 'reconciliation must never fabricate a completed outcome');
    const journalLines = readFileSync(layout.journalPath, 'utf8').trim().split('\n');
    const lastRecord = JSON.parse(journalLines[journalLines.length - 1]);
    assert.equal(lastRecord.type, 'dispatch_reconciled');
    assert.equal(lastRecord.payload.outcome, 'lost');
    assert.equal(lastRecord.payload.reason.length > 0, true);
  } finally {
    await sup.stop();
    registerCloser(async () => { try { await sup.stop(); } catch { /* stopped */ } });
  }
  assert.equal(existsSync(endpoint), false, 'stopped recovery must not leave a stale socket');
  assert.equal(existsSync(layout.lockPath), false, 'stopped recovery must release the singleton lock');
});

test('restart restores an active owned process and retains group-signalling control capability', async (t) => {
  const stateDir = tempStateDir(t, 'reattach');
  const coordinationId = 'coord_attach1';

  const longChild = spawn(process.execPath, ['-e', 'setInterval(()=>{},250);'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  longChild.unref();
  const forceKillWorker = () => {
    try { process.kill(-longChild.pid, 'SIGKILL'); } catch { /* gone */ }
    try { longChild.kill('SIGKILL'); } catch { /* gone */ }
  };
  t.after(forceKillWorker);
  registerCloser(async () => { forceKillWorker(); });

  const identityDeps = createPlatformIdentityDeps();
  await waitFor(() => {
    try { process.kill(longChild.pid, 0); return true; } catch { return false; }
  }, 3000, 'worker to spawn');
  const startIdentity = await identityDeps.getStartIdentity(longChild.pid);
  const processGroupId = await identityDeps.getProcessGroupId(longChild.pid);
  assert.equal(typeof startIdentity, 'string', 'worker start identity must be provable on this platform');

  const env = { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir };
  const sup1 = await createSupervisor({ env, mode: 'create', coordinationId });
  commitDelivery(sup1.__store, { type: 'task_created', payload: { taskId: 'task_a1' } });
  commitDelivery(sup1.__store, { type: 'dispatch_created', payload: { dispatchId: 'disp_a1', taskId: 'task_a1' } });
  commitDelivery(sup1.__store, { type: 'dispatch_state_changed', payload: { dispatchId: 'disp_a1', taskId: 'task_a1', state: 'active' } });
  await sup1.__recordRuntimeBinding('disp_a1', {
    bindingId: 'worker_a1',
    adapterId: 'owned-process',
    capability: 'owned-process',
    taskId: 'task_a1',
    processIdentity: { pid: longChild.pid, startIdentity, processGroupId },
    maturityRef: null,
    recordedAt: new Date().toISOString(),
  });
  await sup1.stop(); // clean stop: bindings sidecar persists, lock released
  registerCloser(async () => { try { await sup1.stop(); } catch { /* stopped */ } });

  const sup2 = await createSupervisor({ env, mode: 'recover', coordinationId });
  try {
    const state = sup2.__store.state;
    assert.equal(state.dispatches.disp_a1.state, 'active', 'a live owned worker must reattach instead of being marked lost');
    const journalLines = readFileSync(layoutForDir(stateDir, coordinationId).journalPath, 'utf8').trim().split('\n');
    const lastRecord = JSON.parse(journalLines[journalLines.length - 1]);
    assert.equal(lastRecord.type, 'dispatch_reconciled');
    assert.equal(lastRecord.payload.outcome, 'reattached');

    const { endpoint } = layoutForDir(stateDir, coordinationId);
    const capability = readClientCapability({
      coordinationDir: join(stateRootOf(stateDir), 'coordinations', coordinationId),
    });
    const response = await requestIpc(endpoint, {
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: 'req_r1_interrupt',
      coordinationId,
      fenceEpoch: state.fenceEpoch,
      capability,
      operation: 'dispatch.interrupt',
      input: { dispatchId: 'disp_a1', reason: 'r1-control-proof' },
    }, { timeoutMs: 8000 });
    assert.equal(response.ok, true, `restored control capability must answer: ${JSON.stringify(response.error ?? null)}`);
    assert.equal(Array.isArray(response.result?.signalsAttempted) && response.result.signalsAttempted.length > 0, true);

    await waitFor(() => {
      try { process.kill(longChild.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
    }, 5000, 'restored control to stop the owned worker');
  } finally {
    await sup2.stop();
    registerCloser(async () => { try { await sup2.stop(); } catch { /* stopped */ } });
    forceKillWorker();
  }
});

function stateRootOf(stateDir) {
  return resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } }).stateRoot;
}

test('runtime binding registration and bootstrap parsing fail closed on invalid shapes', async (t) => {
  const { parseBootstrapInput } = await import('../src/orchestration/supervisor-entry.mjs');
  assert.deepEqual(parseBootstrapInput(''), { owner: null });
  assert.deepEqual(parseBootstrapInput('   \n'), { owner: null });
  assert.deepEqual(parseBootstrapInput('{"owner":null}'), { owner: null });
  assert.deepEqual(parseBootstrapInput('{"owner":{"host":"h","instanceId":"i"}}'), { owner: { host: 'h', instanceId: 'i' } });
  const typedRejects = [
    () => parseBootstrapInput('[1,2]'),
    () => parseBootstrapInput('{"owner":{"host":"h"},"evil":true}'),
    () => parseBootstrapInput('{"owner":{"unknown":1}}'),
    () => parseBootstrapInput('{"owner":{"host":7}}'),
    () => parseBootstrapInput('nope{'),
  ];
  for (const rejectCase of typedRejects) {
    assert.throws(rejectCase, (error) => error.code === 'ORCHESTRATION_INVALID_INPUT');
  }

  const stateDir = tempStateDir(t, 'bindval');
  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'create',
    coordinationId: 'coord_bindval',
  });
  try {
    commitDelivery(sup.__store, { type: 'task_created', payload: { taskId: 'task_bv' } });
    commitDelivery(sup.__store, { type: 'dispatch_created', payload: { dispatchId: 'disp_bv', taskId: 'task_bv' } });
    await assert.rejects(
      () => sup.__recordRuntimeBinding('disp_missing', {
        bindingId: 'worker_x', adapterId: 'owned-process', taskId: 'task_bv',
        processIdentity: { pid: 5, startIdentity: 'darwin:x', processGroupId: 5 },
      }),
      (error) => error.code === 'DISPATCH_NOT_FOUND',
    );
    await assert.rejects(
      () => sup.__recordRuntimeBinding('disp_bv', {
        bindingId: 'worker_x', adapterId: 'owned-process', taskId: 'task_other',
        processIdentity: { pid: 5, startIdentity: 'darwin:x', processGroupId: 5 },
      }),
      (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
    );
    await assert.rejects(
      () => sup.__recordRuntimeBinding('disp_bv', {
        bindingId: 'worker_x', adapterId: 'owned-process', taskId: 'task_bv',
        processIdentity: { pid: 0, startIdentity: 'darwin:x', processGroupId: 5 },
      }),
      (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
    );
    await assert.rejects(
      () => sup.__recordRuntimeBinding('disp_bv', {
        bindingId: 'worker_x', adapterId: 'owned-process', taskId: 'task_bv',
        processIdentity: { pid: 5, processGroupId: 5 },
      }),
      (error) => error.code === 'ORCHESTRATION_INDETERMINATE',
    );
  } finally {
    await sup.stop();
  }
});

test('dispatch.interrupt without a reproven runtime binding stays a typed unsupported boundary', async (t) => {
  const stateDir = tempStateDir(t, 'intneg');
  const { endpoint } = layoutForDir(stateDir, 'coord_intneg');
  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'create',
    coordinationId: 'coord_intneg',
  });
  try {
    const capability = readClientCapability({
      coordinationDir: join(stateRootOf(stateDir), 'coordinations', 'coord_intneg'),
    });
    const response = await requestIpc(endpoint, {
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: 'req_intneg',
      coordinationId: 'coord_intneg',
      fenceEpoch: sup.__store.state.fenceEpoch,
      capability,
      operation: 'dispatch.interrupt',
      input: { dispatchId: 'disp_none' },
    }, { timeoutMs: 5000 });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'UNSUPPORTED_CAPABILITY');
  } finally {
    await sup.stop();
  }
});

test('invalid or truncated bootstrap input fails closed with cleanup', async (t) => {
  const cases = [
    { label: 'truncated-json', rawStdin: '{"owner":{"host":"x"' },
    { label: 'unknown-field', rawStdin: '{"evil":true}\n' },
    { label: 'bad-owner-shape', rawStdin: '{"owner":{"host":42}}\n' },
  ];
  for (const testCase of cases) {
    const stateDir = tempStateDir(t, `invalid-${testCase.label}`);
    const run = startEntry(t, {
      stateDir,
      mode: 'create',
      coordinationId: `coord_bad_${testCase.label}`,
      rawStdin: testCase.rawStdin,
      hardExitMs: 5_000,
    });
    // Capture the very first status line the entry emits, then stop it.
    const firstLine = await new Promise((resolveLine, rejectLine) => {
      const timer = setTimeout(() => rejectLine(new Error(`${testCase.label}: no status line within deadline`)), 4_000);
      const onData = (chunk) => {
        const text = chunk.toString('utf8');
        const newlineIndex = text.indexOf('\n');
        if (newlineIndex === -1) return;
        clearTimeout(timer);
        run.child.stdout.off('data', onData);
        resolveLine(text.slice(0, newlineIndex).trim());
      };
      run.child.stdout.on('data', onData);
    });
    try { run.child.kill('SIGKILL'); } catch { /* gone */ }
    let envelope = null;
    try { envelope = JSON.parse(firstLine); } catch { envelope = null; }
    assert.equal(envelope?.ok, false, `${testCase.label}: must answer with a typed failure envelope, got ${firstLine}`);
    assert.equal(envelope?.error?.code, 'ORCHESTRATION_INVALID_INPUT', `${testCase.label}: typed invalid-input failure expected`);
    const coordinationsDir = join(stateDir, 'coordinations');
    const created = existsSync(coordinationsDir)
      ? readdirSync(coordinationsDir).filter((name) => name.startsWith('coord_'))
      : [];
    await waitFor(() => !existsSync(join(stateDir, 'coordinations', `coord_bad_${testCase.label}`)), 3000, `${testCase.label} cleanup`);
    assert.equal(created.length === 0 || !existsSync(join(coordinationsDir, `coord_bad_${testCase.label}`)), true,
      `${testCase.label}: failed bootstrap must not leave a coordination directory`);
  }
});
