import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';

import {
  asPublicAdapter,
  createPublicLifecycle,
  createTrustedCoordinatorConfig,
} from '../src/orchestration/public-adapters.mjs';
import { createOwnedProcessAdapter } from '../src/orchestration/adapters/owned-process.mjs';
import { canonicalizeExistingPrefix } from '../src/orchestration/verifier.mjs';
import { readClientCapability } from '../src/orchestration/authority.mjs';
import { deriveEndpoint, requestIpc } from '../src/orchestration/ipc.mjs';
import { resolveOrchestrationRoots } from '../src/orchestration/paths.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { ORCHESTRATION_PROTOCOL } from '../src/orchestration/constants.mjs';

const FIXTURES = new URL('./fixtures/orchestration/', import.meta.url).pathname;

const TEST_BASE = mkdtempSync(join(tmpdir(), 'r12g-'));
after(() => {
  try { rmSync(TEST_BASE, { recursive: true, force: true }); } catch { /* best effort */ }
});

function tempDir(name) {
  const dir = join(TEST_BASE, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let coordCounter = 0;

/* ---------------- unit-level honesty of the canonicalizer ------------- */

test('R12G: dangling symlinks and loops are refused — never treated as a missing tail', (t) => {
  const ws = tempDir('unit');
  // Real directory + genuinely missing tail: still fine (resolved through
  // platform-level symlinks such as macOS /var -> /private/var).
  const realWs = realpathSync(ws);
  assert.equal(canonicalizeExistingPrefix(join(ws, 'not-yet-made')), join(realWs, 'not-yet-made'));

  // DANGLING symlink: lstat sees it, realpath cannot resolve it → refuse.
  const dangling = join(ws, 'dangling');
  symlinkSync(join(ws, 'does-not-exist-target'), dangling);
  assert.throws(
    () => canonicalizeExistingPrefix(dangling),
    (e) => e.code === 'POLICY_DENIED' && /symlink/i.test(e.message),
    'a dangling symlink must not pass as a missing segment',
  );

  // Self-referencing loop: ELOOP family → refuse.
  const loop = join(ws, 'loop');
  symlinkSync(loop, loop);
  assert.throws(
    () => canonicalizeExistingPrefix(join(loop, 'deeper')),
    (e) => e.code === 'POLICY_DENIED' && /cannot be proven|resolve/i.test(e.message),
  );

  // A RESOLVABLE symlink still canonicalizes to its target.
  const real = tempDir('unit-real-target');
  const link = join(ws, 'alias');
  symlinkSync(real, link);
  assert.equal(canonicalizeExistingPrefix(link), realpathSync(real));
});

/* ---------------- harness --------------------------------------------- */

function ownedAdapterPair(t) {
  const stateDir = tempDir(`op-${(coordCounter += 1)}`);
  const inner = createOwnedProcessAdapter({ stateDir });
  const config = createTrustedCoordinatorConfig({
    stateDir,
    allowFixtureDispatch: true,
    confinement: 'disposable-workspace',
    disposableRoot: TEST_BASE,
    ownedProcessCommand: {
      command: process.execPath,
      args: [join(FIXTURES, 'fake-worker.mjs')],
      env: { ...process.env, FAKE_WORKER_MODE: 'ordered' },
    },
  });
  return { ...inner, lifecycle: createPublicLifecycle('owned-process', inner, config) };
}

async function startSupervisor(t, name, adapters, envObject = null) {
  const stateDir = tempDir(name);
  const coordinationId = `coord_r12g_${(coordCounter += 1)}`;
  const effectiveEnv = envObject ?? {};
  effectiveEnv.WEBMCP_AI_ORCHESTRATION_STATE_DIR = stateDir;
  const sup = await createSupervisor({
    env: effectiveEnv,
    mode: 'create',
    coordinationId,
    adapters,
    trustedCoordinatorConfig: createTrustedCoordinatorConfig({
      stateDir: TEST_BASE,
      allowFixtureDispatch: true,
      confinement: 'disposable-workspace',
      disposableRoot: TEST_BASE,
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
  return { sup, call };
}

test('R12G: task admission refuses a dangling-symlink write root before any dispatch state', async (t) => {
  const adapter = ownedAdapterPair(t);
  const workspace = tempDir('ws-admit');
  // A DANGLING alias cannot be proven: admission must refuse it outright.
  const badRoot = join(workspace, 'escape-root');
  symlinkSync(join(workspace, 'no-such-target'), badRoot);

  const { sup, call } = await startSupervisor(t, 'admit', [adapter]);
  const created = await call('task.create', {
    packet: {
      objective: 'x',
      workspace,
      allowedReadRoots: [],
      allowedWriteRoots: [badRoot],
    },
  });
  assert.equal(created.ok, false, JSON.stringify(created));
  assert.equal(created.error?.code, 'POLICY_DENIED', JSON.stringify(created.error ?? {}));
  void sup;
});

test('R12G: a workspace swapped to an external symlink AFTER checks fails the dispatch BEFORE spawn', async (t) => {
  const adapter = ownedAdapterPair(t);
  const workspace = tempDir('ws-swap');
  writeFileSync(join(workspace, 'marker.txt'), 'original\n');
  // TRUE escape: the mirror lives OUTSIDE the disposable root entirely.
  const external = mkdtempSync(join(tmpdir(), 'r12g-ext-'));
  t.after(() => { try { rmSync(external, { recursive: true, force: true }); } catch { } });

  const supEnv = { WEBMCP_AI_ORCHESTRATION_STATE_DIR: '' };
  const { sup, call } = await startSupervisor(t, 'preswap', [adapter], supEnv);

  let hookArmed = null;
  // Mutate the SAME env object the supervisor captured (no spread copy).
  Object.defineProperty(supEnv, 'WEBMCP_AI_TEST_PRESWAP_HOOK', {
    enumerable: true,
    configurable: true,
    get() { return hookArmed; },
  });

  // Arm the swap: it runs INSIDE the supervisor between the early checks and
  // the launch seam, swapping the WORKSPACE for an EXTERNAL mirror.
  hookArmed = async () => {
    const mirror = join(external, 'ws-mirror');
    mkdirSync(mirror, { recursive: true });
    writeFileSync(join(mirror, 'marker.txt'), 'external\n');
    const fsmod = await import('node:fs');
    const stashed = join(external, 'stash-ws');
    fsmod.renameSync(workspace, stashed);
    fsmod.cpSync(stashed, mirror, { recursive: true });
    fsmod.rmSync(stashed, { recursive: true, force: true });
    symlinkSync(mirror, workspace);
  };

  const taskId0 = await call('task.create', {
    packet: { objective: 'swap', workspace, allowedReadRoots: [], allowedWriteRoots: [] },
  });
  assert.equal(taskId0.ok, true, JSON.stringify(taskId0.error ?? {}));
  const started = await call('dispatch.start', { taskId: taskId0.result.taskId, adapterId: 'owned-process' });

  // The geometry changed after the early admission checks: the FINAL re-proof
  // must fail the dispatch before any worker can run.
  assert.equal(started.ok, false, `swapped geometry must fail closed (${JSON.stringify(started)})`);
  assert.match(started.error?.message ?? '', /disposable workspace|containment|symlink|proven/i);

  // No worker may have started for that dispatch.
  void started;
  hookArmed = null;
  void sup;
});

test('R12G: unchanged geometry still launches normally (re-proof is not a regression)', async (t) => {
  const adapter = ownedAdapterPair(t);
  const workspace = tempDir('ws-happy');
  const { sup, call } = await startSupervisor(t, 'happy', [adapter]);
  const created = await call('task.create', {
    packet: { objective: 'ok', workspace, allowedReadRoots: [], allowedWriteRoots: [] },
  });
  const started = await call('dispatch.start', { taskId: created.result.taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));
  await new Promise((r) => setTimeout(r, 400));
  const inspect = await call('coordination.inspect', {});
  assert.equal(inspect.result.dispatches[started.result.dispatchId].state, 'settled');
});
