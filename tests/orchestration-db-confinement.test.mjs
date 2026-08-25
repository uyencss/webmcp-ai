import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';

const ocModule = await import('../src/orchestration/adapters/opencode-server.mjs');
const {
  createOpenCodeServerAdapter,
  prepareRuntimeDatabase,
  releaseRecoveredRuntimeDatabase,
  resolveOpencodeDataRoot,
} = ocModule;

// One SHARED short-lived base keeps derived paths short and disposable.
const TEST_BASE = mkdtempSync(join(tmpdir(), 'r12d-'));
after(() => {
  try { rmSync(TEST_BASE, { recursive: true, force: true }); } catch { /* best effort */ }
});

function tempDir(name) {
  const dir = join(TEST_BASE, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Platform-correct isolated "HOME" geometry: every runtime tree lives under
 * <TEST_BASE>/home-N/<platform layout>. Nothing here ever touches the real
 * user database or the shared CLI database.
 */
function makeHomeGeometry(index) {
  const home = tempDir(`home-${index}`);
  const env = { HOME: home };
  // NOTE: the resolver reads the explicit homeDir parameter (never ambient
  // HOME), so this stays entirely inside TEST_BASE.
  const dataRoot = resolveOpencodeDataRoot({ homeDir: home });
  if (!dataRoot.startsWith(TEST_BASE)) {
    throw new Error('SAFETY GUARD: computed data root escaped the isolated test base');
  }
  return { home, env, dataRoot };
}

async function anExitedProcessPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise((resolveExit) => child.once('exit', resolveExit));
  return child.pid;
}

test('R12D: stopServer refuses an ANCESTOR symlink escape and preserves the external sentinel', async () => {
  const { env, dataRoot } = makeHomeGeometry(1);
  const prepared = prepareRuntimeDatabase({ dataRoot, bindingId: 'worker_conf1' });
  // A known sidecar so enumeration would otherwise authorize deletion.
  writeFileSync(join(prepared.dbDir, 'sessions.json'), '{}\n');

  const external = tempDir('external-1');
  const sentinel = join(external, 'sentinel.txt');
  writeFileSync(sentinel, 'DO-NOT-DELETE\n');

  // Swap the webmcp-ai-runtime ancestor itself for a symlink pointing at an
  // EXTERNAL mirror that physically contains this binding's tree now.
  const runtimeAncestor = dirname(prepared.dbDir);
  const externalMirror = join(external, 'mirror', 'webmcp-ai-runtime');
  mkdirSync(dirname(externalMirror), { recursive: true });
  const renamed = join(tempDir('stash-1'), 'webmcp-ai-runtime');
  mkdirSync(dirname(renamed), { recursive: true });
  const fsmod = await import('node:fs');
  fsmod.renameSync(runtimeAncestor, renamed);
  fsmod.cpSync(renamed, externalMirror, { recursive: true });
  fsmod.rmSync(renamed, { recursive: true, force: true });
  symlinkSync(externalMirror, runtimeAncestor);

  assert.equal(existsSync(join(externalMirror, 'worker_conf1', 'opencode.db')), true,
    'setup: the physical db must live OUTSIDE the lexical runtime root now');

  const adapter = createOpenCodeServerAdapter({
    stateDir: tempDir('state-1'),
    openCodeBin: process.execPath,
    openCodeArgs: ['-e', ''],
    env,
  });
  await assert.rejects(    () => adapter.stopServer(
      { dbPath: prepared.dbPath, databaseIdentity: prepared.databaseIdentity, __serverChild: null },
      { release: true, settled: true },
    ),
    (error) => error.code === 'POLICY_DENIED' && /symlink|containment/i.test(error.message),
    'cleanup must fail closed when any ancestor is a symlink',
  );

  assert.equal(existsSync(sentinel), true, 'the external sentinel must be untouched');
  assert.equal(existsSync(join(externalMirror, 'worker_conf1', 'opencode.db')), true,
    'the physically external database must be retained');
});

test('R12D: recovered DB release refuses the same ancestor escape and keeps the lease usable', async () => {
  const { env, dataRoot } = makeHomeGeometry(2);
  const prepared = prepareRuntimeDatabase({ dataRoot, bindingId: 'worker_conf2' });
  writeFileSync(join(prepared.dbDir, 'sessions.json'), '{}\n');

  const external = tempDir('external-2');
  const sentinel = join(external, 'sentinel.txt');
  writeFileSync(sentinel, 'KEEP ME\n');

  const runtimeAncestor = dirname(prepared.dbDir);
  const externalMirror = join(external, 'mirror', 'webmcp-ai-runtime');
  mkdirSync(dirname(externalMirror), { recursive: true });
  const fsmod = await import('node:fs');
  const stash = join(tempDir('stash-2'), 'wrt');
  fsmod.renameSync(runtimeAncestor, stash);
  fsmod.cpSync(stash, externalMirror, { recursive: true });
  fsmod.rmSync(stash, { recursive: true, force: true });
  symlinkSync(externalMirror, runtimeAncestor);

  const deadPid = await anExitedProcessPid();
  const record = {
    cleanupLease: {
      ownershipMode: 'runtime-owned',
      canonicalRuntimeDbPath: prepared.dbPath,
      canonicalRuntimeDbDir: dirname(prepared.dbPath),
      databaseIdentity: prepared.databaseIdentity,
      processIdentity: { pid: deadPid, processGroupId: deadPid },
    },
  };

  const outcome = await releaseRecoveredRuntimeDatabase(record, { env });
  assert.equal(outcome.released, false, 'an escaped ancestor must never release');
  assert.equal(outcome.retained, true);
  assert.match(String(outcome.reason ?? ''), /symlink|ancestor|containment/i);

  assert.equal(existsSync(sentinel), true, 'external sentinel survives');
  assert.equal(existsSync(join(externalMirror, 'worker_conf2', 'opencode.db')), true,
    'external database retained behind the refused cleanup');
});

test('R12D: a fully physical tree still releases cleanly (happy path preserved)', async () => {
  const { env, dataRoot } = makeHomeGeometry(3);
  const prepared = prepareRuntimeDatabase({ dataRoot, bindingId: 'worker_ok3' });
  writeFileSync(join(prepared.dbDir, 'sessions.json'), '{}\n');

  const adapter = createOpenCodeServerAdapter({
    stateDir: tempDir('state-3'),
    openCodeBin: process.execPath,
    openCodeArgs: ['-e', ''],
    env,
  });
  const receipt = await adapter.stopServer(
    { dbPath: prepared.dbPath, databaseIdentity: prepared.databaseIdentity, __serverChild: null },
    { release: true, settled: true },
  );
  assert.equal(receipt.released, true);
  assert.equal(receipt.absenceProven, true);
  assert.equal(existsSync(prepared.dbDir), false);
});
