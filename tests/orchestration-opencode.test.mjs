import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
