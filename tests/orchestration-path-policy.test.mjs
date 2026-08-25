import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateTaskPacket } from '../src/orchestration/contracts.mjs';
import { canonicalizeWorkspacePath } from '../src/orchestration/verifier.mjs';

function tempRoot(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r10e-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function basePacket(overrides = {}) {
  return {
    objective: 'r10e path policy probe',
    workspace: '/tmp/r10e-ws',
    allowedReadRoots: [],
    allowedWriteRoots: [],
    ...overrides,
  };
}

test('R10E: a writable root INSIDE a protected path is refused at packet admission', () => {
  // Reverse direction of the classic check: the write root /ws/keep/nested
  // lives INSIDE the protected path /ws/keep.
  assert.throws(
    () => validateTaskPacket(basePacket({
      protectedPaths: ['/tmp/r10e-ws/keep'],
      allowedWriteRoots: ['/tmp/r10e-ws/keep/nested'],
    })),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT'
      && /protected paths may not overlap allowed write roots/.test(error.message),
    'a write root nested inside a protected path must be rejected',
  );
});

test('R10E: a protected path INSIDE a writable root is still refused (both directions)', () => {
  assert.throws(
    () => validateTaskPacket(basePacket({
      protectedPaths: ['/tmp/r10e-ws/keep/secret.txt'],
      allowedWriteRoots: ['/tmp/r10e-ws/keep'],
    })),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  // Identical paths overlap trivially.
  assert.throws(
    () => validateTaskPacket(basePacket({
      protectedPaths: ['/tmp/r10e-ws/same'],
      allowedWriteRoots: ['/tmp/r10e-ws/same'],
    })),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});

test('R10E: reverse-overlap refusal happens BEFORE any durable dispatch or launch', async (t) => {
  const stateDir = tempRoot(t, 'state');
  const coordinationId = `coord_r10e_${Date.now().toString(36)}`;
  const workspace = join(stateDir, 'ws');
  mkdirSync(workspace, { recursive: true });

  const { createOwnedProcessAdapter } = await import('../src/orchestration/adapters/owned-process.mjs');
  const inner = createOwnedProcessAdapter({ stateDir: join(stateDir, 'op') });
  let launches = 0;
  const countingInner = {
    ...inner,
    spawn: async (context) => {
      launches += 1;
      return inner.spawn(context);
    },
  };
  const { createPublicLifecycle, createTrustedCoordinatorConfig, asPublicAdapter } =
    await import('../src/orchestration/public-adapters.mjs');
  const config = createTrustedCoordinatorConfig({
    stateDir,
    allowFixtureDispatch: true,
    confinement: 'disposable-workspace',
    disposableRoot: tmpdir(),
    ownedProcessCommand: {
      command: process.execPath,
      args: [join(new URL('./fixtures/orchestration/', import.meta.url).pathname, 'fake-worker.mjs')],
      env: { ...process.env, FAKE_WORKER_MODE: 'ordered' },
    },
  });
  const adapter = asPublicAdapter(countingInner, createPublicLifecycle('owned-process', countingInner, config));

  const { createSupervisor } = await import('../src/orchestration/supervisor.mjs');
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

  // The CONTRADICTORY packet must be refused at task.create — before any
  // dispatch exists and long before any adapter launch/spawn.
  const refused = await call('task.create', {
    packet: {
      objective: 'must never launch',
      workspace,
      allowedReadRoots: [workspace],
      allowedWriteRoots: [join(workspace, 'keep', 'nested')],
      protectedPaths: [join(workspace, 'keep')],
    },
  });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.error?.code, 'ORCHESTRATION_INVALID_INPUT');

  assert.equal(Object.keys(sup.__store.state.dispatches).length, 0,
    'no durable dispatch may exist for a refused packet');
  const journalPath = join(roots.stateRoot, 'coordinations', coordinationId, 'events.jsonl');
  const journalText = await (await import('node:fs/promises')).readFile(journalPath, 'utf8');
  assert.equal(journalText.includes('dispatch_created'), false);
  assert.equal(launches, 0, 'the adapter launch counter must stay at zero');
}, { timeout: 60_000 });

test('R10E: canonicalization stops probing at the first missing segment and preserves lexical order', (t) => {
  const root = tempRoot(t, 'cano');
  // Only root/src exists; the candidate asks for root/new/src/file.
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'marker.txt'), 'x');

  const rootReal = realpathSync(root);
  const canonical = canonicalizeWorkspacePath(root, join(root, 'new', 'src', 'file'));
  assert.equal(canonical, join(rootReal, 'new', 'src', 'file'),
    `the missing tail must be appended verbatim in order, got ${canonical}`);
});

test('R10E: symlinked existing segments still fail closed; fresh tails stay legal', (t) => {
  const root = tempRoot(t, 'syml');
  mkdirSync(join(root, 'outside'), { recursive: true });
  mkdirSync(join(root, 'fresh'), { recursive: true });
  symlinkSync(join(root, 'outside'), join(root, 'link'));

  assert.throws(
    () => canonicalizeWorkspacePath(root, join(root, 'link', 'escape.txt')),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  const legal = canonicalizeWorkspacePath(root, join(root, 'fresh', 'nested', 'deep.txt'));
  assert.equal(legal, join(realpathSync(root), 'fresh', 'nested', 'deep.txt'));
});
