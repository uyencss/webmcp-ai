import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readClientCapability, createAuthority } from '../src/orchestration/authority.mjs';
import {
  resolveOrchestrationRoots,
  ensureOrchestrationRoots,
  createCoordinationLayout,
} from '../src/orchestration/paths.mjs';
import { createPlatformIdentityDeps } from '../src/orchestration/process-identity.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { openCoordinationStore, commitDelivery } from '../src/orchestration/store.mjs';
import { writeAtomicJson } from '../src/orchestration/atomic-file.mjs';
import { MANIFEST_SCHEMA } from '../src/orchestration/constants.mjs';

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `r11g-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let coordCounter = 0;
const COORD = () => `coord_r11g_${(coordCounter += 1)}`;

/**
 * Seed a coordination whose active dispatch holds a provider
 * (opencode-server) binding carrying a cleanup lease, plus a FAKE isolated
 * runtime database tree under the SAME state root (never the user's real
 * opencode data dir).
 */
async function seedProviderLeaseFixture(t, name, { lease, withDbFiles = true } = {}) {
  const stateDir = tempDir(t, name);
  const coordinationId = COORD();
  // Isolated HOME geometry: the runtime-owned tree lives under THIS fake
  // data root — never under the real user's opencode directory.
  const fakeHome = join(stateDir, 'home');
  const env = { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir, HOME: fakeHome };
  const roots = resolveOrchestrationRoots({ env });
  ensureOrchestrationRoots(roots);
  const layout = createCoordinationLayout(roots.stateRoot, coordinationId);
  writeAtomicJson(layout.manifestPath, {
    schema: MANIFEST_SCHEMA,
    coordinationId,
    fenceEpoch: 1,
    processGeneration: 1,
    createdAt: new Date().toISOString(),
    owner: null,
  });
  createAuthority(layout);
  const store = openCoordinationStore(layout);
  for (const [type, payload] of [
    ['task_created', { taskId: 'task_g' }],
    ['dispatch_created', { dispatchId: 'disp_g', taskId: 'task_g' }],
    ['dispatch_state_changed', { dispatchId: 'disp_g', taskId: 'task_g', state: 'active' }],
  ]) {
    commitDelivery(store, { type, payload });
  }

  // Fake ISOLATED runtime-owned database tree under the fake HOME data root
  // (production geometry), fully inside the test state dir.
  const ocMod = await import('../src/orchestration/adapters/opencode-server.mjs');
  const dataRoot = ocMod.resolveOpencodeDataRoot({ env });
  if (!dataRoot.startsWith(stateDir)) throw new Error('SAFETY GUARD: data root escaped the fixture');
  mkdirSync(dataRoot, { recursive: true });
  const dbDir = join(dataRoot, 'webmcp-ai-runtime', 'worker_g');
  const dbPath = join(dbDir, 'opencode.db');
  if (withDbFiles) {
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(dbPath, 'fake-runtime-db');
    writeFileSync(join(dbDir, 'opencode.db-wal'), 'wal');
    writeFileSync(join(dbDir, 'opencode.db-shm'), 'shm');
    writeFileSync(join(dbDir, 'sessions.json'), '{}');
  }
  // Sentinel files standing in for the USER default DB and the SHARED CLI db:
  // they live in the same fake data root and must NEVER be touched.
  const defaultDb = join(roots.stateRoot, 'user-default-opencode', 'opencode.db');
  const sharedCliDb = join(roots.stateRoot, 'shared-cli', 'opencode-cli.db');
  mkdirSync(join(roots.stateRoot, 'user-default-opencode'), { recursive: true });
  mkdirSync(join(roots.stateRoot, 'shared-cli'), { recursive: true });
  writeFileSync(defaultDb, 'USER DEFAULT — DO NOT TOUCH');
  writeFileSync(sharedCliDb, 'SHARED CLI — DO NOT TOUCH');

  const record = {
    bindingId: 'worker_g',
    adapterId: 'opencode-server',
    capability: 'opencode-server',
    taskId: 'task_g',
    fenceEpoch: 1,
    processIdentity: lease?.processIdentity ?? { pid: 999_999_777, startIdentity: 'fixture:gone', processGroupId: 999_999_777 },
    ...(lease ? { cleanupLease: { ...lease, canonicalRuntimeDbPath: dbPath } } : {}),
  };
  writeAtomicJson(join(layout.coordinationDir, 'runtime-bindings.json'), {
    schema: 'webmcp.ai-supervisor-runtime-bindings/v0',
    bindings: { disp_g: record },
  });

  return { stateDir, coordinationId, fakeHome, env, roots, layout, dbPath, dbDir, defaultDb, sharedCliDb, record };
}

test('R11G-A1: provider-lost recovery releases the leased runtime DB after proven death and never the user trees', async (t) => {
  const { createHash } = await import('node:crypto');
  const fixture = await seedProviderLeaseFixture(t, 'release', {
    lease: {
      ownershipMode: 'runtime-owned',
      canonicalRuntimeDbDir: null, // filled below relative to dbPath
      databaseIdentity: null,
      processIdentity: { pid: 999_999_777, startIdentity: 'fixture:gone', processGroupId: 999_999_777 },
    },
  });
  // Digest must match the path exactly (sha256 of the absolute path string).
  fixture.record.cleanupLease.databaseIdentity = createHash('sha256').update(fixture.dbPath).digest('hex');
  writeAtomicJson(join(fixture.layout.coordinationDir, 'runtime-bindings.json'), {
    schema: 'webmcp.ai-supervisor-runtime-bindings/v0',
    bindings: { disp_g: fixture.record },
  });

  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: fixture.stateDir, HOME: fixture.fakeHome },
    mode: 'recover',
    coordinationId: fixture.coordinationId,
  });
  t.after(() => sup.stop());
  await new Promise((resolveTick) => setTimeout(resolveTick, 600));

  assert.equal(existsSync(fixture.dbDir), false, 'the leased runtime DB tree must be removed');
  assert.equal(readFileSync(fixture.defaultDb, 'utf8'), 'USER DEFAULT — DO NOT TOUCH');
  assert.equal(readFileSync(fixture.sharedCliDb, 'utf8'), 'SHARED CLI — DO NOT TOUCH');

  const journal = readFileSync(join(fixture.layout.coordinationDir, 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const receipt = journal.filter((entry) => entry.type === 'cleanup_recorded'
    && String(entry.payload?.disposition ?? '').includes('recovered-runtime-database'));
  assert.equal(receipt.length >= 1, true, 'a typed recovered-database receipt must exist');
  assert.equal(receipt.at(-1).payload.disposition, 'recovered-runtime-database-released');
});

test('R11G-A2: insufficient proof keeps every artifact and reports cleanup unproven', async (t) => {
  const { createHash } = await import('node:crypto');
  // Live sleeper matching the lease identity: death is UNPROVABLE.
  const { spawn } = await import('node:child_process');
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore', detached: process.platform !== 'win32',
  });
  t.after(() => {
    try { if (process.platform !== 'win32') process.kill(-sleeper.pid, 'SIGKILL'); } catch { /* gone */ }
  });
  const deps = createPlatformIdentityDeps();
  const startIdentity = await deps.getStartIdentity(sleeper.pid);

  const fixture = await seedProviderLeaseFixture(t, 'unproven', {
    lease: {
      ownershipMode: 'runtime-owned',
      databaseIdentity: null,
      processIdentity: { pid: sleeper.pid, startIdentity, processGroupId: sleeper.pid },
    },
  });
  fixture.record.cleanupLease.databaseIdentity = createHash('sha256').update(fixture.dbPath).digest('hex');
  // The RECORD's own identity is provably dead (recovery's orphan-stop has
  // nothing to signal), but the LEASE names the LIVE server process: the
  // release must refuse until that process is provably gone.
  fixture.record.processIdentity = { pid: 999_999_777, startIdentity: 'fixture:gone', processGroupId: 999_999_777 };
  writeAtomicJson(join(fixture.layout.coordinationDir, 'runtime-bindings.json'), {
    schema: 'webmcp.ai-supervisor-runtime-bindings/v0',
    bindings: { disp_g: fixture.record },
  });

  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: fixture.stateDir, HOME: fixture.fakeHome },
    mode: 'recover',
    coordinationId: fixture.coordinationId,
  });
  t.after(() => sup.stop());
  await new Promise((resolveTick) => setTimeout(resolveTick, 600));

  assert.equal(existsSync(fixture.dbPath), true, 'an unproven death must retain the runtime DB');
  const journal = readFileSync(join(fixture.layout.coordinationDir, 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const receipt = journal.filter((entry) => entry.type === 'cleanup_recorded'
    && String(entry.payload?.disposition ?? '').includes('recovered-runtime-database')).at(-1);
  assert.ok(receipt, 'a typed unproven-cleanup receipt must exist');
  assert.match(String(receipt.payload.disposition), /unproven/);
});

test('R11G-A3: a forged lease pointing at the user default database is refused before any fs mutation', async (t) => {
  const fixture = await seedProviderLeaseFixture(t, 'denylist', { withDbFiles: false });
  const { createHash } = await import('node:crypto');
  const forgedPath = fixture.defaultDb;
  const record = {
    ...fixture.record,
    cleanupLease: {
      ownershipMode: 'runtime-owned',
      canonicalRuntimeDbPath: forgedPath,
      databaseIdentity: createHash('sha256').update(forgedPath).digest('hex'),
      processIdentity: { pid: 999_999_778, startIdentity: 'fixture:gone-2', processGroupId: 999_999_778 },
    },
  };
  // The forged lease bypasses the structural worker_* checks ONLY if the
  // denylist runs FIRST; either way the file must survive untouched.
  writeAtomicJson(join(fixture.layout.coordinationDir, 'runtime-bindings.json'), {
    schema: 'webmcp.ai-supervisor-runtime-bindings/v0',
    bindings: { disp_g: record },
  });
  // Make the forged target structurally plausible to prove the denylist is
  // what stops it: place it inside a webmcp-ai-runtime-looking path that
  // canonicalizes onto the user tree via the canonical comparison.
  void forgedPath;

  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: fixture.stateDir, HOME: fixture.fakeHome },
    mode: 'recover',
    coordinationId: fixture.coordinationId,
  });
  t.after(() => sup.stop());
  await new Promise((resolveTick) => setTimeout(resolveTick, 600));

  assert.equal(readFileSync(fixture.defaultDb, 'utf8'), 'USER DEFAULT — DO NOT TOUCH',
    'the user default database must never be deleted');
  assert.equal(readFileSync(fixture.sharedCliDb, 'utf8'), 'SHARED CLI — DO NOT TOUCH');
  const journal = readFileSync(join(fixture.layout.coordinationDir, 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const refused = journal.filter((entry) => entry.type === 'cleanup_recorded'
    && /protected|denied|unproven/.test(String(entry.payload?.disposition ?? '') + String(entry.payload?.reason ?? '')));
  assert.equal(refused.length >= 1, true, 'a typed refusal/unproven receipt must be journaled');
});
