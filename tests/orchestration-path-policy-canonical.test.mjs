import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicalizeExistingPrefix } from '../src/orchestration/verifier.mjs';

function tempRoot(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `r11d-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let coordCounter = 0;
const COORD = () => `coord_r11d_${(coordCounter += 1)}`;

async function startSupervisorWithCountingAdapter(t, stateDir) {
  const { createOwnedProcessAdapter } = await import('../src/orchestration/adapters/owned-process.mjs');
  const inner = createOwnedProcessAdapter({ stateDir: join(stateDir, 'op') });
  const countingInner = {
    ...inner,
    spawn: async (context) => {
      countingInner.launches += 1;
      return inner.spawn(context);
    },
  };
  countingInner.launches = 0;
  const { createPublicLifecycle, createTrustedCoordinatorConfig, asPublicAdapter } =
    await import('../src/orchestration/public-adapters.mjs');
  const config = createTrustedCoordinatorConfig({
    stateDir,
    allowFixtureDispatch: true,
    confinement: 'disposable-workspace',
    disposableRoot: tmpdir(),
    ownedProcessCommand: {
      command: process.execPath,
      args: ['-e', ''],
      env: {},
    },
  });
  const adapter = asPublicAdapter(countingInner, createPublicLifecycle('owned-process', countingInner, config));

  const { createSupervisor } = await import('../src/orchestration/supervisor.mjs');
  const coordinationId = COORD();
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
  t.after(() => sup.stop());

  const { readClientCapability } = await import('../src/orchestration/authority.mjs');
  const { deriveEndpoint, requestIpc } = await import('../src/orchestration/ipc.mjs');
  const { resolveOrchestrationRoots } = await import('../src/orchestration/paths.mjs');
  const { ORCHESTRATION_PROTOCOL } = await import('../src/orchestration/constants.mjs');
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
  return { sup, call, adapter: countingInner, roots, coordinationId };
}

test('R11D-1: alias-equality between protected and writable roots is refused at admission', async (t) => {
  const stateDir = tempRoot(t, 'alias');
  const workspace = join(stateDir, 'ws');
  mkdirSync(join(workspace, 'keep'), { recursive: true });
  symlinkSync(join(workspace, 'keep'), join(workspace, 'alias'));

  const { sup, call, adapter } = await startSupervisorWithCountingAdapter(t, stateDir);

  // protected = REAL location, writable = SYMLINK alias resolving onto it.
  const refused = await call('task.create', {
    packet: {
      objective: 'must never launch through an alias',
      workspace,
      allowedReadRoots: [],
      allowedWriteRoots: [join(workspace, 'alias')],
      protectedPaths: [join(workspace, 'keep')],
    },
  });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.error?.code, 'POLICY_DENIED',
    'canonical overlap is a policy refusal, not a shape error');

  // Mirror direction: protected spelled as the alias, write root as the
  // real location, must refuse identically.
  const refusedMirror = await call('task.create', {
    packet: {
      objective: 'mirror alias refusal',
      workspace,
      allowedReadRoots: [],
      allowedWriteRoots: [join(workspace, 'keep')],
      protectedPaths: [join(workspace, 'alias')],
    },
  });
  assert.equal(refusedMirror.ok, false);

  assert.equal(Object.keys(sup.__store.state.dispatches).length, 0);
  assert.equal(adapter.launches, 0, 'no launch may ever happen for aliased overlap');
});

test('R11D-2: symlink substitution AFTER task creation is caught again before launch', async (t) => {
  const stateDir = tempRoot(t, 'swap');
  const workspace = join(stateDir, 'ws');
  mkdirSync(join(workspace, 'out'), { recursive: true });
  mkdirSync(join(workspace, 'secret'), { recursive: true });

  const { sup, call, adapter, roots, coordinationId } = await startSupervisorWithCountingAdapter(t, stateDir);

  const created = await call('task.create', {
    packet: {
      objective: 'honest packet, later sabotaged',
      workspace,
      allowedReadRoots: [],
      allowedWriteRoots: [join(workspace, 'out')],
      protectedPaths: [join(workspace, 'secret')],
    },
  });
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));

  // TOCTOU sabotage: swap the now-existing write root for a symlink that
  // resolves INTO the protected tree.
  rmSync(join(workspace, 'out'), { recursive: true, force: true });
  symlinkSync(join(workspace, 'secret'), join(workspace, 'out'));

  const started = await call('dispatch.start', { taskId: created.result.taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, false, 'pre-launch re-check must catch the substitution');
  assert.equal(started.error?.code, 'POLICY_DENIED');

  assert.equal(Object.keys(sup.__store.state.dispatches).length, 0,
    'refusal must precede any durable dispatch record');
  const journalText = await (await import('node:fs/promises')).readFile(
    join(roots.stateRoot, 'coordinations', coordinationId, 'events.jsonl'), 'utf8');
  assert.equal(journalText.includes('dispatch_created'), false);
  assert.equal(adapter.launches, 0);
});

test('R11D-3: missing-tail ordering preserved; disjoint missing tails stay admissible', async (t) => {
  const stateDir = tempRoot(t, 'tail');
  const rootReal = realpathSync(stateDir);
  mkdirSync(join(stateDir, 'src'), { recursive: true });

  const canonical = canonicalizeExistingPrefix(join(stateDir, 'new', 'src', 'file'));
  assert.equal(canonical, join(rootReal, 'new', 'src', 'file'),
    'missing tail must stay lexical and ordered');

  const { sup, call } = await startSupervisorWithCountingAdapter(t, tempRoot(t, 'tailws'));
  const workspace = join(tempRoot(t, 'tailws2'), 'ws');
  mkdirSync(workspace, { recursive: true });
  const admitted = await call('task.create', {
    packet: {
      objective: 'disjoint missing tails remain legal',
      workspace,
      allowedReadRoots: [],
      allowedWriteRoots: [join(workspace, 'fresh', 'nested')],
      protectedPaths: [join(workspace, 'guard')],
    },
  });
  assert.equal(admitted.ok, true, JSON.stringify(admitted.error ?? {}));
  void sup;
});
