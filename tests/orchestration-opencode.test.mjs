import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createEventDeduper,
  normalizeOpenCodeEvent,
} from '../src/orchestration/adapters/opencode-events.mjs';
import {
  buildIsolatedEnv,
  createOpenCodeServerAdapter,
  prepareRuntimeDatabase,
  resolveOpencodeDataRoot,
} from '../src/orchestration/adapters/opencode-server.mjs';
import {
  createOpenCodeDiagnosticAdapter,
  resolveOperatorDiagnosticDb,
} from '../src/orchestration/adapters/opencode-diagnostic.mjs';

const fakeOpenCode = fileURLToPath(new URL('./fixtures/orchestration/fake-opencode-server.mjs', import.meta.url));
const streamFixture = fileURLToPath(new URL('./fixtures/orchestration/streams/opencode.ndjson', import.meta.url));

function tempDir(t, name = 'oc') {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-t6-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const binding = { sessionId: 'ses_fixture', bindingId: 'worker_fixture' };

test('event normalization filters foreign sessions, dedups, and drops reasoning', () => {
  const lines = readFileSync(streamFixture, 'utf8').split('\n').filter(Boolean);
  const events = lines.map((line) => JSON.parse(line));
  const deduper = createEventDeduper();

  const normalized = [];
  for (const event of events) {
    const mapped = normalizeOpenCodeEvent(event, binding, deduper);
    if (mapped) normalized.push(mapped);
  }

  const serialized = JSON.stringify(normalized);
  // Foreign sessions never cross the binding boundary.
  assert.equal(serialized.includes('another session'), false);
  // Reasoning is dropped entirely, not masked.
  assert.equal(serialized.includes('chain of thought'), false);
  // Raw completed tool output is bounded away from Deliveries.
  assert.equal(normalized.some((entry) => String(entry.summary ?? '').includes('huge tool payload')), false);

  const types = normalized.map((entry) => entry.deliveryType ?? entry.kind);
  assert.equal(types.includes('permission_requested'), true);
  assert.equal(types.includes('permission_resolved'), true);
  assert.equal(types.includes('escalation'), true);

  const fileEdited = normalized.find((entry) => entry.kind === 'file_edited');
  assert.ok(fileEdited, 'file.edited summarized');
  assert.match(fileEdited.summary, /\/ws\/src\/a\.ts/);

  const diff = normalized.find((entry) => entry.kind === 'diff_summary');
  assert.ok(diff, 'session.diff summarized');
  assert.match(diff.summary, /12/);

  const idle = normalized.find((entry) => entry.kind === 'session_status_idle');
  assert.ok(idle, 'idle is surfaced as terminal evidence only');

  const retried = normalized.filter((entry) => entry.kind === 'retry');
  assert.equal(retried.length >= 1, true);

  // Deterministic dedup: replaying the same events through the same deduper
  // yields nothing new.
  const replayed = [];
  for (const event of events) {
    const mapped = normalizeOpenCodeEvent(event, binding, deduper);
    if (mapped) replayed.push(mapped);
  }
  assert.equal(replayed.length, 0, 'duplicate provider events dedup by stable identity');
});

test('runtime databases are per-binding, platform-rooted and symlink-rejected', (t) => {
  const dataRoot = tempDir(t, 'data');
  const first = prepareRuntimeDatabase({ dataRoot, bindingId: 'worker_a' });
  const second = prepareRuntimeDatabase({ dataRoot, bindingId: 'worker_b' });

  assert.notEqual(first.dbPath, second.dbPath, 'two concurrent bindings own two databases');
  assert.match(first.dbPath, /webmcp-ai-runtime[\\/]worker_a[\\/]opencode\.db$/);
  assert.equal(statSync(first.dbDir).mode & 0o777, 0o700);
  assert.equal(
    first.dbPath.includes(join('opencode-cli.db')) || first.dbPath.endsWith('opencode-cli.db'),
    false,
    'runtime-owned databases never reuse the shared CLI namespace',
  );
  assert.equal(first.dbPath.endsWith(join('opencode', 'opencode.db')), false, 'never the user-owned default db');

  // A symlinked binding directory is refused before any write.
  const outside = tempDir(t, 'outside');
  mkdirSync(join(dataRoot, 'webmcp-ai-runtime'), { recursive: true });
  symlinkSync(outside, join(dataRoot, 'webmcp-ai-runtime', 'worker_evil'), 'dir');
  assert.throws(
    () => prepareRuntimeDatabase({ dataRoot, bindingId: 'worker_evil' }),
    (error) => error.code === 'POLICY_DENIED',
  );

  // Platform roots stay machine-local without hardcoding ~/.local/share.
  assert.equal(
    resolveOpencodeDataRoot({ env: {}, platform: 'darwin', homeDir: '/Users/u' }),
    '/Users/u/Library/Application Support/opencode',
  );
  assert.equal(
    resolveOpencodeDataRoot({ env: { XDG_DATA_HOME: '/xdg' }, platform: 'linux', homeDir: '/home/u' }),
    '/xdg/opencode',
  );
  assert.equal(
    resolveOpencodeDataRoot({ env: {}, platform: 'linux', homeDir: '/home/u' }),
    '/home/u/.local/share/opencode',
  );
  assert.equal(
    resolveOpencodeDataRoot({ env: { LOCALAPPDATA: '/ld' }, platform: 'win32', homeDir: '/home/u' }),
    join('/ld', 'opencode'),
  );
});

test('isolated launch environments pin the exact db and keep HOME untouched', (t) => {
  const dispatchPrivate = tempDir(t, 'dispatch');
  const dbPath = join(tempDir(t, 'dbs'), 'webmcp-ai-runtime', 'worker_x', 'opencode.db');
  const callerHome = '/Users/caller';
  const env = buildIsolatedEnv({
    dbPath,
    dispatchPrivateDir: dispatchPrivate,
    password: 'pw-secret',
    baseEnv: { HOME: callerHome, XDG_DATA_HOME: '/caller-xdg', PATH: process.env.PATH },
  });

  assert.equal(env.OPENCODE_DB, dbPath);
  assert.equal(env.HOME, callerHome, 'HOME is never replaced');
  assert.equal(env.XDG_DATA_HOME, '/caller-xdg', 'XDG_DATA_HOME is never replaced');
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  assert.equal(env.OPENCODE_PURE, '1');
  assert.equal(env.OPENCODE_DISABLE_DEFAULT_PLUGINS, '1');
  assert.equal(env.OPENCODE_SERVER_PASSWORD, 'pw-secret');
  assert.equal(env.XDG_CONFIG_HOME, join(dispatchPrivate, 'xdg-config'));
  assert.equal(env.OPENCODE_CONFIG, join(dispatchPrivate, 'opencode.json'));
  assert.equal(env.OPENCODE_CONFIG_DIR, join(dispatchPrivate, 'opencode.d'));
  const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(content.share, 'disabled');
  assert.deepEqual(content.plugin, []);
});

test('the runtime-owned server launches with its own db and basic auth', async (t) => {
  const stateDir = tempDir(t, 'srv');
  const workspace = tempDir(t, 'ws');
  // Hostile ambient project config must be neither loaded nor touched.
  const sentinel = join(workspace, '.opencode', 'plugin', 'hostile.js');
  mkdirSync(join(workspace, '.opencode', 'plugin'), { recursive: true });
  writeFileSync(sentinel, '// hostile ambient plugin\n');
  const beforeSentinel = readFileSync(sentinel, 'utf8');

  const adapter = createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
    streamFile: streamFixture,
    stateDir,
  });

  const started = await adapter.startRuntimeServer({ workspace, bindingId: 'worker_srv', fenceEpoch: 1 });
  t.after(() => adapter.stopServer(started.runtime));

  assert.equal(existsSync(sentinel), true, 'hostile sentinel untouched');
  assert.equal(readFileSync(sentinel, 'utf8'), beforeSentinel);
  assert.match(started.runtime.databaseIdentity, /^[0-9a-f]{64}$/);
  assert.match(started.binding.ownershipMode, /runtime-owned/);
  assert.equal(started.binding.serverProcessIdentity.pid > 0, true);
  assert.equal(typeof started.binding.sessionId === 'string' || started.binding.sessionId === null, true);

  const health = await adapter.requestJson(started.runtime, 'GET', '/global/health');
  assert.equal(health.ok, true);
  assert.equal(health.json.status, 'ok');
  // The server observed EXACTLY the intended runtime db through its env.
  assert.equal(health.json.openCodeDb, started.runtime.dbPath);
  assert.equal(health.json.openCodePure, '1');
  assert.equal(health.json.disableProjectConfig, '1');
  assert.equal(health.json.configContentShare, 'disabled');

  await adapter.stopServer(started.runtime);
});

test('a db-path mismatch fails closed instead of degrading', async (t) => {
  const stateDir = tempDir(t, 'mismatch');
  const workspace = tempDir(t, 'ws2');
  const adapter = createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
    stateDir,
    forceIntendedDbPathForTest: '/elsewhere/fake.db',
  });

  await assert.rejects(
    () => adapter.startRuntimeServer({ workspace, bindingId: 'worker_mm', fenceEpoch: 1 }),
    (error) => error.code === 'POLICY_DENIED',
  );
});

test('sessions resume from the same runtime database after a restart', async (t) => {
  const stateDir = tempDir(t, 'resume');
  const workspace = tempDir(t, 'ws3');
  const adapter = createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
    stateDir,
  });

  const first = await adapter.startRuntimeServer({ workspace, bindingId: 'worker_rs', fenceEpoch: 1 });
  const created = await adapter.createSession(first.runtime);
  await adapter.stopServer(first.runtime);

  const second = await adapter.startRuntimeServer({ workspace, bindingId: 'worker_rs', fenceEpoch: 1 });
  t.after(() => adapter.stopServer(second.runtime));

  assert.equal(second.runtime.dbPath, first.runtime.dbPath, 'restart reopens the same database identity');
  const resumed = await adapter.readSession(second.runtime, created.sessionId);
  assert.ok(resumed, 'session survived across the server restart under the same db');
  assert.equal(resumed.sessionId, created.sessionId);
  await adapter.stopServer(second.runtime);
});

test('observer attach is read-only; control verbs are identity-unproven', async (t) => {
  const stateDir = tempDir(t, 'observer');
  const adapter = createOpenCodeServerAdapter({ stateDir });

  const external = adapter.attachExternal({ sessionId: 'ses_external', databaseIdentityHint: null });
  assert.equal(external.binding.ownershipMode, 'attached-observer');

  assert.throws(() => adapter.respondPermission(external.binding, 'perm_1', 'allow'), (error) => error.code === 'WORKER_IDENTITY_UNPROVEN');
  await assert.rejects(() => adapter.abortSession(external.binding), (error) => error.code === 'WORKER_IDENTITY_UNPROVEN');
  await assert.rejects(() => adapter.deleteSession(external.binding), (error) => error.code === 'WORKER_IDENTITY_UNPROVEN');
});

test('cleanup never touches user-owned or shared databases', async (t) => {
  const stateDir = tempDir(t, 'cleanup');
  const workspace = tempDir(t, 'ws4');
  const defaultDb = join(workspace, 'user-owned-opencode.db');
  writeFileSync(defaultDb, 'user data\n', 'utf8');
  const sharedCliDb = join(workspace, 'shared-opencode-cli.db');
  writeFileSync(sharedCliDb, 'shared cli data\n', 'utf8');

  const adapter = createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
    stateDir,
    protectedPathsForTest: [defaultDb, sharedCliDb],
  });

  const started = await adapter.startRuntimeServer({ workspace, bindingId: 'worker_cl', fenceEpoch: 1 });
  const receipt = await adapter.stopServer(started.runtime);
  assert.match(JSON.stringify(receipt), /stopped|retained/);
  assert.equal(existsSync(defaultDb), true, 'user-owned db survives cleanup');
  assert.equal(existsSync(sharedCliDb), true, 'shared one-shot db survives cleanup');
});

test('diagnostics are read-only, cursor-ordered, schema-gated and mismatch-refusing', async (t) => {
  let openedReadOnly = null;
  const fakeRows = [
    { id: 'prt_b', time_created: 20, session_id: 'ses_fixture', data: JSON.stringify({ type: 'text', text: 'later part', reasoning: 'secret thoughts' }) },
    { id: 'prt_a', time_created: 10, session_id: 'ses_fixture', data: JSON.stringify({ type: 'text', text: 'earlier part' }) },
    { id: 'prt_z', time_created: 30, session_id: 'ses_other', data: JSON.stringify({ type: 'text', text: 'foreign' }) },
  ];
  function FakeDatabaseSync(path, options) {
    openedReadOnly = options?.readOnly ?? false;
    return {
      prepare(sql) {
        if (sql.includes('sqlite_master')) {
          return { all: () => [{ name: 'session' }, { name: 'message' }, { name: 'part' }, { name: 'todo' }] };
        }
        if (sql.startsWith('PRAGMA table_info')) {
          return { all: () => [{ name: 'id' }, { name: 'time_created' }, { name: 'data' }, { name: 'session_id' }] };
        }
        return {
          all(...params) {
            const [sessionId] = params;
            return [...fakeRows]
              .sort((a, b) => a.time_created - b.time_created || a.id.localeCompare(b.id))
              .filter((row) => row.session_id === sessionId);
          },
        };
      },
      close() {},
    };
  }
  FakeDatabaseSync.supportsSchema = true;

  const adapter = createOpenCodeDiagnosticAdapter({ DatabaseSync: FakeDatabaseSync });
  const probe = adapter.probeSync();
  assert.equal(probe.available, true);

  const result = adapter.readPartsAfter({
    dbPath: '/machine/local/opencode.db',
    expectedDatabaseDigest: 'bad-digest',
    sessionId: 'ses_fixture',
    afterCursor: { timeCreated: 0, id: '' },
  });
  assert.equal(result.ok, false, 'database identity mismatch refuses');
  assert.equal(result.error.code, 'POLICY_DENIED');

  const ok = adapter.readPartsAfter({
    dbPath: '/machine/local/opencode.db',
    expectedDatabaseDigest: adapter.digestDatabasePath('/machine/local/opencode.db'),
    sessionId: 'ses_fixture',
    afterCursor: { timeCreated: 0, id: '' },
  });
  assert.equal(ok.ok, true);
  assert.equal(openedReadOnly, true, 'diagnostic opens read-only or not at all');
  const summaries = ok.events.map((entry) => entry.summary);
  assert.deepEqual(summaries, ['earlier part', 'later part'], 'monotonic cursor order by time_created,id');
  assert.equal(JSON.stringify(ok.events).includes('foreign'), false, 'other sessions are never returned');
  assert.equal(JSON.stringify(ok.events).includes('secret thoughts'), false, 'reasoning is dropped');

  // Schema gate: missing required columns reports version-mismatch.
  function OldDatabaseSync() {
    return {
      prepare() {
        return { all: () => [] };
      },
      close() {},
    };
  }
  OldDatabaseSync.supportsSchema = false;
  const oldAdapter = createOpenCodeDiagnosticAdapter({ DatabaseSync: OldDatabaseSync });
  const gated = oldAdapter.readPartsAfter({
    dbPath: '/x.db',
    expectedDatabaseDigest: oldAdapter.digestDatabasePath('/x.db'),
    sessionId: 's',
    afterCursor: { timeCreated: 0, id: '' },
  });
  assert.equal(gated.ok, false);
  assert.equal(gated.error.code, 'ORCHESTRATION_UNSUPPORTED_VERSION');
});

test('the operator db mapping is an explicit external-observer seam only', () => {
  assert.equal(resolveOperatorDiagnosticDb({}), null);
  assert.equal(resolveOperatorDiagnosticDb({ WEBMCP_AI_OPENCODE_DB_PATH: '/operator/path.db' }), '/operator/path.db');
});

test('probe stays honest when node:sqlite is unavailable', () => {
  const adapter = createOpenCodeDiagnosticAdapter({ DatabaseSync: undefined });
  const probe = adapter.probeSync();
  assert.equal(probe.available, false);
  assert.match(probe.reason, /unavailable|node:sqlite/i);
});

// ---------------------------------------------------------------------------
// R5 — ownership, port binding, and database cleanup hardening (audit §9)
// ---------------------------------------------------------------------------

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Assert startRuntimeServer fails with the expected typed error while
 * guaranteeing no owned server is ever left behind — under RED the failure
 * may arrive late (or not at all), so both outcomes are cleaned up.
 */
async function expectStartFailure(adapter, args, matcher) {
  let started = null;
  try {
    started = await adapter.startRuntimeServer(args);
  } catch (error) {
    assert.ok(matcher(error), `unexpected failure ${error?.code ?? error?.name}: ${error?.message}`);
    return;
  }
  try {
    assert.fail(`expected startRuntimeServer to fail, resolved ${started.runtime.endpoint}`);
  } finally {
    await adapter.stopServer(started.runtime).catch(() => {});
  }
}

test('R5: real chmod behavior yields 0700 dir and 0600 reserved db file', (t) => {
  const dataRoot = tempDir(t, 'perm');
  // Simulate a pre-existing wide-open binding directory: the dead
  // process.chmod?.() no-op must not leave it enforceable-only-on-paper.
  mkdirSync(join(dataRoot, 'webmcp-ai-runtime', 'worker_perm'), { recursive: true, mode: 0o755 });
  chmodSync(join(dataRoot, 'webmcp-ai-runtime', 'worker_perm'), 0o755);

  const prepared = prepareRuntimeDatabase({ dataRoot, bindingId: 'worker_perm' });
  assert.equal(statSync(prepared.dbDir).mode & 0o777, 0o700, 'binding directory is enforced to 0700');
  assert.ok(existsSync(prepared.dbPath), 'runtime database file identity is reserved');
  assert.equal(statSync(prepared.dbPath).mode & 0o777, 0o600, 'runtime database file is enforced to 0600');
});

test('R5: ready line reporting a foreign port fails closed', async (t) => {
  const stateDir = tempDir(t, 'portmm');
  const workspace = tempDir(t, 'ws5');
  const adapter = createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
    stateDir,
    readyLineForTest: `${JSON.stringify({ ready: true, port: 43210 })}\n`,
  });

  await expectStartFailure(adapter, { workspace, bindingId: 'worker_pmm', fenceEpoch: 1 }, (error) => {
    assert.equal(error.code, 'PROVIDER_PROTOCOL_ERROR');
    assert.match(error.message, /port/i);
    return true;
  });
});

test('R5: non-loopback ready endpoint fails closed', async (t) => {
  const stateDir = tempDir(t, 'nonloop');
  const workspace = tempDir(t, 'ws6');
  // Reserve one genuinely free port so the ready line can report the RIGHT
  // port on the WRONG host — isolating the loopback check.
  const probe = net.createServer();
  await new Promise((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen));
  const chosenPort = probe.address().port;
  await new Promise((resolveClose) => probe.close(resolveClose));
  const adapter = createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
    stateDir,
    requestedPortForTest: chosenPort,
    readyLineForTest: `opencode server listening on http://10.9.8.7:${chosenPort}\n`,
  });

  await expectStartFailure(adapter, { workspace, bindingId: 'worker_nl', fenceEpoch: 1 }, (error) => {
    assert.equal(error.code, 'PROVIDER_PROTOCOL_ERROR');
    assert.match(error.message, /loopback|host/i);
    return true;
  });
});

test('R5: symlink-substituted runtime database fails before session use', async (t) => {
  const stateDir = tempDir(t, 'symdb');
  const workspace = tempDir(t, 'ws7');
  const adapter = createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
    stateDir,
    symlinkDbDirForTest: true,
  });

  await expectStartFailure(adapter, { workspace, bindingId: 'worker_sym', fenceEpoch: 1 }, (error) => {
    assert.equal(error.code, 'POLICY_DENIED');
    return true;
  });
});

test('R5: default/user databases are never selected or harmed', async (t) => {
  const dataRoot = tempDir(t, 'default');
  const userDefaultDb = join(dataRoot, 'opencode.db');
  const sharedCliDb = join(dataRoot, 'opencode-cli.db');
  writeFileSync(userDefaultDb, 'user default bytes\n');
  writeFileSync(sharedCliDb, 'shared cli bytes\n');

  // Even with a hostile caller-supplied OPENCODE_DB the isolated launch env
  // pins exactly the runtime-owned path.
  const prepared = prepareRuntimeDatabase({ dataRoot, bindingId: 'worker_df' });
  const env = buildIsolatedEnv({
    dbPath: prepared.dbPath,
    dispatchPrivateDir: tempDir(t, 'dfdispatch'),
    password: 'pw',
    baseEnv: { OPENCODE_DB: userDefaultDb },
  });
  assert.equal(env.OPENCODE_DB, prepared.dbPath);
  assert.match(prepared.dbPath, /webmcp-ai-runtime[\\/]worker_df[\\/]opencode\.db$/);
  assert.notEqual(prepared.dbPath, userDefaultDb);
  assert.notEqual(prepared.dbPath, sharedCliDb);
  assert.equal(readFileSync(userDefaultDb, 'utf8'), 'user default bytes\n');
  assert.equal(readFileSync(sharedCliDb, 'utf8'), 'shared cli bytes\n');
});

test('R5: release removes the verified database plus sidecars and proves absence', async (t) => {
  const stateDir = tempDir(t, 'rel');
  const workspace = tempDir(t, 'ws8');
  const adapter = createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
    stateDir,
  });

  const started = await adapter.startRuntimeServer({ workspace, bindingId: 'worker_rel', fenceEpoch: 1 });
  await adapter.createSession(started.runtime);
  // Known sqlite sidecars as the real binary would leave them behind.
  for (const side of ['opencode.db-wal', 'opencode.db-shm', 'opencode.db-journal']) {
    writeFileSync(join(dirname(started.runtime.dbPath), side), 'sidecar\n');
  }
  const dbDir = dirname(started.runtime.dbPath);

  const receipt = await adapter.stopServer(started.runtime, { release: true, settled: true });
  assert.equal(receipt.released, true, 'release is truthfully recorded');
  assert.equal(receipt.absenceProven, true, 'absence is proven, not assumed');
  assert.equal(existsSync(dbDir), false, 'isolated binding directory removed');
  assert.equal(existsSync(started.runtime.dbPath), false, 'database removed');
  for (const side of ['opencode.db-wal', 'opencode.db-shm', 'opencode.db-journal', 'sessions.json']) {
    assert.equal(existsSync(join(dbDir, side)), false, `sidecar ${side} removed`);
  }
  assert.deepEqual(
    (receipt.removedFiles ?? []).sort(),
    ['opencode.db', 'opencode.db-journal', 'opencode.db-shm', 'opencode.db-wal', 'sessions.json'],
  );
});

test('R5: unprovable release identity retains files and fails typed', async (t) => {
  const stateDir = tempDir(t, 'amb');
  const workspace = tempDir(t, 'ws9');
  const adapter = createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
    stateDir,
  });

  const started = await adapter.startRuntimeServer({ workspace, bindingId: 'worker_amb', fenceEpoch: 1 });
  const dbDir = dirname(started.runtime.dbPath);

  // (a) digest drift
  const digestDrift = { ...started.runtime, databaseIdentity: '0'.repeat(64) };
  await assert.rejects(
    () => adapter.stopServer(digestDrift, { release: true, settled: true }),
    (error) => error.code === 'POLICY_DENIED',
  );

  // (b) structurally plausible but nonexistent substituted tree
  const forged = {
    ...started.runtime,
    dbPath: join(stateDir, 'evil', 'webmcp-ai-runtime', 'worker_evil', 'opencode.db'),
    databaseIdentity: sha256Text(join(stateDir, 'evil', 'webmcp-ai-runtime', 'worker_evil', 'opencode.db')),
  };
  await assert.rejects(
    () => adapter.stopServer(forged, { release: true, settled: true }),
    (error) => error.code === 'POLICY_DENIED',
  );

  // (c) protected-path guard still wins over structural validity
  const guardedAdapter = createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
    stateDir,
    protectedPathsForTest: [started.runtime.dbPath],
  });
  await assert.rejects(
    () => guardedAdapter.stopServer(started.runtime, { release: true, settled: true }),
    (error) => error.code === 'POLICY_DENIED',
  );

  assert.equal(existsSync(started.runtime.dbPath), true, 'ambiguous identity never deletes');
  assert.equal(existsSync(dbDir), true, 'binding directory retained on refusal');
  await adapter.stopServer(started.runtime);
});

test('R5: an ambient server on the requested port cannot hijack the binding', async (t) => {
  const blocker = net.createServer();
  await new Promise((resolveListen) => blocker.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => blocker.close(resolveClose)));
  const blockedPort = blocker.address().port;

  // (a) the requested port is occupied: bootstrap must fail typed and the
  // ambient server must survive untouched.
  const stateDir = tempDir(t, 'hijack');
  const workspace = tempDir(t, 'ws10');
  const adapter = createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
    stateDir,
    requestedPortForTest: blockedPort,
  });
  await expectStartFailure(adapter, { workspace, bindingId: 'worker_hj', fenceEpoch: 1 }, (error) => {
    assert.equal(error.code, 'WORKER_PROCESS_LOST');
    return true;
  });
  assert.equal(blocker.listening, true, 'the ambient server was never swept');

  // (b) a ready line answering with someone else's port is rejected even
  // though our own child bound the requested port fine.
  const stateDir2 = tempDir(t, 'hijack2');
  const lyingAdapter = createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
    stateDir: stateDir2,
    requestedPortForTest: blockedPort === 41000 ? 41001 : 41000,
    readyLineForTest: `${JSON.stringify({ ready: true, port: blockedPort })}\n`,
  });
  await expectStartFailure(lyingAdapter, { workspace, bindingId: 'worker_hj2', fenceEpoch: 1 }, (error) => {
    assert.equal(error.code, 'PROVIDER_PROTOCOL_ERROR');
    return true;
  });
});
