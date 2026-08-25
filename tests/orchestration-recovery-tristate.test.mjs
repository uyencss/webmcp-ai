import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';

import {
  asPublicAdapter,
  createPublicLifecycle,
  createTrustedCoordinatorConfig,
} from '../src/orchestration/public-adapters.mjs';
import { createOwnedProcessAdapter } from '../src/orchestration/adapters/owned-process.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { createPlatformIdentityDeps } from '../src/orchestration/process-identity.mjs';
import { readClientCapability } from '../src/orchestration/authority.mjs';
import { deriveEndpoint, requestIpc } from '../src/orchestration/ipc.mjs';
import { resolveOrchestrationRoots } from '../src/orchestration/paths.mjs';
import { ORCHESTRATION_PROTOCOL } from '../src/orchestration/constants.mjs';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
const DRIVER = join(ROOT, 'scripts', 'orchestration-crash-owner-driver.mjs');
const FIXTURES = new URL('./fixtures/orchestration/', import.meta.url).pathname;

// One SHARED short-lived base keeps every derived IPC socket comfortably
// below macOS's 104-byte sun_path limit.
const TEST_BASE = mkdtempSync(join(tmpdir(), 'r12c-'));
after(() => {
  try { rmSync(TEST_BASE, { recursive: true, force: true }); } catch { /* best effort */ }
});

function tempDir(name) {
  const dir = join(TEST_BASE, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const CLOSERS = [];
after(async () => {
  for (const closer of CLOSERS.splice(0)) {
    try { await closer(); } catch { /* best effort */ }
  }
});

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
    if (result) return result;
    if (Date.now() - startedAt > deadlineMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
}

let coordCounter = 0;

/**
 * Boot a live owner subprocess that launches one held worker and STAYS UP;
 * the harness then SIGKILLs it to simulate a crash AFTER the durable runtime
 * binding was recorded. Returns everything needed to inspect the aftermath.
 */
async function runLiveOwner(t, kind, { workspace }) {
  const stateDir = tempDir(`${kind}-owner`);
  const coordinationId = `coord_r12c_${(coordCounter += 1)}`;
  const driver = spawn(process.execPath, [
    DRIVER,
    '--state-dir', stateDir,
    '--coordination-id', coordinationId,
    '--fixture', kind,
    '--workspace', workspace,
    '--hold', '1',
  ], {
    env: { ...process.env, WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdoutText = '';
  let stderrText = '';
  driver.stdout.on('data', (chunk) => { stdoutText += chunk.toString('utf8'); });
  driver.stderr.on('data', (chunk) => { stderrText += chunk.toString('utf8'); });
  const hardKill = () => {
    try {
      if (driver.exitCode === null && driver.signalCode === null) driver.kill('SIGKILL');
    } catch { /* gone */ }
  };
  t.after(hardKill);
  CLOSERS.push(hardKill);

  await waitFor(() => stdoutText.includes('"ready":true'), 15_000,
    `driver ready (${kind}); stderr=${stderrText.slice(0, 300)}`);
  const startedLine = await waitFor(() => {
    const match = stdoutText.match(/\{"started":true,"dispatchId":"disp_[^"]+"\}/);
    return match ? match[0] : null;
  }, 15_000, `dispatch start (${kind})`);
  const dispatchId = JSON.parse(startedLine).dispatchId;

  // Simulate the owner crash: SIGKILL mid-flight with its worker detached.
  hardKill();
  await waitFor(() => driver.exitCode !== null || driver.signalCode !== null, 5_000, 'owner crash');

  const coordinationDir = join(stateDir, 'coordinations', coordinationId);
  const bindingsPath = join(coordinationDir, 'runtime-bindings.json');
  await waitFor(() => existsSync(bindingsPath), 5_000, `runtime binding sidecar (${kind})`);
  const bindings = JSON.parse(readFileSync(bindingsPath, 'utf8')).bindings ?? {};
  const record = bindings[dispatchId];
  assert.ok(record, `binding must be durably recorded (${kind})`);

  return {
    stateDir,
    coordinationId,
    dispatchId,
    record,
    bindingsPath,
    coordinationDir,
    orphanPid: record.processIdentity.pid,
    journalPath: join(coordinationDir, 'events.jsonl'),
    journalRecords: () => readFileSync(join(coordinationDir, 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  };
}

function currentBindings(crash) {
  if (!existsSync(crash.bindingsPath)) return {};
  return JSON.parse(readFileSync(crash.bindingsPath, 'utf8')).bindings ?? {};
}

async function recover(t, crash, { hideIdentityForPid = null } = {}) {
  let identityDepsFactory;
  if (hideIdentityForPid !== null) {
    identityDepsFactory = () => {
      const real = createPlatformIdentityDeps();
      return {
        platform: real.platform,
        getStartIdentity: async (pid) => (pid === hideIdentityForPid ? null : real.getStartIdentity(pid)),
        getProcessGroupId: async (pid) => real.getProcessGroupId(pid),
        getRuntimeNonce: () => null,
      };
    };
  }
  const recovered = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: crash.stateDir },
    mode: 'recover',
    coordinationId: crash.coordinationId,
    ...(identityDepsFactory ? { identityDepsFactory } : {}),
  });
  t.after(() => recovered.stop());
  return recovered;
}

/* ------------------------------------------------------------------ */
/* Harness for in-process control-time tri-state tests                 */
/* ------------------------------------------------------------------ */

const ALL_FALSE_CAPABILITIES = Object.fromEntries([
  'liveEvents', 'explicitResume', 'externalAttach', 'questionChannel', 'permissionControl',
  'sameTurnSteer', 'gracefulInterrupt', 'preToolGate', 'processOwnership', 'fileEvents', 'testEvents',
].map((key) => [key, key === 'gracefulInterrupt' || key === 'processOwnership']));

function stubOwnedAdapter(targetPid, startIdentity, hooks = {}) {
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
          sessionId: 'ses_stub',
          guaranteeTier: 'owned-process',
          processIdentity: {
            pid: targetPid,
            processGroupId: targetPid,
            ...(startIdentity ? { startIdentity } : {}),
          },
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
    confinement: 'disposable-workspace',
    disposableRoot: tmpdir(),
    ownedProcessCommand: { command: process.execPath, args: ['-e', ''], env: {} },
  });
  const lifecycle = createPublicLifecycle('owned-process', inner, config);
  if (hooks.control) lifecycle.control = hooks.control;
  return asPublicAdapter(inner, lifecycle);
}

async function startInProcessSupervisor(t, name, { adapters = [], hidePids = [] } = {}) {
  const stateDir = tempDir(name);
  const coordinationId = `coord_r12c_ip_${(coordCounter += 1)}`;
  let identityDepsFactory;
  if (hidePids.length > 0) {
    identityDepsFactory = () => {
      const real = createPlatformIdentityDeps();
      return {
        platform: real.platform,
        getStartIdentity: async (pid) => (hidePids.includes(pid) ? null : real.getStartIdentity(pid)),
        getProcessGroupId: async (pid) => real.getProcessGroupId(pid),
        getRuntimeNonce: () => null,
      };
    };
  }
  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'create',
    coordinationId,
    adapters,
    trustedCoordinatorConfig: createTrustedCoordinatorConfig({
      stateDir: TEST_BASE,
      allowFixtureDispatch: true,
      confinement: 'disposable-workspace',
      disposableRoot: tmpdir(),
    }),
    ...(identityDepsFactory ? { identityDepsFactory } : {}),
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
  return { sup, stateDir, coordinationId, roots, coordinationDir: join(roots.stateRoot, 'coordinations', coordinationId), call };
}

async function seedTask(call, packet) {
  const created = await call('task.create', { packet });
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  return created.result.taskId;
}

/* ------------------------------------------------------------------ */

test('R12C: unavailable identity keeps the binding and parks recovery — never lost while alive', async (t) => {
  const workspace = tempDir('ws-hold');
  const crash = await runLiveOwner(t, 'owned', { workspace });

  assert.equal(crash.record.controlOnly, false);
  assert.equal(pidAlive(crash.orphanPid), true, 'prerequisite: the detached worker survives its owner');

  // Recovery boots with probes HIDDEN for exactly this pid: identity is
  // UNAVAILABLE, which is neither matched nor provably recycled.
  const firstRecovery = await recover(t, crash, { hideIdentityForPid: crash.orphanPid });

  const retained = currentBindings(crash)[crash.dispatchId];
  assert.ok(retained, 'the durable binding MUST survive an unproven classification');
  assert.equal(retained.controlOnly, false);

  const records = crash.journalRecords();
  const parkReceipts = records.filter((r) => r.type === 'cleanup_recorded'
    && r.payload?.disposition === 'recovery-identity-unproven-retained');
  assert.equal(parkReceipts.length, 1, `exactly one park receipt expected (${JSON.stringify(records.map((r) => [r.type, r.payload?.disposition]))})`);
  assert.equal(parkReceipts[0].payload.idempotencyKey.endsWith(':park'), true);
  assert.equal(records.some((r) => r.type === 'dispatch_reconciled'), false,
    'an unproven fate must NOT reconcile the dispatch to lost');

  assert.equal(pidAlive(crash.orphanPid), true, 'recovery must NEVER signal an unproven pid');

  // Release the FIRST recovery's ownership before the follow-up boot.
  await firstRecovery.stop();

  // Second phase: the worker REALLY exits now; the NEXT recovery completes
  // the settlement honestly (binding released, dispatch reconciled lost).
  try { process.kill(-crash.orphanPid, 'SIGKILL'); } catch { /* gone */ }
  await waitFor(() => !pidAlive(crash.orphanPid), 5_000, 'real worker exit');
  const secondRecovery = await recover(t, crash);

  const afterExit = crash.journalRecords().filter((r) => r.sequence > parkReceipts[0].sequence || true);
  assert.ok(afterExit.some((r) => r.type === 'cleanup_recorded'
    && r.payload?.disposition === 'recovered-binding-reconciled-lost'),
  'the follow-up recovery must record the truthful lost reconciliation');
  assert.ok(afterExit.some((r) => r.type === 'dispatch_reconciled'
    && r.payload?.outcome === 'lost'
    && r.payload?.reason === 'no-live-binding-provable-after-restart'),
  'once absence is PROVEN the dispatch finally reconciles lost');
  assert.equal(currentBindings(crash)[crash.dispatchId], undefined, 'the binding is released only after proven absence');
});

test('R12C: control-time identity probe failure refuses typed and retains ownership', async (t) => {
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},10000)'], { stdio: 'ignore', detached: true });
  t.after(() => {
    try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { try { sleeper.kill('SIGKILL'); } catch { /* gone */ } }
  });
  await waitFor(() => pidAlive(sleeper.pid), 3_000, 'sleeper start');
  const realIdentity = await createPlatformIdentityDeps().getStartIdentity(sleeper.pid);
  assert.ok(realIdentity, 'prerequisite: sleeper identity must be provable');

  const adapter = stubOwnedAdapter(sleeper.pid, realIdentity);
  // The supervisor's probes for THIS pid always fail: presence alive,
  // identity unavailable.
  const { sup, call, coordinationDir } = await startInProcessSupervisor(t, 'probe-hidden', {
    adapters: [adapter],
    hidePids: [sleeper.pid],
  });
  const taskId = await seedTask(call, { objective: 'x', workspace: tempDir('ws-probe') });
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));
  const dispatchId = started.result.dispatchId;

  const stop = await call('dispatch.interrupt', { dispatchId, reason: 'r12c-probe-fail' });
  assert.equal(stop.ok, false, JSON.stringify(stop));
  assert.equal(stop.error?.code, 'WORKER_IDENTITY_UNPROVEN', JSON.stringify(stop.error ?? {}));
  assert.match(stop.error?.message ?? '', /unavailable/i);

  const bindings = JSON.parse(readFileSync(join(coordinationDir, 'runtime-bindings.json'), 'utf8')).bindings ?? {};
  assert.ok(bindings[dispatchId], 'the binding must be retained');
  assert.equal(pidAlive(sleeper.pid), true, 'an unproven target must never be signalled');
  const journal = readFileSync(join(coordinationDir, 'events.jsonl'), 'utf8');
  assert.match(journal, /control-identity-unavailable-retained/, 'the honest retention evidence must be journaled');
  void sup;
});

test('R12C: a SUCCESSFUL mismatched probe remains the ONLY pid-recycle release path', async (t) => {
  // Two independent sleepers: the binding points at victim A's PID but with
  // a deliberately WRONG startIdentity; bystander B shares nothing.
  const victim = spawn(process.execPath, ['-e', 'setInterval(()=>{},10000)'], { stdio: 'ignore', detached: true });
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},10000)'], { stdio: 'ignore', detached: true });
  t.after(() => {
    for (const proc of [victim, bystander]) {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
    }
  });
  await waitFor(() => pidAlive(victim.pid) && pidAlive(bystander.pid), 3_000, 'sleepers');

  const adapter = stubOwnedAdapter(victim.pid, 'darwin:definitely-not-the-real-start-time');
  const { sup, call, coordinationDir } = await startInProcessSupervisor(t, 'recycled-release', {
    adapters: [adapter],
  });
  const taskId = await seedTask(call, { objective: 'x', workspace: tempDir('ws-cycle') });
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));
  const dispatchId = started.result.dispatchId;

  const stop = await call('dispatch.interrupt', { dispatchId, reason: 'r12c-recycle' });
  assert.equal(stop.ok, true, JSON.stringify(stop));
  assert.equal(stop.result.disposition, 'pid-recycled');
  assert.equal(stop.result.stopped, true);

  const bindings = JSON.parse(readFileSync(join(coordinationDir, 'runtime-bindings.json'), 'utf8')).bindings ?? {};
  assert.equal(bindings[dispatchId], undefined, 'a proven mismatch releases the binding');
  assert.equal(pidAlive(victim.pid), true, 'the mismatched NEW holder is never signalled');
  assert.equal(pidAlive(bystander.pid), true, 'unrelated processes stay untouched');
  void sup;
});
