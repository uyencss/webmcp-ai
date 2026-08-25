import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';

import { createAuthority, readClientCapability } from '../src/orchestration/authority.mjs';
import { ORCHESTRATION_PROTOCOL } from '../src/orchestration/constants.mjs';
import { deriveEndpoint, requestIpc } from '../src/orchestration/ipc.mjs';
import {
  createCoordinationLayout,
  ensureOrchestrationRoots,
  resolveOrchestrationRoots,
} from '../src/orchestration/paths.mjs';
import { createPlatformIdentityDeps } from '../src/orchestration/process-identity.mjs';
import { commitDelivery, openCoordinationStore } from '../src/orchestration/store.mjs';
import { MANIFEST_SCHEMA } from '../src/orchestration/constants.mjs';
import { writeAtomicJson } from '../src/orchestration/atomic-file.mjs';

const ENTRY_PATH = new URL('../src/orchestration/supervisor-entry.mjs', import.meta.url).pathname;
const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
const CALLBACK_CLIENT = join(ROOT, 'scripts', 'worker-callback-client.mjs');

// ---- harness-wide leak containment -----------------------------------------
const CLOSERS = [];
function registerCloser(closer) { CLOSERS.push(closer); }
after(async () => {
  for (const closer of CLOSERS.splice(0)) {
    try { await closer(); } catch { /* best effort */ }
  }
});
setTimeout(() => {
  console.error('FAILSAFE: cross-process recovery suite exceeded its wall-clock budget; forcing exit');
  process.exit(42);
}, 180_000).unref();

function tempStateDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r10b-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

/** Spawn one REAL supervisor entry subprocess and await its ready line. */
function startSupervisorProcess(t, { stateDir, mode, coordinationId, extraEnv = {} }) {
  const args = [ENTRY_PATH, '--mode', mode, '--coordination-id', coordinationId];
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir,
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stdoutText = '';
  let stderrText = '';
  child.stdout.on('data', (chunk) => { stdoutText += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderrText += chunk.toString('utf8'); });
  const ready = Promise.race([
    new Promise((resolveLine, rejectLine) => {
      const timer = setTimeout(() => rejectLine(new Error(
        `supervisor ${mode} never became ready; stdout=${stdoutText.slice(0, 400)} stderr=${stderrText.slice(0, 400)}`,
      )), 15_000);
      const onData = (chunk) => {
        const text = chunk.toString('utf8');
        const newlineIndex = text.indexOf('\n');
        if (newlineIndex === -1) return;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolveLine(JSON.parse(text.slice(0, newlineIndex).trim()));
      };
      child.stdout.on('data', onData);
    }),
  ]);
  child.stdin.write('{}\n');
  child.stdin.end();
  const hardKill = () => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    } catch { /* gone */ }
  };
  t.after(hardKill);
  registerCloser(hardKill);
  return { child, ready, stdout: () => stdoutText, stderr: () => stderrText };
}

function gracefulStop(t, run, timeoutMs = 8_000) {
  const exited = new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit({ code: 'TIMEOUT' }), timeoutMs);
    run.child.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit({ code });
    });
  });
  try { run.child.kill('SIGTERM'); } catch { /* gone */ }
  return exited;
}

function layoutForDir(stateDir, coordinationId) {
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const coordinationDir = join(roots.stateRoot, 'coordinations', coordinationId);
  return {
    roots,
    coordinationDir,
    endpoint: deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId }),
    journalPath: join(coordinationDir, 'events.jsonl'),
    bindingsPath: join(coordinationDir, 'runtime-bindings.json'),
    capabilityDir: join(coordinationDir, 'dispatch-capabilities'),
  };
}

async function ipcCall(layout, coordinationId, ready, operation, input) {
  return requestIpc(layout.endpoint, {
    protocol: ORCHESTRATION_PROTOCOL,
    requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
    coordinationId,
    fenceEpoch: ready.fenceEpoch,
    capability: readClientCapability({ coordinationDir: layout.coordinationDir }),
    operation,
    input,
  }, { timeoutMs: 20_000 });
}

function journalRecords(layout) {
  return readFileSync(layout.journalPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Mode-0600 machine-local trusted coordinator configuration naming the
 * coordinator-owned launch command for the fixture worker.
 */
function writeTrustedConfig(t, stateDir, ownedProcessArgs, ownedProcessEnv = {}) {
  const configPath = join(stateDir, 'trusted-coordinator.json');
  writeFileSync(configPath, `${JSON.stringify({
    schema: 'webmcp.ai-trusted-coordinator-config/v1',
    stateDir: join(stateDir, 'trusted'),
    confinement: 'disposable-workspace',
    disposableRoot: tmpdir(),
    ownedProcess: {
      command: process.execPath,
      args: ownedProcessArgs,
      env: ownedProcessEnv,
    },
  }, null, 1)}\n`, { mode: 0o600 });
  t.after(() => rmSync(configPath, { force: true }));
  return configPath;
}

/**
 * Diagnostic shim around the packaged callback client: keeps stdin intact,
 * tees stdout/stderr to files and records the exact worker exit. This makes
 * a worker's fate observable even after its parent owner is SIGKILLed.
 */
function writeWorkerShim(t, stateDir) {
  const shimPath = join(stateDir, 'worker-shim.mjs');
  writeFileSync(shimPath, `
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync } from 'node:fs';
const [target] = process.argv.slice(2);
const out = openSync(${JSON.stringify(join(stateDir, 'worker-out.log'))}, 'a');
const err = openSync(${JSON.stringify(join(stateDir, 'worker-err.log'))}, 'a');
const child = spawn(process.execPath, [target, ...process.argv.slice(3)], {
  stdio: ['inherit', out, err],
  env: process.env,
});
child.on('exit', (code, signal) => {
  try { appendFileSync(${JSON.stringify(join(stateDir, 'worker-exit.log'))}, \`exit=\${code} signal=\${signal} at=\\${''}\${Date.now()}\\n\`); } catch {}
  closeSync(out); closeSync(err);
  process.exit(code ?? 1);
});
`);
  return shimPath;
}

const SUPERVISOR_ADAPTER_ENV = (configPath) => ({
  WEBMCP_AI_ORCHESTRATION_PUBLIC_ADAPTERS: '1',
  WEBMCP_AI_ORCHESTRATION_TEST_FIXTURES: '1',
  WEBMCP_AI_ORCHESTRATION_TRUSTED_CONFIG: configPath,
});

test('R10B: a live provider-session binding after restart types LOST instead of a fake reattach, and its orphan process is stopped', async (t) => {
  const stateDir = tempStateDir(t, 'p1lost');
  const coordinationId = 'coord_r10b_provider';

  // A REAL running process stands in for an orphaned provider server child so
  // the durable binding record carries provable, live identity.
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},250);'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  sleeper.unref();
  const killSleeper = () => {
    try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { try { sleeper.kill('SIGKILL'); } catch { /* gone */ } }
  };
  t.after(killSleeper);
  registerCloser(killSleeper);
  await waitFor(() => pidAlive(sleeper.pid), 3000, 'sleeper to spawn');
  const identityDeps = createPlatformIdentityDeps();
  const startIdentity = await identityDeps.getStartIdentity(sleeper.pid);
  const processGroupId = await identityDeps.getProcessGroupId(sleeper.pid);
  assert.equal(typeof startIdentity, 'string', 'sleeper identity must be provable');

  // Seed a crashed coordination whose active dispatch holds a PROVIDER
  // (opencode-server) binding with fully proven process identity.
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  ensureOrchestrationRoots(roots);
  const layoutLayout = createCoordinationLayout(roots.stateRoot, coordinationId);
  writeAtomicJson(layoutLayout.manifestPath, {
    schema: MANIFEST_SCHEMA,
    coordinationId,
    fenceEpoch: 1,
    processGeneration: 1,
    createdAt: new Date().toISOString(),
    owner: null,
  });
  createAuthority(layoutLayout);
  const store = openCoordinationStore(layoutLayout);
  commitDelivery(store, { type: 'task_created', payload: { taskId: 'task_p1' } });
  commitDelivery(store, { type: 'dispatch_created', payload: { dispatchId: 'disp_p1', taskId: 'task_p1' } });
  commitDelivery(store, {
    type: 'dispatch_state_changed',
    payload: { dispatchId: 'disp_p1', taskId: 'task_p1', state: 'active' },
  });
  writeAtomicJson(join(roots.stateRoot, 'coordinations', coordinationId, 'runtime-bindings.json'), {
    schema: 'webmcp.ai-supervisor-runtime-bindings/v0',
    bindings: {
      disp_p1: {
        bindingId: 'worker_p1',
        adapterId: 'opencode-server',
        capability: 'opencode-server',
        taskId: 'task_p1',
        fenceEpoch: 1,
        callbackCapabilityDigest: 'sha256:seeded',
        processIdentity: { pid: sleeper.pid, startIdentity, processGroupId },
      },
    },
  });

  // The crashed owner leaves its lock behind; recovery must archive it.
  const deadOwner = spawnSync(process.execPath, ['-e', '']);
  await waitFor(() => !pidAlive(deadOwner.pid), 3000, 'fake owner pid to die');
  writeAtomicJson(layoutLayout.lockPath, {
    schema: 'webmcp.ai-supervisor-lock/v0',
    identity: {
      pid: deadOwner.pid,
      startIdentity: `${process.platform}:fabricated-r10b`,
      processGroupId: deadOwner.pid,
      processGeneration: 1,
      runtimeNonce: 'nonce_r10b_seed',
    },
    acquiredAt: new Date().toISOString(),
  });

  // Recovery happens in a SECOND, entirely separate OS process.
  const recovered = startSupervisorProcess(t, { stateDir, mode: 'recover', coordinationId });
  const ready = await recovered.ready;
  assert.equal(ready.ok, true);
  assert.equal(ready.processGeneration, 2);

  const layout = layoutForDir(stateDir, coordinationId);
  const inspected = await ipcCall(layout, coordinationId, ready, 'coordination.inspect', {});
  assert.equal(inspected.ok, true, JSON.stringify(inspected.error ?? {}));
  const dispatchState = inspected.result.dispatches?.disp_p1?.state;

  // THE INVARIANT: provider session/stream control cannot be restored by a
  // new owner, so the truthful reconciliation is typed LOST — never a fake
  // reattached that leaves the dispatch stuck active without control.
  assert.equal(dispatchState, 'lost',
    `provider binding must reconcile to lost after restart, got ${dispatchState}`);

  const reconciled = journalRecords(layout).filter((record) => record.type === 'dispatch_reconciled');
  const lastReconciled = reconciled.at(-1);
  assert.equal(lastReconciled?.payload?.outcome, 'lost');
  assert.match(String(lastReconciled?.payload?.reason), /unrestorable/,
    'the reconciliation reason must name WHY control is unrestorable');

  // No orphaned provider process may outlive the lost reconciliation: the
  // recovery stops it ONLY through the proven identity.
  await waitFor(() => !pidAlive(sleeper.pid), 8000, 'orphaned provider process to be stopped by recovery');
}, { timeout: 60_000 });

test('R10B: crash before terminal -> reattach -> worker reconnects -> terminal commits exactly once -> settled -> revoked', async (t) => {
  const stateDir = tempStateDir(t, 'reconn');
  const coordinationId = 'coord_r10b_reconn';
  const workspace = join(stateDir, 'ws');
  mkdirSync(workspace, { recursive: true });
  const triggerFile = join(stateDir, 'trigger.r10b');

  // The packaged callback client sends progress immediately, then waits for
  // the trigger file before sending its terminal: the supervisor dies FIRST.
  const shimPath = writeWorkerShim(t, stateDir);
  const configPath = writeTrustedConfig(t, stateDir, [shimPath, CALLBACK_CLIENT, 'demo', '--trigger', triggerFile, '--trigger-timeout-ms', '120000', '--summary', 'r10b reconnect done']);
  const supervisorEnv = SUPERVISOR_ADAPTER_ENV(configPath);

  const first = startSupervisorProcess(t, {
    stateDir, mode: 'create', coordinationId, extraEnv: supervisorEnv,
  });
  const readyA = await first.ready;
  assert.equal(readyA.ok, true, JSON.stringify(readyA));

  const layout = layoutForDir(stateDir, coordinationId);
  const callA = (operation, input) => ipcCall(layout, coordinationId, readyA, operation, input);

  const created = await callA('task.create', {
    packet: { objective: 'r10b crash-before-terminal canary', workspace, allowedReadRoots: [workspace], allowedWriteRoots: [] },
  });
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  const taskId = created.result.taskId;
  const started = await callA('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));
  const dispatchId = started.result.dispatchId;

  // Wait until the worker is live, bound and has delivered telemetry.
  await waitFor(() => journalRecords(layout).some((record) => record.type === 'progress'), 20_000, 'worker progress before the crash');
  const bindingRecord = JSON.parse(readFileSync(layout.bindingsPath, 'utf8')).bindings[dispatchId];
  const workerPid = bindingRecord?.processIdentity?.pid;
  assert.ok(Number.isInteger(workerPid), 'live owned worker must have a recorded pid');
  await waitFor(() => pidAlive(workerPid), 5000, 'worker process presence');

  // CRASH: the owner dies hard while the worker waits for its trigger.
  first.child.kill('SIGKILL');
  await waitFor(() => !pidAlive(first.child.pid), 5000, 'crashed supervisor to die');
  // The SIGKILLed owner cannot unlink its socket; recovery removes the stale
  // inode itself once it holds the singleton lock.

  const second = startSupervisorProcess(t, {
    stateDir, mode: 'recover', coordinationId, extraEnv: supervisorEnv,
  });
  const readyB = await second.ready;
  assert.equal(readyB.ok, true);
  assert.equal(readyB.processGeneration, 2, 'a recovered owner increments the durable generation');

  const inspected = await ipcCall(layout, coordinationId, readyB, 'coordination.inspect', {});
  assert.equal(inspected.result.dispatches?.[dispatchId]?.state, 'active', 'the live owned dispatch must reattach truthfully');
  const reconciled = journalRecords(layout).filter((record) => record.type === 'dispatch_reconciled'
    && record.payload?.dispatchId === dispatchId);
  assert.equal(reconciled.at(-1)?.payload?.outcome, 'reattached');
  assert.equal(reconciled.at(-1)?.payload?.reason, 'binding-identity-reproven-after-restart');

  // The worker reconnects on its own retry loop and delivers its terminal
  // EXACTLY once to the NEW supervisor.
  const deathTimeline = [];
  const deathWatcher = setInterval(() => {
    if (!pidAlive(workerPid)) deathTimeline.push(Date.now());
  }, 20);
  const workerFirstSeenDead = () => deathTimeline[0] ?? null;
  const phaseStart = Date.now();
  writeFileSync(triggerFile, 'go\n');
  let lastDiag = '';
  try {
    await waitFor(async () => {
      const now = await ipcCall(layout, coordinationId, readyB, 'coordination.inspect', {});
      const settledNow = now.result.dispatches?.[dispatchId]?.state === 'settled'
        && now.result.dispatches?.[dispatchId]?.terminalOutcome === 'completed';
      if (!settledNow) {
        const types = journalRecords(layout).map((record) => record.type);
        let workerExit = null;
        try { workerExit = readFileSync(join(stateDir, 'worker-exit.log'), 'utf8'); } catch { /* alive */ }
        let workerErr = '';
        try { workerErr = readFileSync(join(stateDir, 'worker-err.log'), 'utf8').slice(0, 400); } catch { /* none */ }
        lastDiag = JSON.stringify({
          dispatch: now.result.dispatches?.[dispatchId],
          tail: types.slice(-8),
          terminals: types.filter((entry) => entry === 'worker_done').length,
          workerAlive: pidAlive(workerPid),
          workerDiedAtMsOffset: workerFirstSeenDead() === null ? null : workerFirstSeenDead() - phaseStart,
          capFile: existsSync(join(layout.capabilityDir, `${dispatchId}.cap`)),
          workerExit,
          workerErr,
        });
      }
      return settledNow;
    }, 30_000, 'recovered dispatch to settle after the worker reconnects');
  } catch (error) {
    throw new Error(`${error.message}; diagnostics: ${lastDiag}`);
  } finally {
    clearInterval(deathWatcher);
  }

  const terminals = journalRecords(layout).filter((record) => record.type === 'worker_done');
  assert.equal(terminals.length, 1, 'exactly one terminal commit across the crash boundary');
  const cleanups = journalRecords(layout).filter((record) => record.type === 'cleanup_recorded');
  assert.equal(cleanups.length >= 1, true);
  assert.match(String(cleanups.at(-1)?.payload?.disposition), /recovered-post-terminal-cleanup/);

  const finalInspect = await ipcCall(layout, coordinationId, readyB, 'coordination.inspect', {});
  assert.equal(finalInspect.result.tasks?.[taskId]?.state, 'awaiting_acceptance');

  // Closure revokes BOTH the runtime binding and the capability file.
  await waitFor(() => !existsSync(join(layout.capabilityDir, `${dispatchId}.cap`)), 10_000, 'capability file revocation');
  const bindingsNow = JSON.parse(readFileSync(layout.bindingsPath, 'utf8')).bindings;
  assert.equal(bindingsNow[dispatchId], undefined, 'settled dispatch binding must be dropped from the durable sidecar');

  const stopped = await gracefulStop(t, second);
  assert.equal(stopped.code, 0, `recovered supervisor must exit cleanly, got ${JSON.stringify(stopped)}`);
}, { timeout: 90_000 });

test('R10B: crash after terminal before cleanup -> recovery completes settlement, stops the lingering worker and revokes', async (t) => {
  const stateDir = tempStateDir(t, 'settle');
  const coordinationId = 'coord_r10b_settle';
  const workspace = join(stateDir, 'ws');
  mkdirSync(workspace, { recursive: true });

  // This worker reports terminal, then LINGERS: the owner crashes inside the
  // settling window, before any cleanup/settle evidence exists.
  const lingerWorker = join(stateDir, 'linger-worker.mjs');
  writeFileSync(lingerWorker, `
const mod = await import(${JSON.stringify(CALLBACK_CLIENT)});
await mod.sendProgress({ summary: 'lingering progress' }, {});
await mod.sendTerminal({ outcome: 'done', summary: 'r10b finished before cleanup' }, {});
await new Promise((resolveLinger) => setTimeout(resolveLinger, 15000));
`);
  const configPath = writeTrustedConfig(t, stateDir, [lingerWorker], {});
  const supervisorEnv = SUPERVISOR_ADAPTER_ENV(configPath);

  const first = startSupervisorProcess(t, {
    stateDir, mode: 'create', coordinationId, extraEnv: supervisorEnv,
  });
  const readyA = await first.ready;
  const layout = layoutForDir(stateDir, coordinationId);
  const callA = (operation, input) => ipcCall(layout, coordinationId, readyA, operation, input);

  const created = await callA('task.create', {
    packet: { objective: 'r10b crash-after-terminal canary', workspace, allowedReadRoots: [workspace], allowedWriteRoots: [] },
  });
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  const taskId = created.result.taskId;
  const started = await callA('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));
  const dispatchId = started.result.dispatchId;

  // Kill the owner the moment the terminal is journaled but before the
  // finalizer could settle anything (the worker lingers for seconds).
  await waitFor(() => journalRecords(layout).some((record) => record.type === 'worker_done'), 30_000, 'worker terminal before the crash');
  const bindingRecord = JSON.parse(readFileSync(layout.bindingsPath, 'utf8')).bindings[dispatchId];
  const workerPid = bindingRecord?.processIdentity?.pid;
  assert.ok(Number.isInteger(workerPid));
  first.child.kill('SIGKILL');
  await waitFor(() => !pidAlive(first.child.pid), 5000, 'crashed supervisor to die');

  // The worker is STILL alive here (lingering): recovery must prove its
  // identity before stopping it, settle the dispatch durably, and revoke.
  const second = startSupervisorProcess(t, {
    stateDir, mode: 'recover', coordinationId, extraEnv: supervisorEnv,
  });
  const readyB = await second.ready;

  await waitFor(async () => {
    const now = await ipcCall(layout, coordinationId, readyB, 'coordination.inspect', {});
    return now.result.dispatches?.[dispatchId]?.state === 'settled'
      && now.result.dispatches?.[dispatchId]?.terminalOutcome === 'completed';
  }, 30_000, 'post-terminal crash window to complete settlement');

  assert.equal(journalRecords(layout).filter((record) => record.type === 'worker_done').length, 1,
    'settlement must not duplicate the terminal outcome');
  const cleanups = journalRecords(layout).filter((record) => record.type === 'cleanup_recorded');
  assert.match(String(cleanups.at(-1)?.payload?.disposition), /recovered-post-terminal-cleanup/);
  await waitFor(() => !pidAlive(workerPid), 12_000, 'lingering worker to be identity-stopped by recovery');
  await waitFor(() => !existsSync(join(layout.capabilityDir, `${dispatchId}.cap`)), 10_000, 'capability file revocation');

  // REPEATED RECOVERY: another fresh owner replays the SAME truth — settled
  // stays settled, nothing is refabricated, the singleton gate works.
  const stoppedSecond = await gracefulStop(t, second);
  assert.equal(stoppedSecond.code, 0);
  const reconciledBefore = journalRecords(layout).filter((record) => record.type === 'dispatch_reconciled').length;
  const third = startSupervisorProcess(t, {
    stateDir, mode: 'recover', coordinationId, extraEnv: supervisorEnv,
  });
  const readyC = await third.ready;
  assert.equal(readyC.processGeneration, 3);
  const again = await ipcCall(layout, coordinationId, readyC, 'coordination.inspect', {});
  assert.equal(again.result.dispatches?.[dispatchId]?.state, 'settled');
  assert.equal(again.result.tasks?.[taskId]?.state, 'awaiting_acceptance');
  const reconciledAfter = journalRecords(layout).filter((record) => record.type === 'dispatch_reconciled').length;
  assert.equal(reconciledAfter, reconciledBefore, 'repeat recovery must not append reconciliation events for settled dispatches');
  await gracefulStop(t, third);
}, { timeout: 120_000 });
