import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const PKG_ROOT = join(dirname(new URL(import.meta.url).pathname), '..');

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r9c-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Pack the CURRENT package and install it into a clean consumer prefix.
 * Everything below runs against the INSTALLED package only — the repo source
 * stays out of the proof. A tmpdir mkdir lock serializes npm across parallel
 * test FILES (separate processes) because concurrent installs contend.
 */
const INSTALL_LOCK = join(tmpdir(), 'webmcp-ai-r9c-npm.lock');
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withNpmLock(work) {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      mkdirSync(INSTALL_LOCK);
      try {
        writeFileSync(join(INSTALL_LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
      } catch { /* best effort */ }
      break;
    } catch (lockError) {
      // Existing lock: steal it when the owner died or went stale.
      let stolen = false;
      try {
        const stamp = JSON.parse(readFileSync(join(INSTALL_LOCK, 'owner.json'), 'utf8'));
        const ageMs = Date.now() - Number(stamp.at ?? 0);
        stolen = !pidAlive(Number(stamp.pid)) || ageMs > 120_000;
      } catch {
        try {
          stolen = Date.now() - statSync(INSTALL_LOCK).mtimeMs > 120_000;
        } catch { /* vanished; retry */ }
      }
      if (stolen) {
        try { rmSync(INSTALL_LOCK, { recursive: true, force: true }); } catch { /* racing steal */ }
      }
      if (Date.now() > deadline) throw new Error('npm install lock timed out');
      await new Promise((resolveTick) => setTimeout(resolveTick, 200));
    }
  }
  try {
    return await work();
  } finally {
    try {
      const stamp = JSON.parse(readFileSync(join(INSTALL_LOCK, 'owner.json'), 'utf8'));
      if (Number(stamp.pid) === process.pid) rmSync(INSTALL_LOCK, { recursive: true, force: true });
    } catch {
      rmSync(INSTALL_LOCK, { recursive: true, force: true });
    }
  }
}

async function packAndInstall(t) {
  return withNpmLock(async () => {
    const packDir = tempDir(t, 'pack');
    execFileSync('npm', ['pack', '--pack-destination', packDir], { cwd: PKG_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const tarball = readdirOne(packDir);
    // Extract the packed tarball directly instead of `npm install`: modern
    // npm refuses dependency lifecycle scripts in sandboxed contexts
    // (EALLOWSCRIPTS), and this proof needs only THIS package's own files.
    const consumer = tempDir(t, 'consumer');
    execFileSync('tar', ['-xzf', join(packDir, tarball), '-C', consumer], { encoding: 'utf8' });
    const installedRoot = join(consumer, 'package');
    assert.equal(existsSync(join(installedRoot, 'package.json')), true, 'packed package must extract cleanly');
    return installedRoot;
  });
}

function readdirOne(dir) {
  const names = readdirSync(dir);
  assert.equal(names.length, 1, `expected exactly one packed tarball, got ${names}`);
  return names[0];
}

async function importInstalled(installedRoot, relativePath) {
  return import(pathToFileURL(join(installedRoot, relativePath)).href);
}

test('R9C: a real installed child delivers progress and terminal through its capability file', async (t) => {
  const installedRoot = await packAndInstall(t);

  const {
    createSupervisor,
  } = await importInstalled(installedRoot, 'src/orchestration/supervisor.mjs');
  const {
    resolveOrchestrationRoots,
  } = await importInstalled(installedRoot, 'src/orchestration/paths.mjs');
  const {
    deriveEndpoint, requestIpc,
  } = await importInstalled(installedRoot, 'src/orchestration/ipc.mjs');
  const {
    ORCHESTRATION_PROTOCOL,
  } = await importInstalled(installedRoot, 'src/orchestration/constants.mjs');
  const { readClientCapability } = await importInstalled(installedRoot, 'src/orchestration/authority.mjs');
  const {
    createTrustedCoordinatorConfig,
    asPublicAdapter,
    createPublicLifecycle,
  } = await importInstalled(installedRoot, 'src/orchestration/public-adapters.mjs');
  const { createOwnedProcessAdapter } = await importInstalled(installedRoot, 'src/orchestration/adapters/owned-process.mjs');

  const stateDir = tempDir(t, 'state');
  const coordinationId = `coord_r9c_${Date.now().toString(36)}`;
  const supEnv = { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir };

  // Trusted launch configuration: the child is the PACKAGED helper running in
  // a separate real process. It receives ONLY the capability-file path env var
  // from the runtime; argv carries no secrets.
  const helperPath = join(installedRoot, 'scripts', 'worker-callback-client.mjs');
  const config = createTrustedCoordinatorConfig({
    stateDir: join(stateDir, 'trusted'),
    allowFixtureDispatch: true,
    ownedProcessCommand: {
      command: process.execPath,
      args: [helperPath, 'demo'],
      env: {},
    },
  });
  const inner = createOwnedProcessAdapter({ stateDir: join(stateDir, 'op') });
  const adapter = asPublicAdapter(inner, createPublicLifecycle('owned-process', inner, config));

  const sup = await createSupervisor({
    env: supEnv,
    mode: 'create',
    coordinationId,
    adapters: [adapter],
    trustedCoordinatorConfig: { allowFixtureDispatch: true },
  });
  t.after(() => sup.stop());

  const roots = resolveOrchestrationRoots({ env: supEnv });
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

  const created = await call('task.create', {
    packet: { objective: 'Report progress then finish', workspace: tmpdir(), allowedReadRoots: [], allowedWriteRoots: [] },
  });
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  const taskId = created.result.taskId;
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));
  const dispatchId = started.result.dispatchId;

  const capabilityDir = join(coordinationDir, 'dispatch-capabilities');
  assert.equal(existsSync(capabilityDir), true, 'private dispatch-capabilities directory must exist during flight');
  if (process.platform !== 'win32') {
    assert.equal(statSync(capabilityDir).mode & 0o777, 0o700, 'capability directory must be 0700');
  }

  // Drain the PUBLIC delivery stream until terminal settlement.
  const seenTypes = new Set();
  let cursor = 0;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const wait = await call('delivery.wait', { afterSequence: cursor, timeoutMs: 1_000 });
    assert.equal(wait.ok, true, JSON.stringify(wait.error ?? {}));
    for (const delivery of wait.result?.deliveries ?? []) {
      seenTypes.add(delivery.type);
      cursor = Math.max(cursor, delivery.sequence ?? 0);
    }
    const dispatchNow = sup.__store.state.dispatches[dispatchId];
    if (dispatchNow?.state === 'settled' && seenTypes.has('worker_done')) break;
    if (Date.now() > deadline) break;
  }

  assert.equal(seenTypes.has('progress'), true, `child progress must arrive over real IPC: ${[...seenTypes]}`);
  assert.equal(seenTypes.has('worker_done'), true, `child terminal must arrive over real IPC: ${[...seenTypes]}`);
  const settled = sup.__store.state.dispatches[dispatchId];
  assert.equal(settled.state, 'settled', JSON.stringify(settled));
  assert.equal(settled.terminalOutcome, 'completed');

  // Capability hygiene after settlement.
  assert.equal(
    existsSync(join(capabilityDir, `${dispatchId}.cap`)),
    false,
    'the capability file must be revoked after terminal + cleanup + settled',
  );
}, { timeout: 120_000 });

test('R9C: journals and snapshots never contain the plaintext capability token', async (t) => {
  const installedRoot = await packAndInstall(t);
  const {
    createSupervisor,
  } = await importInstalled(installedRoot, 'src/orchestration/supervisor.mjs');
  const {
    resolveOrchestrationRoots,
  } = await importInstalled(installedRoot, 'src/orchestration/paths.mjs');
  const {
    deriveEndpoint, requestIpc,
  } = await importInstalled(installedRoot, 'src/orchestration/ipc.mjs');
  const {
    ORCHESTRATION_PROTOCOL,
  } = await importInstalled(installedRoot, 'src/orchestration/constants.mjs');
  const { readClientCapability } = await importInstalled(installedRoot, 'src/orchestration/authority.mjs');
  const {
    createTrustedCoordinatorConfig,
    asPublicAdapter,
    createPublicLifecycle,
  } = await importInstalled(installedRoot, 'src/orchestration/public-adapters.mjs');
  const { createOwnedProcessAdapter } = await importInstalled(installedRoot, 'src/orchestration/adapters/owned-process.mjs');
  const { writeDispatchCapability, readDispatchCapabilityFile, capabilityDigestOf } = await importInstalled(
    installedRoot,
    'src/orchestration/worker-callback.mjs',
  );

  const stateDir = tempDir(t, 'leak-state');
  const coordinationId = `coord_r9c_leak_${Date.now().toString(36)}`;
  const supEnv = { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir };
  const helperPath = join(installedRoot, 'scripts', 'worker-callback-client.mjs');
  const config = createTrustedCoordinatorConfig({
    stateDir: join(stateDir, 'trusted'),
    allowFixtureDispatch: true,
    ownedProcessCommand: { command: process.execPath, args: [helperPath, 'demo'], env: {} },
  });
  const inner = createOwnedProcessAdapter({ stateDir: join(stateDir, 'op') });
  const adapter = asPublicAdapter(inner, createPublicLifecycle('owned-process', inner, config));

  const sup = await createSupervisor({
    env: supEnv,
    mode: 'create',
    coordinationId,
    adapters: [adapter],
    trustedCoordinatorConfig: { allowFixtureDispatch: true },
  });
  t.after(() => sup.stop());

  const roots = resolveOrchestrationRoots({ env: supEnv });
  const coordinationDir = join(roots.stateRoot, 'coordinations', coordinationId);

  // Unit proof of the capability file contract from the INSTALLED package.
  const capFile = writeDispatchCapability({
    coordinationDir,
    endpoint: '/tmp/not-a-real-endpoint',
    coordinationId,
    taskId: 'task_r9c',
    dispatchId: 'disp_r9c',
    bindingId: 'worker_r9c',
    fenceEpoch: 3,
    capabilityToken: 'r9c-token-value-abcdef1234567890',
  });
  if (process.platform !== 'win32') {
    assert.equal(statSync(capFile).mode & 0o777, 0o600, 'capability file must be 0600');
  }
  const parsed = readDispatchCapabilityFile(capFile);
  assert.equal(parsed.capabilityToken, 'r9c-token-value-abcdef1234567890');
  assert.equal(parsed.fenceEpoch, 3);

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

  const created = await call('task.create', {
    packet: { objective: 'Leak probe', workspace: tmpdir(), allowedReadRoots: [], allowedWriteRoots: [] },
  });
  const taskId = created.result.taskId;
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true);
  const dispatchId = started.result.dispatchId;

  // Capture the LIVE token while the dispatch flies.
  const liveCapPath = join(coordinationDir, 'dispatch-capabilities', `${dispatchId}.cap`);
  assert.equal(existsSync(liveCapPath), true);
  const liveToken = readDispatchCapabilityFile(liveCapPath).capabilityToken;

  // Wait for full settlement so journal AND snapshot are written.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const record = sup.__store.state.dispatches[dispatchId];
    if (record?.state === 'settled' && !existsSync(liveCapPath)) break;
    if (Date.now() > deadline) break;
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }

  const journalText = readFileSync(join(coordinationDir, 'events.jsonl'), 'utf8');
  assert.equal(journalText.includes(liveToken), false, 'journal must never contain the plaintext token');
  assert.equal(journalText.includes('r9c-token-value-abcdef1234567890'), false, 'unit-seeded token must not leak either');
  const bindingsText = readFileSync(join(coordinationDir, 'runtime-bindings.json'), 'utf8');
  assert.equal(bindingsText.includes(liveToken), false, 'durable bindings must never carry the plaintext token');
  if (existsSync(join(coordinationDir, 'snapshot.json'))) {
    const snapshotText = readFileSync(join(coordinationDir, 'snapshot.json'), 'utf8');
    assert.equal(snapshotText.includes(liveToken), false, 'snapshot must never contain the plaintext token');
  }
  void capabilityDigestOf;
}, { timeout: 120_000 });

test('R9C: a callback-capable child reconnects after a supervisor restart', async (t) => {
  const installedRoot = await packAndInstall(t);
  const {
    createSupervisor,
  } = await importInstalled(installedRoot, 'src/orchestration/supervisor.mjs');
  const {
    resolveOrchestrationRoots,
  } = await importInstalled(installedRoot, 'src/orchestration/paths.mjs');
  const {
    deriveEndpoint, requestIpc,
  } = await importInstalled(installedRoot, 'src/orchestration/ipc.mjs');
  const {
    ORCHESTRATION_PROTOCOL,
  } = await importInstalled(installedRoot, 'src/orchestration/constants.mjs');
  const { readClientCapability } = await importInstalled(installedRoot, 'src/orchestration/authority.mjs');
  const {
    createTrustedCoordinatorConfig,
    asPublicAdapter,
    createPublicLifecycle,
  } = await importInstalled(installedRoot, 'src/orchestration/public-adapters.mjs');
  const { createOwnedProcessAdapter } = await importInstalled(installedRoot, 'src/orchestration/adapters/owned-process.mjs');

  const stateDir = tempDir(t, 'restart-state');
  const coordinationId = `coord_r9c_re_${Date.now().toString(36)}`;
  const supEnv = { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir };
  const helperPath = join(installedRoot, 'scripts', 'worker-callback-client.mjs');
  const triggerFile = join(tempDir(t, 'trigger'), 'go.txt');
  const roots = resolveOrchestrationRoots({ env: supEnv });
  const coordinationDir = join(roots.stateRoot, 'coordinations', coordinationId);

  const buildAdapter = () => {
    const config = createTrustedCoordinatorConfig({
      stateDir: join(stateDir, 'trusted'),
      allowFixtureDispatch: true,
      ownedProcessCommand: {
        command: process.execPath,
        args: [helperPath, 'demo', '--trigger', triggerFile],
        env: {},
      },
    });
    const inner = createOwnedProcessAdapter({ stateDir: join(stateDir, 'op') });
    return asPublicAdapter(inner, createPublicLifecycle('owned-process', inner, config));
  };
  const makeCall = (sup) => async (operation, input) => requestIpc(
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

  const sup1 = await createSupervisor({
    env: supEnv,
    mode: 'create',
    coordinationId,
    adapters: [buildAdapter()],
    trustedCoordinatorConfig: { allowFixtureDispatch: true },
  });
  const call1 = makeCall(sup1);
  const created = await call1('task.create', {
    packet: { objective: 'Survive restart', workspace: tmpdir(), allowedReadRoots: [], allowedWriteRoots: [] },
  });
  const taskId = created.result.taskId;
  const started = await call1('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true);
  const dispatchId = started.result.dispatchId;

  // Wait until the child's FIRST progress frame landed on supervisor #1.
  const progressDeadline = Date.now() + 20_000;
  let sawProgress = false;
  let cursor = 0;
  while (Date.now() < progressDeadline && !sawProgress) {
    const wait = await call1('delivery.wait', { afterSequence: cursor, timeoutMs: 500 });
    for (const delivery of wait.result?.deliveries ?? []) {
      cursor = Math.max(cursor, delivery.sequence ?? 0);
      if (delivery.type === 'progress') sawProgress = true;
    }
  }
  assert.equal(sawProgress, true, 'first progress must land before the restart');

  // Supervisor #1 goes away WITHOUT settling the dispatch.
  await sup1.stop();

  // Supervisor #2 recovers the SAME coordination; the child reconnects to the
  // re-created endpoint and finishes its terminal report there.
  const sup2 = await createSupervisor({
    env: supEnv,
    mode: 'recover',
    coordinationId,
    adapters: [buildAdapter()],
    trustedCoordinatorConfig: { allowFixtureDispatch: true },
  });
  t.after(() => sup2.stop());
  const call2 = makeCall(sup2);

  writeFileSync(triggerFile, 'now\n');
  const settleDeadline = Date.now() + 30_000;
  let outcome = null;
  for (;;) {
    const record = sup2.__store.state.dispatches[dispatchId];
    outcome = record ? { state: record.state, terminal: record.terminalOutcome } : null;
    if (outcome?.terminal === 'completed') break;
    if (Date.now() > settleDeadline) break;
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
  // The child reconnected to the RECOVERED supervisor and its exactly-once
  // terminal report landed durably. (Post-restart resource finalization is
  // exercised by the dedicated restart tests.)
  assert.equal(outcome?.terminal, 'completed', `post-restart terminal must settle: ${JSON.stringify(outcome)}`);
  assert.equal(['settling', 'settled'].includes(outcome?.state), true, JSON.stringify(outcome));
}, { timeout: 120_000 });
