import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { readClientCapability, createAuthority } from '../src/orchestration/authority.mjs';
import { deriveEndpoint, requestIpc } from '../src/orchestration/ipc.mjs';
import {
  resolveOrchestrationRoots,
  ensureOrchestrationRoots,
} from '../src/orchestration/paths.mjs';
import { createPlatformIdentityDeps } from '../src/orchestration/process-identity.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { openCoordinationStore, commitDelivery } from '../src/orchestration/store.mjs';
import { writeAtomicJson } from '../src/orchestration/atomic-file.mjs';
import { MANIFEST_SCHEMA, ORCHESTRATION_PROTOCOL } from '../src/orchestration/constants.mjs';

const ENTRY_PATH = new URL('../src/orchestration/supervisor-entry.mjs', import.meta.url).pathname;

// Failsafe: never let any leaked handle pin the runner open.
setTimeout(() => {
  console.error('FAILSAFE: r11c suite exceeded its wall-clock budget; forcing exit');
  process.exit(43);
}, 150_000).unref();

// ---- shared harness ---------------------------------------------------------

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `r11c-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let coordCounter = 0;
const COORD = () => `coord_r11c_${(coordCounter += 1)}`;

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

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function spawnSleeper(t, script = 'setInterval(()=>{},1000)') {
  const child = spawn(process.execPath, ['-e', script], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  t.after(() => {
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  });
  await waitFor(() => pidAlive(child.pid), 3_000, 'sleeper to spawn');
  return child;
}

async function startSupervisorWithFactory(t, name, identityDepsFactory) {
  const stateDir = tempDir(t, name);
  const coordinationId = COORD();
  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'create',
    coordinationId,
    ...(identityDepsFactory ? { identityDepsFactory } : {}),
  });
  t.after(() => sup.stop());
  // Seed one active dispatch so a forged binding can attach to real state.
  commitDelivery(sup.__store, { type: 'task_created', payload: { taskId: 'task_c1' } });
  commitDelivery(sup.__store, { type: 'dispatch_created', payload: { dispatchId: 'disp_c1', taskId: 'task_c1' } });
  commitDelivery(sup.__store, {
    type: 'dispatch_state_changed',
    payload: { dispatchId: 'disp_c1', taskId: 'task_c1', state: 'active' },
  });
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
  return { sup, stateDir, coordinationId, call };
}

// ---- R11C-1: identity drift between ladder steps aborts signalling ----------

test('R11C-1: PID reuse detected between ladder steps stops the ladder and keeps control', async (t) => {
  // A worker that IGNORES SIGINT+SIGTERM: only SIGKILL can end it, so the
  // abort-vs-complete behavior of every ladder step is observable.
  const sleeper = await spawnSleeper(t,
    "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)");
  const deps = createPlatformIdentityDeps();
  const realStartIdentity = await deps.getStartIdentity(sleeper.pid);
  const probes = { count: 0, truthful: false };
  const factory = () => {
    const inner = createPlatformIdentityDeps();
    return {
      getStartIdentity: async (pid) => {
        if (probes.truthful || pid !== sleeper.pid) return inner.getStartIdentity(pid);
        probes.count += 1;
        if (probes.count <= 2) return inner.getStartIdentity(pid);
        // Deterministic recycle simulation: from the third probe OF THE
        // WORKER'S pid on, the holder's identity differs from the original.
        return `${process.platform}:recycled-holder`;
      },
      getProcessGroupId: (pid) => inner.getProcessGroupId(pid),
    };
  };

  const { sup, call, stateDir, coordinationId } = await startSupervisorWithFactory(t, 'drift', factory);
  await sup.__recordRuntimeBinding('disp_c1', {
    bindingId: 'worker_c1',
    adapterId: 'owned-process',
    capability: 'owned-process',
    taskId: 'task_c1',
    fenceEpoch: sup.__store.state.fenceEpoch,
    processIdentity: {
      pid: sleeper.pid,
      startIdentity: realStartIdentity,
      processGroupId: sleeper.pid,
    },
  });

  const interrupt = await call('dispatch.interrupt', { dispatchId: 'disp_c1', reason: 'r11c drift probe' });
  assert.equal(interrupt.ok, false, 'a drifted identity must refuse resolution');
  assert.equal(interrupt.error.code, 'WORKER_STOP_UNPROVEN');
  // Exactly ONE signal (the step whose pre-prove still matched) then abort:
  // SIGTERM/SIGKILL must NEVER reach the recycled holder.
  const latest = readJournal(stateDir, coordinationId)
    .filter((entry) => entry.type === 'cleanup_recorded' && entry.payload?.dispatchId === 'disp_c1')
    .at(-1)?.payload ?? {};
  assert.equal(latest.disposition, 'signalled-stop-unproven');
  assert.deepEqual(latest.signalsAttempted, ['GROUP_SIGINT'],
    `ladder must abort right after the drifted probe, got ${JSON.stringify(latest.signalsAttempted)}`);
  assert.equal(pidAlive(sleeper.pid), true, 'the original sleeper must survive the aborted ladder');

  // Retry with truthful identity proofs completes the stop exactly.
  probes.truthful = true;
  const retry = await call('dispatch.interrupt', { dispatchId: 'disp_c1', reason: 'r11c retry' });
  assert.equal(retry.ok, true, JSON.stringify(retry.error ?? {}));
  await waitFor(() => !pidAlive(sleeper.pid), 5_000, 'sleeper to die on proven retry');
});

function readJournal(stateDir, coordinationId) {
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const path = join(roots.stateRoot, 'coordinations', coordinationId, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// ---- R11C-2: crash after spawn leaves a durable, controllable launch intent -

test('R11C-2: crash between spawn and binding persistence leaves a durable launch intent recovery can act on', async (t) => {
  const stateDir = tempDir(t, 'crashspawn');
  const coordinationId = COORD();
  const workerScript = join(stateDir, 'linger.mjs');
  writeFileSync(workerScript, `
const { writeFileSync } = await import('node:fs');
writeFileSync(${JSON.stringify(join(stateDir, 'worker-pid.txt'))}, String(process.pid));
setInterval(() => {}, 1000);
`);
  const configPath = join(stateDir, 'trusted-coordinator.json');
  writeFileSync(configPath, `${JSON.stringify({
    schema: 'webmcp.ai-trusted-coordinator-config/v1',
    stateDir: join(stateDir, 'trusted'),
    confinement: 'disposable-workspace',
    disposableRoot: tmpdir(),
    ownedProcess: { command: process.execPath, args: [workerScript], env: {} },
  })}\n`, { mode: 0o600 });

  const supervisorEnv = {
    ...process.env,
    WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir,
    WEBMCP_AI_ORCHESTRATION_PUBLIC_ADAPTERS: '1',
    WEBMCP_AI_ORCHESTRATION_TEST_FIXTURES: '1',
    WEBMCP_AI_ORCHESTRATION_TRUSTED_CONFIG: configPath,
    WEBMCP_AI_TEST_CRASH_AFTER_SPAWN: '*',
  };

  const owner = spawn(process.execPath, [ENTRY_PATH, '--mode', 'create', '--coordination-id', coordinationId], {
    env: supervisorEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stdoutText = '';
  owner.stdout.on('data', (chunk) => { stdoutText += chunk.toString('utf8'); });
  owner.stderr.on('data', (chunk) => { stdoutText += chunk.toString('utf8'); });
  t.after(() => { try { owner.kill('SIGKILL'); } catch { /* gone */ } });
  // Bootstrap payload FIRST (the entry reads stdin synchronously before it
  // can emit its ready line), then await the ready acknowledgement.
  owner.stdin.write('{}\n');
  owner.stdin.end();
  const readyLine = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`owner never ready: ${stdoutText.slice(0, 300)}`)), 15_000);
    owner.stdout.once('data', (chunk) => {
      const text = chunk.toString('utf8');
      const idx = text.indexOf('\n');
      if (idx === -1) return;
      clearTimeout(timer);
      resolve(JSON.parse(text.slice(0, idx)));
    });
  });

  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const layout = {
    endpoint: deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId }),
    coordinationDir: join(roots.stateRoot, 'coordinations', coordinationId),
    journalPath: join(roots.stateRoot, 'coordinations', coordinationId, 'events.jsonl'),
  };
  const ipcCall = (operation, input) => requestIpc(layout.endpoint, {
    protocol: ORCHESTRATION_PROTOCOL,
    requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
    coordinationId,
    fenceEpoch: readyLine.fenceEpoch,
    capability: readClientCapability({ coordinationDir: layout.coordinationDir }),
    operation,
    input,
  }, { timeoutMs: 8_000 });

  const created = await ipcCall('task.create', {
    packet: {
      objective: 'r11c crash-window objective must never leak into durable intents',
      workspace: join(stateDir, 'ws'),
      allowedReadRoots: [join(stateDir, 'ws')],
      allowedWriteRoots: [],
    },
  });
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  try { await ipcCall('dispatch.start', { taskId: created.result.taskId, adapterId: 'owned-process' }); } catch { /* owner may die mid-call */ }

  // The owner SIGKILLs itself deterministically right after the spawn
  // handshake, BEFORE the old runtime-binding persist path.
  await waitFor(() => !pidAlive(owner.pid), 10_000, 'crashing owner to die');

  const intentsDir = join(layout.coordinationDir, 'launch-intents');
  assert.equal(existsSync(intentsDir), true, 'launch-intents directory must exist');
  const files = readdirSync(intentsDir).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1, 'exactly one durable launch intent');
  const intentPath = join(intentsDir, files[0]);
  assert.equal(statSync(intentPath).mode & 0o777, 0o600, 'launch intent must be machine-local 0600');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  assert.equal(intent.state, 'bound', 'the handshake must have persisted the bound identity');
  assert.ok(intent.processIdentity?.identityProven === true, 'spawn identity must be proven');
  assert.equal(intent.taskId, created.result.taskId);
  const rawIntent = readFileSync(intentPath, 'utf8');
  assert.equal(rawIntent.includes('crash-window objective'), false, 'no objective text may leak into the intent');
  const orphanPid = intent.processIdentity.pid;
  assert.equal(pidAlive(orphanPid), true, 'the orphan worker must be alive while the owner is dead');

  // Recovery acts on the intent: the orphan is stopped through proven
  // identity and the dispatch is typed truthfully.
  const recoverEnv = { ...supervisorEnv };
  delete recoverEnv.WEBMCP_AI_TEST_CRASH_AFTER_SPAWN;
  const recovered = spawn(process.execPath, [ENTRY_PATH, '--mode', 'recover', '--coordination-id', coordinationId], {
    env: recoverEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let recoveredStdout = '';
  recovered.stdout.on('data', (chunk) => { recoveredStdout += chunk.toString('utf8'); });
  recovered.stderr.on('data', (chunk) => { recoveredStdout += chunk.toString('utf8'); });
  recovered.stdin.write('{}\n');
  recovered.stdin.end();
  t.after(() => { try { recovered.kill('SIGKILL'); } catch { /* gone */ } });
  const recoveredReady = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`recovery never ready: ${recoveredStdout.slice(0, 300)}`)), 15_000);
    recovered.stdout.once('data', (chunk) => {
      const text = chunk.toString('utf8');
      const idx = text.indexOf('\n');
      if (idx === -1) return;
      clearTimeout(timer);
      resolve(JSON.parse(text.slice(0, idx)));
    });
  });
  void recoveredReady;

  await waitFor(() => !pidAlive(orphanPid), 12_000, 'orphan worker to be stopped by recovery');
  await waitFor(() => !existsSync(intentPath), 8_000, 'launch intent to be swept after resolution');
});

// Silence unused warnings for optional imports kept for harness parity.
void spawnSync; void after; void ensureOrchestrationRoots; void openCoordinationStore;
void writeAtomicJson; void MANIFEST_SCHEMA; void createAuthority;
