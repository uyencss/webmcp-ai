import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  createTrustedCoordinatorConfig,
  asPublicAdapter,
  createPublicLifecycle,
  loadTrustedCoordinatorConfigFile,
  loadTrustedAdapterRegistry,
} from '../src/orchestration/public-adapters.mjs';
import { readClientCapability } from '../src/orchestration/authority.mjs';
import { deriveEndpoint, requestIpc } from '../src/orchestration/ipc.mjs';
import { resolveOrchestrationRoots } from '../src/orchestration/paths.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { ORCHESTRATION_PROTOCOL } from '../src/orchestration/constants.mjs';

const FIXTURES = new URL('./fixtures/orchestration/', import.meta.url).pathname;

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r9d-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let coordCounter = 0;

async function startSupervisor(t, name, { adapter, trustedConfig }) {
  const stateDir = tempDir(t, name);
  const coordinationId = `coord_r9d_${(coordCounter += 1)}`;
  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'create',
    coordinationId,
    adapters: [adapter],
    trustedCoordinatorConfig: trustedConfig,
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

async function buildOwnedAdapter(stateDir, extraConfig = {}) {
  const { createOwnedProcessAdapter } = await import('../src/orchestration/adapters/owned-process.mjs');
  const inner = createOwnedProcessAdapter({ stateDir: join(stateDir, 'op') });
  const config = createTrustedCoordinatorConfig({
    stateDir,
    allowFixtureDispatch: true,
    ownedProcessCommand: {
      command: process.execPath,
      args: [join(FIXTURES, 'fake-worker.mjs')],
      env: { ...process.env, FAKE_WORKER_MODE: 'ordered' },
    },
    ...extraConfig,
  });
  return asPublicAdapter(inner, createPublicLifecycle('owned-process', inner, config));
}

test('R9D: workspace outside the disposable root is refused before launch', async (t) => {
  const scratch = tempDir(t, 'root');
  mkdirSync(join(scratch, 'inside'), { recursive: true });
  const outside = tempDir(t, 'outside');
  const adapter = await buildOwnedAdapter(join(scratch, 'state'));
  const { sup, call } = await startSupervisor(t, 'escape', {
    adapter,
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: scratch },
  });

  const created = await call('task.create', {
    packet: {
      objective: 'Escape',
      workspace: outside, // OUTSIDE the disposable root...
      allowedReadRoots: [],
      allowedWriteRoots: [join(scratch, 'inside', 'src')], // ...even though the write root is inside.
    },
  });
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  const started = await call('dispatch.start', { taskId: created.result.taskId, adapterId: 'owned-process' });

  assert.equal(started.ok, false, `escape must be refused: ${JSON.stringify(started)}`);
  assert.equal(started.error?.code, 'POLICY_DENIED');
  // Refusal happens BEFORE spawn: no dispatch evidence may exist.
  const dispatchCount = Object.keys(sup.__store.state.dispatches).length;
  assert.equal(dispatchCount, 0, 'a refused launch must not create a Dispatch');
});

test('R9D: empty write roots never mean read-only for an unproven mutable adapter', async (t) => {
  const adapter = await buildOwnedAdapter(tempDir(t, 'state2')); // no confinement configured at all
  const { sup, call } = await startSupervisor(t, 'emptyroots', { adapter, trustedConfig: { allowFixtureDispatch: true } });
  const created = await call('task.create', {
    packet: {
      objective: 'Read-only?',
      workspace: tempDir(t, 'ws2'),
      allowedReadRoots: [],
      allowedWriteRoots: [],
    },
  });
  const started = await call('dispatch.start', { taskId: created.result.taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, false, JSON.stringify(started));
  assert.equal(started.error?.code, 'POLICY_DENIED', 'unproven mutable adapters require preventive confinement');
  assert.equal(Object.keys(sup.__store.state.dispatches).length, 0);
});

test('R9D: a properly confined task launches and settles', async (t) => {
  const scratch = tempDir(t, 'ok-root');
  const ws = join(scratch, 'ws');
  mkdirSync(ws, { recursive: true });
  const adapter = await buildOwnedAdapter(join(scratch, 'state'));
  const { sup, call } = await startSupervisor(t, 'confined-ok', {
    adapter,
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: scratch },
  });
  const created = await call('task.create', {
    packet: {
      objective: 'Confined work',
      workspace: ws,
      allowedReadRoots: [],
      allowedWriteRoots: [join(ws, 'out')],
    },
  });
  const started = await call('dispatch.start', { taskId: created.result.taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rec = sup.__store.state.dispatches[started.result.dispatchId];
    if (rec?.state === 'settled') break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(sup.__store.state.dispatches[started.result.dispatchId].state, 'settled');
});

test('R9D: a symlinked workspace segment that escapes the root is refused', async (t) => {
  const scratch = tempDir(t, 'sym-root');
  const evilTarget = tempDir(t, 'evil');
  symlinkSync(evilTarget, join(scratch, 'link'));
  const adapter = await buildOwnedAdapter(join(scratch, 'state'));
  const { call } = await startSupervisor(t, 'sym', {
    adapter,
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: scratch },
  });
  const created = await call('task.create', {
    packet: {
      objective: 'Symlink escape',
      workspace: join(scratch, 'link', 'ws'),
      allowedReadRoots: [],
      allowedWriteRoots: [],
    },
  });
  const started = await call('dispatch.start', { taskId: created.result.taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, false, JSON.stringify(started));
  assert.equal(started.error?.code, 'POLICY_DENIED');
});

test('R9D: a not-yet-existing workspace tail inside the root is accepted', async (t) => {
  const scratch = tempDir(t, 'tail-root');
  const adapter = await buildOwnedAdapter(join(scratch, 'state'));
  const { sup, call } = await startSupervisor(t, 'tail', {
    adapter,
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: scratch },
  });
  const created = await call('task.create', {
    packet: {
      objective: 'Create me',
      workspace: join(scratch, 'fresh', 'nested'),
      allowedReadRoots: [],
      allowedWriteRoots: [],
    },
  });
  const started = await call('dispatch.start', { taskId: created.result.taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));
  void sup;
});

test('R9D: Task payloads can never carry command, argv or environment', async (t) => {
  const scratch = tempDir(t, 'payload-root');
  const adapter = await buildOwnedAdapter(join(scratch, 'state'));
  const { call } = await startSupervisor(t, 'payload', { adapter, trustedConfig: { allowFixtureDispatch: true } });
  for (const poison of [
    { command: '/bin/sh' },
    { argv: ['-c', 'id'] },
    { env: { LD_PRELOAD: '/evil.so' } },
    { executablePath: '/bin/sh' },
  ]) {
    const bad = await call('task.create', {
      packet: { objective: 'Poison', workspace: '/tmp/x', allowedReadRoots: [], allowedWriteRoots: [], ...poison },
    });
    assert.equal(bad.ok, false, `packet field ${Object.keys(poison)[0]} must be rejected`);
    assert.equal(bad.error?.code, 'ORCHESTRATION_INVALID_INPUT');
  }
});

test('R9D: trusted adapter registry files are mode-0600 validated and allowlisted', async (t) => {
  const dir = tempDir(t, 'registry');

  const valid = {
    schema: 'webmcp.ai-trusted-adapters/v1',
    adapters: [{
      id: 'owned-process',
      executable: process.execPath,
      args: ['--experimental-default-type=module', '/tmp/worker.mjs'],
      env: { PATH: process.env.PATH ?? '' },
    }],
  };
  const validPath = join(dir, 'adapters.json');
  writeFileSync(validPath, `${JSON.stringify(valid)}\n`, { mode: 0o600 });
  chmodSync(validPath, 0o600);
  const loaded = loadTrustedAdapterRegistry(validPath);
  assert.equal(loaded.adapters.length, 1);
  assert.equal(loaded.adapters[0].command, process.execPath);

  // World-readable registry is refused.
  writeFileSync(join(dir, 'loose.json'), `${JSON.stringify(valid)}\n`, { mode: 0o644 });
  assert.throws(() => loadTrustedAdapterRegistry(join(dir, 'loose.json')), (error) => error.code === 'POLICY_DENIED');

  // Forbidden environment keys fail closed.
  const poisoned = {
    schema: 'webmcp.ai-trusted-adapters/v1',
    adapters: [{ id: 'owned-process', executable: process.execPath, args: [], env: { LD_PRELOAD: '/evil' } }],
  };
  const poisonedPath = join(dir, 'poison.json');
  writeFileSync(poisonedPath, `${JSON.stringify(poisoned)}\n`, { mode: 0o600 });
  assert.throws(() => loadTrustedAdapterRegistry(poisonedPath), (error) => error.code === 'POLICY_DENIED');

  // Relative executables are refused.
  const relative = {
    schema: 'webmcp.ai-trusted-adapters/v1',
    adapters: [{ id: 'owned-process', executable: 'node', args: [], env: {} }],
  };
  const relPath = join(dir, 'relative.json');
  writeFileSync(relPath, `${JSON.stringify(relative)}\n`, { mode: 0o600 });
  assert.throws(() => loadTrustedAdapterRegistry(relPath), (error) => error.code === 'ORCHESTRATION_INVALID_INPUT');
});

test('R9D: coordinator config files cannot grant fixture or bypass opt-ins', async (t) => {
  const dir = tempDir(t, 'cfg');
  const legit = {
    schema: 'webmcp.ai-trusted-coordinator-config/v1',
    confinement: 'disposable-workspace',
    disposableRoot: tmpdir(),
    stateDir: join(dir, 'state'),
  };
  const okPath = join(dir, 'config.json');
  writeFileSync(okPath, `${JSON.stringify(legit)}\n`, { mode: 0o600 });
  const loaded = loadTrustedCoordinatorConfigFile(okPath);
  assert.equal(loaded.confinement, 'disposable-workspace');
  assert.equal(loaded.disposableRoot, tmpdir());
  assert.equal(loaded.allowFixtureDispatch, false, 'files can never grant fixture opt-in');

  const sneaky = { ...legit, allowFixtureDispatch: true };
  const sneakyPath = join(dir, 'sneaky.json');
  writeFileSync(sneakyPath, `${JSON.stringify(sneaky)}\n`, { mode: 0o600 });
  assert.throws(() => loadTrustedCoordinatorConfigFile(sneakyPath), (error) => error.code === 'POLICY_DENIED');

  const bypass = { ...legit, allowUnprovenProviderDispatch: true };
  const bypassPath = join(dir, 'bypass.json');
  writeFileSync(bypassPath, `${JSON.stringify(bypass)}\n`, { mode: 0o600 });
  assert.throws(() => loadTrustedCoordinatorConfigFile(bypassPath), (error) => error.code === 'POLICY_DENIED');

  const loosePath = join(dir, 'loose.json');
  writeFileSync(loosePath, `${JSON.stringify(legit)}\n`, { mode: 0o666 });
  assert.throws(() => loadTrustedCoordinatorConfigFile(loosePath), (error) => error.code === 'POLICY_DENIED');
});
