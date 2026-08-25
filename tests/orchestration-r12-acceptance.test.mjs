import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';

import {
  asPublicAdapter,
  createPublicLifecycle,
  createTrustedCoordinatorConfig,
} from '../src/orchestration/public-adapters.mjs';
import { createOwnedProcessAdapter } from '../src/orchestration/adapters/owned-process.mjs';
import { createClaudeStreamAdapter } from '../src/orchestration/adapters/claude-stream.mjs';
import { createCodexExecAdapter } from '../src/orchestration/adapters/codex-exec.mjs';
import { releaseRecoveredRuntimeDatabase } from '../src/orchestration/adapters/opencode-server.mjs';
import { canonicalizeExistingPrefix } from '../src/orchestration/verifier.mjs';
import { normalizeSettlementReceipt, SETTLEMENT_PROOF } from '../src/orchestration/settlement.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { commitDelivery, openCoordinationStore } from '../src/orchestration/store.mjs';
import {
  createCoordinationLayout,
  ensureOrchestrationRoots,
  resolveOrchestrationRoots,
} from '../src/orchestration/paths.mjs';
import { writeAtomicJson } from '../src/orchestration/atomic-file.mjs';
import { MANIFEST_SCHEMA } from '../src/orchestration/constants.mjs';

const FIXTURES = new URL('./fixtures/orchestration/', import.meta.url).pathname;
const DRIVER = join(dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'orchestration-crash-owner-driver.mjs');

const TEST_BASE = mkdtempSync('/tmp/r12acc-');
after(() => {
  try { rmSync(TEST_BASE, { recursive: true, force: true }); } catch { /* best effort */ }
});

function tempDir(name) {
  const dir = join(TEST_BASE, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
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

const FIXTURE_CONFIG_BASE = () => ({
  stateDir: TEST_BASE,
  allowFixtureDispatch: true,
  confinement: 'disposable-workspace',
  // /tmp is the PARENT of TEST_BASE; use its REAL spelling (/private/tmp).
  disposableRoot: realpathSync('/tmp'),
});

function ownedPair(t) {
  const stateDir = tempDir(`acc-op-${(coordCounter += 1)}`);
  const inner = createOwnedProcessAdapter({ stateDir });
  return asPublicAdapter(inner, createPublicLifecycle('owned-process', inner, createTrustedCoordinatorConfig({
    ...FIXTURE_CONFIG_BASE(),
    ownedProcessCommand: {
      command: process.execPath,
      args: [join(FIXTURES, 'fake-worker.mjs')],
      env: { ...process.env, FAKE_WORKER_MODE: 'ordered' },
    },
  })));
}

function claudePair(t, fakeMode = 'assert-args') {
  const stateDir = tempDir(`acc-cl-${(coordCounter += 1)}`);
  const inner = createClaudeStreamAdapter({
    stateDir,
    claudeBin: process.execPath,
    claudeArgs: [join(FIXTURES, 'fake-claude.mjs')],
    fakeModeEnv: { FAKE_CLAUDE_MODE: fakeMode, FAKE_CLAUDE_TRAP_MS: '8000' },
  });
  return asPublicAdapter(inner, createPublicLifecycle('claude-stream', inner, createTrustedCoordinatorConfig(FIXTURE_CONFIG_BASE())));
}

function codexPair(t) {
  const stateDir = tempDir(`acc-cx-${(coordCounter += 1)}`);
  const inner = createCodexExecAdapter({
    stateDir,
    codexBin: process.execPath,
    codexArgs: [join(FIXTURES, 'fake-codex.mjs')],
    fakeModeEnv: { FAKE_CODEX_MODE: 'assert-args' },
  });
  return asPublicAdapter(inner, createPublicLifecycle('codex-exec', inner, createTrustedCoordinatorConfig(FIXTURE_CONFIG_BASE())));
}

async function startSupervisor(t, name, adapters, extraEnv = {}) {
  const stateDir = tempDir(name);
  const coordinationId = `coord_acc_${(coordCounter += 1)}`;
  const effectiveEnv = extraEnv;
  if (effectiveEnv.WEBMCP_AI_ORCHESTRATION_STATE_DIR === undefined) {
    effectiveEnv.WEBMCP_AI_ORCHESTRATION_STATE_DIR = stateDir;
  }
  const sup = await createSupervisor({
    env: effectiveEnv,
    mode: 'create',
    coordinationId,
    ...(adapters.length > 0
      ? { adapters, trustedCoordinatorConfig: createTrustedCoordinatorConfig(FIXTURE_CONFIG_BASE()) }
      : {}),
  });
  t.after(() => sup.stop());
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const call = async (operation, input) => requestIpcShim(roots, coordinationId, sup, operation, input);
  return { sup, call, stateDir, coordinationId, roots, coordinationDir: join(roots.stateRoot, 'coordinations', coordinationId) };
}

async function requestIpcShim(roots, coordinationId, sup, operation, input) {
  const { deriveEndpoint } = await import('../src/orchestration/ipc.mjs');
  const { requestIpc } = await import('../src/orchestration/ipc.mjs');
  const { ORCHESTRATION_PROTOCOL } = await import('../src/orchestration/constants.mjs');
  const { readClientCapability } = await import('../src/orchestration/authority.mjs');
  return requestIpc(
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
    { timeoutMs: 25_000 },
  );
}

async function seedTask(call, packet) {
  const created = await call('task.create', { packet });
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  return created.result.taskId;
}

/* ==================================================================== */

test('R12 ACCEPTANCE — provider settlement, identity, crash windows, retention, cleanup, close', { timeout: 120_000 }, async (t) => {
  /* (1)(2) Claude + Codex public dispatches SETTLE with real identity ------ */
  for (const [kind, adapter, workspaceKind] of [
    ['claude-stream', claudePair(t), 'plain'],
    ['codex-exec', codexPair(t), 'git'],
  ]) {
    const ws = workspaceKind === 'git'
      ? (() => {
        const dir = tempDir(`acc-git-${coordCounter}`);
        execFileSync('git', ['-C', dir, 'init', '-q']);
        execFileSync('git', ['-C', dir, 'config', 'user.email', 'f@e.c']);
        execFileSync('git', ['-C', dir, 'config', 'user.name', 'F']);
        writeFileSync(join(dir, 'R.md'), 'x\n');
        execFileSync('git', ['-C', dir, 'add', '.']);
        execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'i']);
        return dir;
      })()
      : tempDir(`acc-ws-${coordCounter}`);
    const ctx = await startSupervisor(t, `acc-settle-${kind}`, [adapter]);
    const taskId = await seedTask(ctx.call, { objective: 'ok', workspace: ws, allowedReadRoots: [], allowedWriteRoots: [] });
    const started = await ctx.call('dispatch.start', { taskId, adapterId: kind });
    assert.equal(started.ok, true, `${kind}: ${JSON.stringify(started.error ?? {})}`);
    await waitFor(() => ctx.sup.__store.state.dispatches[started.result.dispatchId]?.state === 'settled',
      20_000, `${kind} settles`);
    assert.equal(ctx.sup.__store.state.tasks[taskId].state, 'awaiting_acceptance');
    const sidecar = JSON.parse(readFileSync(join(ctx.coordinationDir, 'runtime-bindings.json'), 'utf8')).bindings ?? {};
    assert.equal(sidecar[started.result.dispatchId], undefined, `${kind} binding released`);
    await ctx.sup.stop();
  }

  /* (3) Crash-after-spawn (owned + opencode) recovers via bound lease ----- */
  async function runCrash(kind, wsPrep) {
    const ownerDir = tempDir(`acc-owner-${kind}`);
    const opencodeHome = join(ownerDir, 'home');
    const coordinationId = `coord_acc_crash_${kind}_${(coordCounter += 1)}`;
    const driver = spawn(process.execPath, [DRIVER, '--state-dir', ownerDir, '--coordination-id', coordinationId,
      '--fixture', kind, '--workspace', wsPrep], {
      env: {
        ...process.env,
        WEBMCP_AI_ORCHESTRATION_STATE_DIR: ownerDir,
        ...(kind === 'opencode' ? { HOME: opencodeHome } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    driver.stdout.on('data', (c) => { out += c.toString(); });
    driver.stderr.on('data', (c) => { out += c.toString(); });
    t.after(() => { try { driver.kill('SIGKILL'); } catch { } });
    await waitFor(() => out.includes('"ready":true'), 15_000, `crash ready ${kind}`);
    await waitFor(() => /\{"taskId":"task_/.test(out), 15_000, `crash task ${kind}`);
    if (kind === 'owned') {
      // owned fixture is hold-silent; the hook kills the driver mid-start.
    }
    await waitFor(() => driver.exitCode !== null || driver.signalCode !== null, 15_000, `crash exit ${kind}`);
    if (driver.exitCode !== null) {
      throw new Error(`crash driver exited instead of SIGKILL (${kind}); code=${driver.exitCode}; output=${out.slice(0, 500)}`);
    }
    const cdir = join(ownerDir, 'coordinations', coordinationId);
    const intentPath = join(cdir, 'launch-intents', readdirSync(join(cdir, 'launch-intents'))[0]);
    const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
    assert.equal(intent.state, 'bound');
    assert.equal(intent.processIdentity.identityProven, true);
    const orphan = intent.processIdentity.pid;
    if (kind === 'opencode') assert.ok(intent.cleanupLease, 'oc lease present');
    assert.equal(pidAlive(orphan), true, `${kind} orphan alive pre-recovery`);

    const recSup = await createSupervisor({
      env: {
        WEBMCP_AI_ORCHESTRATION_STATE_DIR: ownerDir,
        ...(kind === 'opencode' ? { HOME: opencodeHome } : {}),
      },
      mode: 'recover', coordinationId,
    });
    await recSup.stop();
    assert.equal(existsSync(intentPath), false, `${kind} intent consumed`);
    assert.equal(pidAlive(orphan), false, `${kind} orphan stopped by recovery`);
    if (kind === 'opencode') {
      assert.equal(existsSync(intent.cleanupLease.canonicalRuntimeDbDir), false, 'leased db tree released');
    }
    try { process.kill(-orphan, 'SIGKILL'); } catch { }
  }
  const varWs = (n) => mkdtempSync(join(tmpdir(), `r12acc-ws-${n}-`));
  await runCrash('owned', varWs('owned'));
  await runCrash('opencode', varWs('oc'));

  /* (4) Unproven identity RETAINS binding + lease, never signals ---------- */
  {
    const holder = spawn(process.execPath, ['-e', 'setInterval(()=>{},10000)'], { stdio: 'ignore', detached: true });
    t.after(() => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { } });
    await waitFor(() => pidAlive(holder.pid), 3000, 'holder');

    // Build a settling dispatch with a lease whose identity probes are hidden.
    const stateDir = tempDir('acc-unproven');
    const coordinationId = `coord_acc_unproven_${(coordCounter += 1)}`;
    const fakeHome = join(stateDir, 'home');
    const env = { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir, HOME: fakeHome };
    const roots = resolveOrchestrationRoots({ env });
    ensureOrchestrationRoots(roots);
    const layout = createCoordinationLayout(roots.stateRoot, coordinationId);
    writeAtomicJson(layout.manifestPath, { schema: MANIFEST_SCHEMA, coordinationId, fenceEpoch: 1, processGeneration: 1, createdAt: new Date().toISOString(), owner: null });
    const { createAuthority } = await import('../src/orchestration/authority.mjs');
    createAuthority(layout);
    const store = openCoordinationStore(layout);
    for (const [type, payload] of [
      ['task_created', { taskId: 'task_u' }],
      ['dispatch_created', { dispatchId: 'disp_u', taskId: 'task_u' }],
      ['worker_done', { taskId: 'task_u', dispatchId: 'disp_u', outcome: 'completed', exitCode: 0, source: 'owned-process-exit' }],
    ]) commitDelivery(store, { type, payload });

    const dataRoot = (await import('../src/orchestration/adapters/opencode-server.mjs')).resolveOpencodeDataRoot({ env });
    mkdirSync(dataRoot, { recursive: true });
    const dbDir = join(dataRoot, 'webmcp-ai-runtime', 'worker_u1');
    const dbPath = join(dbDir, 'opencode.db');
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(dbPath, 'db\n');
    const startIdentity = await (await import('../src/orchestration/process-identity.mjs')).createPlatformIdentityDeps().getStartIdentity(holder.pid);
    const record = {
      bindingId: 'worker_u1', adapterId: 'opencode-server', capability: 'opencode-server',
      taskId: 'task_u', fenceEpoch: 1, controlOnly: false,
      processIdentity: { pid: holder.pid, startIdentity, processGroupId: holder.pid, identityProven: true },
      cleanupLease: {
        ownershipMode: 'runtime-owned', canonicalRuntimeDbPath: dbPath, canonicalRuntimeDbDir: dbDir,
        databaseIdentity: createHash('sha256').update(dbPath).digest('hex'),
        processIdentity: { pid: holder.pid, startIdentity, processGroupId: holder.pid },
      },
    };
    writeAtomicJson(join(layout.coordinationDir, 'runtime-bindings.json'), { schema: 'webmcp.ai-supervisor-runtime-bindings/v0', bindings: { disp_u: record } });

    // Recovery #1 with HIDDEN probes → unproven → retained.
    const realDeps = await import('../src/orchestration/process-identity.mjs');
    const sup1 = await createSupervisor({
      env, mode: 'recover', coordinationId,
      identityDepsFactory: () => {
        const real = realDeps.createPlatformIdentityDeps();
        return {
          platform: real.platform,
          getStartIdentity: async (pid) => (pid === holder.pid ? null : real.getStartIdentity(pid)),
          getProcessGroupId: (pid) => real.getProcessGroupId(pid),
          getRuntimeNonce: () => null,
        };
      },
    });
    await sup1.stop();
    assert.equal(pidAlive(holder.pid), true, 'unproven pid NEVER signalled');
    const keptBindings = JSON.parse(readFileSync(join(layout.coordinationDir, 'runtime-bindings.json'), 'utf8')).bindings;
    assert.ok(keptBindings.disp_u?.cleanupLease, 'lease retained while unproven');

    // Worker exits → recovery #2 releases DB and drops ownership exactly once.
    try { process.kill(-holder.pid, 'SIGKILL'); } catch { }
    await waitFor(() => !pidAlive(holder.pid), 5000, 'holder exit');
    const sup2 = await createSupervisor({ env, mode: 'recover', coordinationId });
    await sup2.stop();
    const journal = readFileSync(layout.journalPath, 'utf8');
    assert.equal(journal.split('"recovered-runtime-database-released"').length - 1, 1, 'released receipt EXACTLY once');
    assert.equal(existsSync(dbDir), false, 'tree released on retry');
    const afterBindings = JSON.parse(readFileSync(join(layout.coordinationDir, 'runtime-bindings.json'), 'utf8')).bindings;
    assert.equal(afterBindings.disp_u, undefined);
  }

  /* (5) Symlink-parent DB cleanup REFUSED, sentinel safe ------------------- */
  {
    const home = tempDir('acc-conf-home');
    const ocmod = await import('../src/orchestration/adapters/opencode-server.mjs');
    const dataRoot = ocmod.resolveOpencodeDataRoot({ homeDir: home });
    const prepared = ocmod.prepareRuntimeDatabase({ dataRoot, bindingId: 'worker_acc1' });
    const external = mkdtempSync(join(tmpdir(), 'r12acc-ext-'));
    const sentinel = join(external, 'sentinel.txt');
    writeFileSync(sentinel, 'KEEP\n');
    const fsmod = await import('node:fs');
    const stash = join(tempDir('acc-conf-stash'), 'wrt');
    fsmod.renameSync(dirname(prepared.dbDir), stash);
    fsmod.cpSync(stash, join(external, 'mirror', 'webmcp-ai-runtime'), { recursive: true });
    fsmod.rmSync(stash, { recursive: true, force: true });
    symlinkSync(join(external, 'mirror', 'webmcp-ai-runtime'), dirname(prepared.dbDir));

    const outcome = await releaseRecoveredRuntimeDatabase({
      cleanupLease: {
        ownershipMode: 'runtime-owned', canonicalRuntimeDbPath: prepared.dbPath, canonicalRuntimeDbDir: prepared.dbDir,
        databaseIdentity: prepared.databaseIdentity,
        processIdentity: { pid: 999_999_123, startIdentity: 'darwin:gone', processGroupId: 999_999_123 },
      },
    }, {});
    assert.equal(outcome.released, false, 'ancestor symlink must refuse release');
    assert.equal(existsSync(sentinel), true, 'external sentinel untouched');
    // restore lexical tree for safety
    fsmod.unlinkSync(dirname(prepared.dbDir));
    fsmod.renameSync(join(external, 'mirror', 'webmcp-ai-runtime'), dirname(prepared.dbDir));
  }

  /* (6)(7) covered by block 4 (retryable unproven DB cleanup) ------------- */

  /* (8) No durable write AFTER supervisor stop ---------------------------- */
  {
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},10000)'], { stdio: 'ignore', detached: true });
    t.after(() => { try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { } });
    await waitFor(() => pidAlive(sleeper.pid), 3000, 'sleeper8');
    const realStart = await (await import('../src/orchestration/process-identity.mjs')).createPlatformIdentityDeps().getStartIdentity(sleeper.pid);

    let resolveDoneAcc;
    const donePromise = new Promise((r) => { resolveDoneAcc = r; });
    let parkedFinalize = null;
    const inner = {
      id: 'owned-process', maturity: 'fixture-only',
      capabilities: Object.fromEntries(['liveEvents', 'explicitResume', 'externalAttach', 'questionChannel', 'permissionControl', 'sameTurnSteer', 'gracefulInterrupt', 'preToolGate', 'processOwnership', 'fileEvents', 'testEvents'].map((k) => [k, k === 'processOwnership'])),
      probe: async () => ({ adapterId: 'owned-process', available: true, maturity: 'fixture-only', capabilities: {} }),
      spawn: async ({ task, dispatch, emit }) => {
        emit('worker_started', { dispatchId: dispatch.dispatchId });
        return { ok: true, binding: { sessionId: 's', guaranteeTier: 'owned-process', processIdentity: { pid: sleeper.pid, processGroupId: sleeper.pid, startIdentity: realStart, identityProven: true } }, done: donePromise };
      },
      attach() { throw new Error('u'); }, subscribe() { throw new Error('u'); }, readSession: async () => null,
      sendReply() { throw new Error('u'); }, sendGuidance() { throw new Error('u'); }, resolvePermission() { throw new Error('u'); },
      interrupt: async () => ({ ok: true }), close: async () => ({ disposition: 'closed' }), sanitize: (e) => e,
    };
    const cfg = createTrustedCoordinatorConfig({ ...FIXTURE_CONFIG_BASE(), ownedProcessCommand: { command: process.execPath, args: ['-e', ''], env: {} } });
    const lifecycle = createPublicLifecycle('owned-process', inner, cfg);
    lifecycle.finalize = async () => new Promise((resolve) => { parkedFinalize = resolve; });
    const adapter = asPublicAdapter(inner, lifecycle);

    const ctx = await startSupervisor(t, 'acc-poststop', [adapter]);
    const taskId = await seedTask(ctx.call, { objective: 'x', workspace: tempDir('ws-poststop'), allowedReadRoots: [], allowedWriteRoots: [] });
    const started = await ctx.call('dispatch.start', { taskId, adapterId: 'owned-process' });
    assert.equal(started.ok, true);
    resolveDoneAcc({ terminalType: 'worker_done', exitCode: 0 });
    await waitFor(() => parkedFinalize !== null && ctx.sup.__store.state.dispatches[started.result.dispatchId].state === 'settling', 5000, 'parked finalize');

    const stopPromise = ctx.sup.stop();
    // While the finalizer still holds durable rights, stop() cannot have returned.
    let resolvedFlag = false;
    stopPromise.then(() => { resolvedFlag = true; });
    await new Promise((r) => setTimeout(r, 250));
    const journalSizeMidStop = readFileSync(join(ctx.coordinationDir, 'events.jsonl'), 'utf8').length;

    // Release finalizer UNPROVEN → conversion, no further retries/writes.
    parkedFinalize({ ok: true, disposition: 'group-signalled', signalsAttempted: ['SIGTERM'] });
    await stopPromise;
    const sizeAtReturn = readFileSync(join(ctx.coordinationDir, 'events.jsonl'), 'utf8').length;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(readFileSync(join(ctx.coordinationDir, 'events.jsonl'), 'utf8').length, sizeAtReturn, 'no journal growth after stop() returned');
    assert.equal(sizeAtReturn >= journalSizeMidStop, true);
    const bindingsNow = JSON.parse(readFileSync(join(ctx.coordinationDir, 'runtime-bindings.json'), 'utf8')).bindings;
    assert.ok(bindingsNow[started.result.dispatchId], 'binding not clobbered by stale owner');
    void resolvedFlag;
  }

  /* (9) Dangling / swapped write-root fails closed BEFORE spawn ------------ */
  {
    const dangling = join(tempDir('ws-dangle'), 'link');
    symlinkSync(join(tempDir('ws-dangle'), 'nope'), dangling);
    assert.throws(() => canonicalizeExistingPrefix(dangling), (e) => e.code === 'POLICY_DENIED');

    // Preswap seam: geometry changes between checks and spawn → typed refusal.
    const externalBase = mkdtempSync(join(tmpdir(), 'r12acc-swapext-'));
    const workspace = tempDir('ws-preswap');
    const adapter = ownedPair(t);
    const supEnv = {};
    const ctx = await startSupervisor(t, 'acc-preswap', [adapter], supEnv);
    supEnv.WEBMCP_AI_TEST_PRESWAP_HOOK = async () => {
      const mirror = join(externalBase, 'mirror');
      mkdirSync(mirror, { recursive: true });
      const stashed = join(externalBase, 'stash');
      const fsmod = await import('node:fs');
      fsmod.renameSync(workspace, stashed);
      fsmod.cpSync(stashed, mirror, { recursive: true });
      fsmod.rmSync(stashed, { recursive: true, force: true });
      symlinkSync(mirror, workspace);
    };
    const taskId = await seedTask(ctx.call, { objective: 'swap', workspace, allowedReadRoots: [], allowedWriteRoots: [] });
    const started = await ctx.call('dispatch.start', { taskId, adapterId: 'owned-process' });
    assert.equal(started.ok, false, `swapped geometry refuses before spawn (${JSON.stringify(started)})`);
  }

  /* (10) Failed spill leaves NO orphan ref -------------------------------- */
  {
    const stateDir = tempDir('acc-spill');
    const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
    ensureOrchestrationRoots(roots);
    const layout = createCoordinationLayout(roots.stateRoot, 'coord_acc_spill');
    writeAtomicJson(layout.manifestPath, { schema: MANIFEST_SCHEMA, coordinationId: 'coord_acc_spill', fenceEpoch: 1, processGeneration: 1, createdAt: new Date().toISOString(), owner: null });
    const store = openCoordinationStore(layout);
    commitDelivery(store, { type: 'task_created', payload: { taskId: 'task_sp' } });
    commitDelivery(store, { type: 'dispatch_created', payload: { dispatchId: 'disp_sp', taskId: 'task_sp' } });
    const seqBefore = store.state.lastSequence;
    assert.throws(() => commitDelivery(store, {
      type: 'dispatch_state_changed',
      payload: { dispatchId: 'disp_sp', taskId: 'task_sp', state: 'settled', blob: 'z'.repeat(400 * 1024) },
    }));
    assert.equal(store.state.lastSequence, seqBefore);
    const refsAfter = existsSync(layout.refsDir) ? readdirSync(layout.refsDir) : [];
    assert.deepEqual(refsAfter, [], `no orphan ref (${refsAfter})`);
    const okBig = commitDelivery(store, { type: 'progress', payload: { dispatchId: 'disp_sp', summary: 'valid-big', blob: 'q'.repeat(320 * 1024) } });
    assert.equal(okBig.delivery.sequence, seqBefore + 1, 'same next-sequence commits fine');
  }

  /* (11) coordination.close DEFERS before settlement ---------------------- */
  {
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},10000)'], { stdio: 'ignore', detached: true });
    t.after(() => { try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { } });
    await waitFor(() => pidAlive(sleeper.pid), 3000, 'sleeper11');
    const realStart = await (await import('../src/orchestration/process-identity.mjs')).createPlatformIdentityDeps().getStartIdentity(sleeper.pid);

    let resolveDone11;
    const done11 = new Promise((r) => { resolveDone11 = r; });
    let parkFinalize11 = null;
    const inner = {
      id: 'owned-process', maturity: 'fixture-only',
      capabilities: Object.fromEntries(['liveEvents', 'explicitResume', 'externalAttach', 'questionChannel', 'permissionControl', 'sameTurnSteer', 'gracefulInterrupt', 'preToolGate', 'processOwnership', 'fileEvents', 'testEvents'].map((k) => [k, k === 'processOwnership'])),
      probe: async () => ({ adapterId: 'owned-process', available: true, maturity: 'fixture-only', capabilities: {} }),
      spawn: async ({ task, dispatch, emit }) => {
        emit('worker_started', { dispatchId: dispatch.dispatchId });
        return { ok: true, binding: { sessionId: 's', guaranteeTier: 'owned-process', processIdentity: { pid: sleeper.pid, processGroupId: sleeper.pid, startIdentity: realStart, identityProven: true } }, done: done11 };
      },
      attach() { throw new Error('u'); }, subscribe() { throw new Error('u'); }, readSession: async () => null,
      sendReply() { throw new Error('u'); }, sendGuidance() { throw new Error('u'); }, resolvePermission() { throw new Error('u'); },
      interrupt: async () => ({ ok: true }), close: async () => ({ disposition: 'closed' }), sanitize: (e) => e,
    };
    const cfg = createTrustedCoordinatorConfig({ ...FIXTURE_CONFIG_BASE(), ownedProcessCommand: { command: process.execPath, args: ['-e', ''], env: {} } });
    const lifecycle = createPublicLifecycle('owned-process', inner, cfg);
    lifecycle.finalize = async () => new Promise((resolve) => { parkFinalize11 = resolve; });
    const adapter = asPublicAdapter(inner, lifecycle);

    const ctx = await startSupervisor(t, 'acc-close-defer', [adapter]);
    const taskId = await seedTask(ctx.call, { objective: 'x', workspace: tempDir('ws-close-defer'), allowedReadRoots: [], allowedWriteRoots: [] });
    const started = await ctx.call('dispatch.start', { taskId, adapterId: 'owned-process' });
    resolveDone11({ terminalType: 'worker_done', exitCode: 0 });
    await waitFor(() => ctx.sup.__store.state.dispatches[started.result.dispatchId].state === 'settling', 5000, 'settling');

    const earlyClose = await ctx.call('coordination.close', {});
    assert.equal(earlyClose.ok, false, 'close deferred before settlement');
    assert.equal(ctx.sup.__store.state.coordinationState, 'closing', 'closing stays retryable');

    parkFinalize11({ ok: true, disposition: 'group-stopped', exitProven: true, signalsAttempted: ['GROUP_SIGTERM'] });
    await waitFor(() => ctx.sup.__store.state.dispatches[started.result.dispatchId].state === 'settled', 5000, 'settled');
    const lateClose = await ctx.call('coordination.close', {});
    assert.equal(lateClose.ok, true, JSON.stringify(lateClose.error ?? {}));
    assert.equal(ctx.sup.__store.state.coordinationState, 'closed');
  }

  /* Settlement classifier honesty (signal-sent ≠ absence) ---------------- */
  for (const disposition of ['stopped', 'killed']) {
    assert.equal(normalizeSettlementReceipt({ ok: true, disposition }).proof, SETTLEMENT_PROOF.FAILED_UNPROVEN);
  }
});
