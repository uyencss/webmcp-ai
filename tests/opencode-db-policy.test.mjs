import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  assertOpencodeV2DbReady,
  inspectOpencodeDb,
  resolveOpencodeCliDb,
} from '../src/providers/opencode.mjs';
import { getProvider } from '../src/providers/index.mjs';
import { describeGenerateDryRun, generate, listAgents, listModels } from '../src/client.mjs';
import { describeReviewDryRun, review } from '../src/review.mjs';

function createRealSqliteFile(filePath) {
  try {
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite');
    const db = new DatabaseSync(filePath);
    db.exec('CREATE TABLE IF NOT EXISTS _test (id INTEGER)');
    db.close();
  } catch {
    writeFileSync(filePath, Buffer.concat([Buffer.from('SQLite format 3\0', 'utf8'), Buffer.alloc(1024)]));
  }
}

test('resolveOpencodeCliDb resolves opencode.db for v2 and refuses v1', () => {
  const xdg = '/custom/xdg/data';
  const home = '/home/testuser';

  // v2 with XDG_DATA_HOME -> opencode.db, never opencode-cli.db
  const v2Resolved = resolveOpencodeCliDb({ XDG_DATA_HOME: xdg }, { profile: 'v2', homeDir: home });
  assert.equal(v2Resolved, join('/custom/xdg/data', 'opencode', 'opencode.db'));
  assert.equal(v2Resolved.includes('opencode-cli.db'), false);

  // v2 default -> <home>/.local/share/opencode/opencode.db
  const v2Default = resolveOpencodeCliDb({}, { profile: 'v2', homeDir: home });
  assert.equal(v2Default, join(home, '.local', 'share', 'opencode', 'opencode.db'));

  // v1 is refused with typed PROVIDER_CAPABILITY_DRIFT (v2 required)
  assert.throws(
    () => resolveOpencodeCliDb({ XDG_DATA_HOME: xdg }, { profile: 'v1', homeDir: home }),
    (err) => err.code === 'PROVIDER_CAPABILITY_DRIFT' && err.details?.profile === 'v1' && err.details?.required === 'v2',
  );

  assert.throws(
    () => resolveOpencodeCliDb({}, { profile: 'v1', homeDir: home }),
    (err) => err.code === 'PROVIDER_CAPABILITY_DRIFT' && err.details?.profile === 'v1' && err.details?.required === 'v2',
  );

  assert.throws(
    () => resolveOpencodeCliDb({ OPENCODE_DB: '/custom/path/opencode-cli.db' }, { profile: 'v1' }),
    (err) => err.code === 'PROVIDER_CAPABILITY_DRIFT' && err.details?.profile === 'v1' && err.details?.required === 'v2',
  );
  assert.throws(
    () => resolveOpencodeCliDb({ OPENCODE_DB: '/custom/path/my-custom.db' }, { profile: 'v1' }),
    (err) => err.code === 'PROVIDER_CAPABILITY_DRIFT' && err.details?.profile === 'v1' && err.details?.required === 'v2',
  );

  // v2 explicit override valid path verbatim
  assert.equal(
    resolveOpencodeCliDb({ OPENCODE_DB: '/custom/path/my-custom.db' }, { profile: 'v2' }),
    '/custom/path/my-custom.db',
  );
  assert.equal(
    resolveOpencodeCliDb({ OPENCODE_DB: '/custom/path/opencode.db' }, { profile: 'v2' }),
    '/custom/path/opencode.db',
  );
});

test('v2 explicit override with basename opencode-cli.db throws typed PROVIDER_STATE_UNINITIALIZED', () => {
  const badPosix = '/path/to/my/opencode-cli.db';
  const badWin = 'C:\\data\\opencode-cli.db';

  for (const override of [badPosix, badWin]) {
    assert.throws(
      () => resolveOpencodeCliDb({ OPENCODE_DB: override }, { profile: 'v2' }),
      (err) => {
        assert.equal(err.code, 'PROVIDER_STATE_UNINITIALIZED');
        assert.equal(err.retryable, false);
        assert.equal(err.details?.provider, 'opencode');
        assert.equal(err.details?.profile, 'v2');
        assert.equal(err.details?.state, 'prohibited-db');
        const serialized = JSON.stringify(err);
        assert.equal(serialized.includes(override), false, 'must not leak path');
        assert.equal(serialized.includes('opencode-cli.db'), false, 'must not include prohibited filename');
        assert.equal(err.message.includes('opencode-cli.db'), false);
        assert.equal(err.message.includes('opencode.db'), true);
        return true;
      },
    );
  }
});

test('inspectOpencodeDb accurately detects all states', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-inspect-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // missing
  const missingPath = join(dir, 'does-not-exist.db');
  assert.deepEqual(inspectOpencodeDb(missingPath), { ok: false, state: 'missing' });

  // empty
  const emptyPath = join(dir, 'empty.db');
  writeFileSync(emptyPath, Buffer.alloc(0));
  assert.deepEqual(inspectOpencodeDb(emptyPath), { ok: false, state: 'empty' });

  // not-a-file
  const dirPath = join(dir, 'directory.db');
  mkdirSync(dirPath);
  assert.deepEqual(inspectOpencodeDb(dirPath), { ok: false, state: 'not-a-file' });

  // symlink
  const targetPath = join(dir, 'target.db');
  writeFileSync(targetPath, Buffer.concat([Buffer.from('SQLite format 3\0', 'utf8'), Buffer.alloc(64)]));
  const linkPath = join(dir, 'symlink.db');
  symlinkSync(targetPath, linkPath);
  assert.deepEqual(inspectOpencodeDb(linkPath), { ok: false, state: 'symlink' });

  // not-sqlite
  const notSqlitePath = join(dir, 'not-sqlite.db');
  writeFileSync(notSqlitePath, 'Plain text file content'.repeat(50));
  assert.deepEqual(inspectOpencodeDb(notSqlitePath), { ok: false, state: 'not-sqlite' });

  // ready (magic + pad)
  const readyPath = join(dir, 'ready.db');
  writeFileSync(readyPath, Buffer.concat([Buffer.from('SQLite format 3\0', 'utf8'), Buffer.alloc(64)]));
  assert.deepEqual(inspectOpencodeDb(readyPath, { lockTimeoutMs: 0 }), { ok: true, state: 'ready' });

  // busy lock probe with node:sqlite
  let DatabaseSync;
  try {
    const req = createRequire(import.meta.url);
    ({ DatabaseSync } = req('node:sqlite'));
  } catch {}

  if (!DatabaseSync) {
    t.skip('node:sqlite not available; skipping busy lock test');
  } else {
    const lockDbPath = join(dir, 'locked.db');
    const locker = new DatabaseSync(lockDbPath);
    locker.exec('CREATE TABLE test_lock (id INTEGER)');
    locker.exec('BEGIN IMMEDIATE');
    try {
      const busyInspect = inspectOpencodeDb(lockDbPath, { lockTimeoutMs: 50 });
      assert.deepEqual(busyInspect, { ok: false, state: 'busy' });
    } finally {
      locker.close();
    }
    const readyInspect = inspectOpencodeDb(lockDbPath, { lockTimeoutMs: 50 });
    assert.deepEqual(readyInspect, { ok: true, state: 'ready' });
  }
});

test('generate with fake v2 enforces db policy before provider spawn', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-v2-spawn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const markerPath = join(dir, 'marker-spawned');
  const fakeBinPath = join(dir, 'fake-opencode-v2.mjs');
  writeFileSync(fakeBinPath, [
    '#!/usr/bin/env node',
    "import { writeFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    "if (args[0] === '--version') {",
    "  process.stdout.write('opencode v2.0.1\\n');",
    '  process.exit(0);',
    '}',
    `writeFileSync(${JSON.stringify(markerPath)}, 'invoked');`,
    "const db = process.env.OPENCODE_DB || '';",
    "process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'db-echo:' + db } }) + '\\n');",
    'process.exit(0);',
    '',
  ].join('\n'));
  chmodSync(fakeBinPath, 0o755);

  const baseEnv = {
    ...process.env,
    OPENCODE_BIN: fakeBinPath,
    FAKE_PROVIDER: 'opencode',
    PATH: process.env.PATH,
  };

  // 1. Default DB missing -> rejected before spawn, marker must not exist
  const emptyXdg = join(dir, 'empty-xdg');
  mkdirSync(emptyXdg);
  await assert.rejects(
    () => generate({
      provider: 'opencode',
      prompt: 'hello',
      workspace: dir,
      env: { ...baseEnv, XDG_DATA_HOME: emptyXdg },
    }),
    (err) => {
      assert.equal(err.code, 'PROVIDER_STATE_UNINITIALIZED');
      assert.equal(err.details?.state, 'missing');
      return true;
    },
  );
  assert.equal(existsSync(markerPath), false, 'provider run must not be spawned when default db is missing');

  // 2. OPENCODE_DB points to valid SQLite file ending in opencode.db -> succeeds
  const validDb = join(dir, 'opencode.db');
  createRealSqliteFile(validDb);
  const ok = await generate({
    provider: 'opencode',
    prompt: 'hello',
    workspace: dir,
    env: { ...baseEnv, OPENCODE_DB: validDb },
  });
  assert.equal(ok.ok, true);
  assert.ok(ok.response.text.includes('db-echo:'));
  assert.ok(ok.response.text.endsWith('opencode.db'));
  assert.equal(existsSync(markerPath), true, 'marker must exist after successful spawn');

  // 3. OPENCODE_DB names opencode-cli.db -> rejected before spawn
  rmSync(markerPath, { force: true });
  await assert.rejects(
    () => generate({
      provider: 'opencode',
      prompt: 'hello',
      workspace: dir,
      env: { ...baseEnv, OPENCODE_DB: join(dir, 'opencode-cli.db') },
    }),
    (err) => {
      assert.equal(err.code, 'PROVIDER_STATE_UNINITIALIZED');
      assert.equal(err.details?.state, 'prohibited-db');
      assert.equal(err.retryable, false);
      assert.equal(JSON.stringify(err).includes('opencode-cli.db'), false);
      return true;
    },
  );
  assert.equal(existsSync(markerPath), false, 'provider run must not be spawned on prohibited db');
});

test('buildInvocation for all v2 lanes sets OPENCODE_DB to opencode.db and never opencode-cli.db', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-v2-lanes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const env = { XDG_DATA_HOME: dir };
  const provider = getProvider('opencode');

  const lanes = [
    {
      name: 'unresolved (default v2)',
      request: { prompt: 't', workspace: dir, env },
    },
    {
      name: 'provider-default + accept-edits',
      request: { prompt: 't', workspace: dir, agentMode: 'accept-edits', accessProfile: 'provider-default', opencodeProfile: 'v2', env },
    },
    {
      name: 'review',
      request: { prompt: 't', workspace: dir, taskIntent: 'review', opencodeProfile: 'v2', env },
    },
    {
      name: 'compose',
      request: { prompt: 't', workspace: dir, taskIntent: 'compose', accessProfile: 'compose-only', opencodeProfile: 'v2', env },
    },
    {
      name: 'implement bounded-edit',
      request: { prompt: 't', workspace: dir, taskIntent: 'implement', accessProfile: 'bounded-edit', opencodeProfile: 'v2', env },
    },
    {
      name: 'implement full',
      request: { prompt: 't', workspace: dir, taskIntent: 'implement', accessProfile: 'full', opencodeProfile: 'v2', env },
    },
    {
      name: 'full passthrough',
      request: { prompt: 't', workspace: dir, accessProfile: 'full', opencodeProfile: 'v2', env },
    },
  ];

  for (const lane of lanes) {
    const inv = provider.buildInvocation(lane.request);
    try {
      assert.ok(
        inv.env.OPENCODE_DB.endsWith(join('opencode', 'opencode.db')),
        `${lane.name}: OPENCODE_DB (${inv.env.OPENCODE_DB}) must end with opencode/opencode.db`,
      );
      assert.equal(
        inv.env.OPENCODE_DB.includes('opencode-cli.db'),
        false,
        `${lane.name}: OPENCODE_DB must never contain opencode-cli.db`,
      );
    } finally {
      inv.cleanup?.();
    }
  }
});

test('buildInvocation for v1 profiles is refused with typed drift', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-v1-refusal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const env = { XDG_DATA_HOME: dir };
  const provider = getProvider('opencode');

  const lanes = [
    {
      name: 'provider-default (v1 profile)',
      request: { prompt: 't', workspace: dir, opencodeProfile: 'v1', env },
    },
    {
      name: 'provider-default + accept-edits',
      request: { prompt: 't', workspace: dir, agentMode: 'accept-edits', accessProfile: 'provider-default', opencodeProfile: 'v1', env },
    },
    {
      name: 'review',
      request: { prompt: 't', workspace: dir, taskIntent: 'review', opencodeProfile: 'v1', env },
    },
    {
      name: 'compose',
      request: { prompt: 't', workspace: dir, taskIntent: 'compose', accessProfile: 'compose-only', opencodeProfile: 'v1', env },
    },
    {
      name: 'implement bounded-edit',
      request: { prompt: 't', workspace: dir, taskIntent: 'implement', accessProfile: 'bounded-edit', opencodeProfile: 'v1', env },
    },
    {
      name: 'implement full',
      request: { prompt: 't', workspace: dir, taskIntent: 'implement', accessProfile: 'full', opencodeProfile: 'v1', env },
    },
    {
      name: 'full passthrough',
      request: { prompt: 't', workspace: dir, accessProfile: 'full', opencodeProfile: 'v1', env },
    },
  ];

  for (const lane of lanes) {
    assert.throws(
      () => provider.buildInvocation(lane.request),
      (err) => {
        assert.equal(err.code, 'PROVIDER_CAPABILITY_DRIFT', `${lane.name} must throw PROVIDER_CAPABILITY_DRIFT`);
        assert.equal(err.details?.profile, 'v1');
        assert.equal(err.details?.required, 'v2');
        return true;
      },
    );
  }
});

test('listModels and listAgents with fake v2 enforce db policy before provider spawn', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-v2-discovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const markerPath = join(dir, 'marker-discovery.log');
  const fakeBinPath = join(dir, 'fake-opencode-v2.mjs');
  writeFileSync(fakeBinPath, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(markerPath)}, JSON.stringify(args) + '\\n');`,
    "if (args[0] === '--version') {",
    "  process.stdout.write('opencode v2.0.1\\n');",
    '  process.exit(0);',
    '}',
    "if (args[0] === 'models') {",
    "  process.stdout.write('deepseek-v4.1\\n');",
    '  process.exit(0);',
    '}',
    "if (args[0] === 'agent') {",
    "  process.stdout.write('default-agent\\n');",
    '  process.exit(0);',
    '}',
    'process.exit(0);',
    '',
  ].join('\n'));
  chmodSync(fakeBinPath, 0o755);

  const emptyXdg = join(dir, 'empty-xdg');
  mkdirSync(emptyXdg);

  const baseEnv = {
    ...process.env,
    OPENCODE_BIN: fakeBinPath,
    XDG_DATA_HOME: emptyXdg,
    PATH: process.env.PATH,
  };

  // 1. listModels rejects PROVIDER_STATE_UNINITIALIZED when default db is missing
  await assert.rejects(
    () => listModels('opencode', { env: baseEnv }),
    (err) => {
      assert.equal(err.code, 'PROVIDER_STATE_UNINITIALIZED');
      assert.equal(err.details?.state, 'missing');
      return true;
    },
  );

  // Check marker: only '--version' was called, 'models' was NEVER invoked!
  let calls = readFileSync(markerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['--version']);

  // 2. listAgents rejects PROVIDER_STATE_UNINITIALIZED when default db is missing
  await assert.rejects(
    () => listAgents('opencode', { env: baseEnv }),
    (err) => {
      assert.equal(err.code, 'PROVIDER_STATE_UNINITIALIZED');
      assert.equal(err.details?.state, 'missing');
      return true;
    },
  );

  // Check marker: only '--version' was called twice, 'agent' was NEVER invoked!
  calls = readFileSync(markerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['--version']);
  assert.equal(calls.some((c) => c.includes('agent')), false, 'fake must not receive agent invocation');
  assert.equal(calls.some((c) => c.includes('models')), false, 'fake must not receive models invocation');

  // 3. When valid db is present, discovery succeeds and invokes models / agent
  const validDb = join(dir, 'opencode.db');
  createRealSqliteFile(validDb);
  const models = await listModels('opencode', { env: { ...baseEnv, OPENCODE_DB: validDb } });
  assert.deepEqual(models, ['deepseek-v4.1']);

  const agents = await listAgents('opencode', { env: { ...baseEnv, OPENCODE_DB: validDb } });
  assert.deepEqual(agents, ['default-agent']);
});

test('generate validates opencodeProfile and refuses v1 binary before spawn', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-profile-drift-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const markerPath = join(dir, 'marker-profile.log');
  const fakeBinPath = join(dir, 'fake-opencode.mjs');
  writeFileSync(fakeBinPath, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ args, opencodeDb: process.env.OPENCODE_DB }) + '\\n');`,
    "if (args[0] === '--version') {",
    "  process.stdout.write(process.env.FAKE_VERSION || 'opencode v2.0.15\\n');",
    '  process.exit(0);',
    '}',
    "if (args[0] === 'run') {",
    "  process.stdout.write(JSON.stringify({ type: 'text', text: 'response text' }) + '\\n');",
    '  process.exit(0);',
    '}',
    'process.exit(0);',
  ].join('\n'));
  chmodSync(fakeBinPath, 0o755);

  const validDb = join(dir, 'opencode.db');
  createRealSqliteFile(validDb);

  // 1. Explicit opencodeProfile:'v1' + fake binary v2 -> rejects PROVIDER_CAPABILITY_DRIFT, details.required === 'v2', does not spawn run
  await assert.rejects(
    () => generate({
      provider: 'opencode',
      prompt: 'hello',
      workspace: dir,
      accessProfile: 'provider-default',
      agentMode: 'accept-edits',
      opencodeProfile: 'v1',
      env: {
        ...process.env,
        OPENCODE_BIN: fakeBinPath,
        FAKE_VERSION: 'opencode v2.0.15\n',
        OPENCODE_DB: validDb,
      },
    }),
    (err) => {
      assert.equal(err.code, 'PROVIDER_CAPABILITY_DRIFT');
      assert.equal(err.details?.capability, 'profile');
      assert.equal(err.details?.profile, 'v1');
      assert.equal(err.details?.required, 'v2');
      assert.equal(JSON.stringify(err).includes(fakeBinPath), false, 'must not leak binary path');
      return true;
    },
  );

  let calls = readFileSync(markerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal(calls.some((c) => c.args.includes('run')), false, 'run must not be spawned');

  // 2. Explicit opencodeProfile:'v2' + fake binary v1 -> drift (detected v1 rejected)
  await assert.rejects(
    () => generate({
      provider: 'opencode',
      prompt: 'hello',
      workspace: dir,
      accessProfile: 'provider-default',
      agentMode: 'accept-edits',
      opencodeProfile: 'v2',
      env: {
        ...process.env,
        OPENCODE_BIN: fakeBinPath,
        FAKE_VERSION: '1.18.30\n',
        OPENCODE_DB: validDb,
      },
    }),
    (err) => {
      assert.equal(err.code, 'PROVIDER_CAPABILITY_DRIFT');
      assert.equal(err.details?.capability, 'profile');
      assert.equal(err.details?.detected, 'v1');
      assert.equal(err.details?.required, 'v2');
      return true;
    },
  );

  calls = readFileSync(markerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, ['--version']);
  assert.equal(calls.some((c) => c.args.includes('run')), false, 'run must not be spawned');

  // 3. Fake binary v1 (even with explicit opencodeProfile:'v1') -> refused before spawn, run not spawned
  const fakeXdg = join(dir, 'fake-xdg');
  await assert.rejects(
    () => generate({
      provider: 'opencode',
      prompt: 'hello',
      workspace: dir,
      accessProfile: 'provider-default',
      agentMode: 'accept-edits',
      opencodeProfile: 'v1',
      env: {
        ...process.env,
        OPENCODE_BIN: fakeBinPath,
        FAKE_VERSION: '1.18.30\n',
        XDG_DATA_HOME: fakeXdg,
      },
    }),
    (err) => {
      assert.equal(err.code, 'PROVIDER_CAPABILITY_DRIFT');
      assert.equal(err.details?.required, 'v2');
      return true;
    },
  );

  calls = readFileSync(markerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].args, ['--version']);
  assert.equal(calls.some((c) => c.args.includes('run')), false, 'run must not be spawned for v1 binary');
});

test('src does not contain syncOpencodeCredentials and explicit v1 never invokes sqlite3', async (t) => {
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));
  const readAllJs = (dir) => {
    let result = '';
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) result += readAllJs(full);
      else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) {
        result += readFileSync(full, 'utf8') + '\n';
      }
    }
    return result;
  };
  const srcContent = readAllJs(srcDir);
  assert.equal(
    srcContent.includes('syncOpencodeCredentials'),
    false,
    'src/ must never contain syncOpencodeCredentials',
  );

  // Explicit v1 does not call sqlite3
  const dir = mkdtempSync(join(tmpdir(), 'opencode-v1-no-sqlite-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sqliteMarker = join(dir, 'sqlite-called.log');
  const fakeSqlite = join(dir, 'sqlite3');
  writeFileSync(fakeSqlite, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sqliteMarker)}, 'called');\nprocess.exit(0);\n`);
  chmodSync(fakeSqlite, 0o755);

  const fakeBinPath = join(dir, 'fake-opencode.mjs');
  writeFileSync(fakeBinPath, `#!/usr/bin/env node\nif (process.argv.includes('--version')) { process.stdout.write('1.18.30\\n'); process.exit(0); }\nprocess.exit(0);\n`);
  chmodSync(fakeBinPath, 0o755);

  await assert.rejects(
    () => generate({
      provider: 'opencode',
      prompt: 'hello',
      workspace: dir,
      opencodeProfile: 'v1',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        OPENCODE_BIN: fakeBinPath,
      },
    }),
    (err) => err.code === 'PROVIDER_CAPABILITY_DRIFT' && err.details?.required === 'v2',
  );

  assert.equal(existsSync(sqliteMarker), false, 'sqlite3 must never be invoked on v1 refusal');
});

test('review and both dry-runs on a v2 host never select or write the legacy database', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-v2-legacy-protect-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });

  const xdgDataHome = join(dir, 'xdg');
  const opencodeDataDir = join(xdgDataHome, 'opencode');
  mkdirSync(opencodeDataDir, { recursive: true });

  const legacyDb = join(opencodeDataDir, 'opencode-cli.db');
  const v2Db = join(opencodeDataDir, 'opencode.db');

  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const dbLegacy = new DatabaseSync(legacyDb);
  dbLegacy.exec("CREATE TABLE legacy_sample (id INT, note TEXT); INSERT INTO legacy_sample VALUES (1, 'legacy-data-marker');");
  dbLegacy.close();

  const dbV2 = new DatabaseSync(v2Db);
  dbV2.exec("CREATE TABLE v2_sample (id INT, note TEXT); INSERT INTO v2_sample VALUES (2, 'v2-data-marker');");
  dbV2.close();

  const legacyBytesBefore = readFileSync(legacyDb);
  const legacyMtimeBefore = statSync(legacyDb).mtimeMs;

  const markerPath = join(dir, 'marker-v2-host.log');
  const fakeBinPath = join(dir, 'fake-opencode-v2.mjs');
  const reviewPayload = JSON.stringify({
    schema: 'webmcp-ai-review-result/1',
    verdict: 'approve',
    summary: 'review completed cleanly',
  });
  const v2HelpText = 'opencode run --standalone --format json --agent build --model sonnet#effort\n';

  writeFileSync(fakeBinPath, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ argv: args, db: process.env.OPENCODE_DB }) + '\\n');`,
    "if (args.includes('--version')) {",
    "  process.stdout.write('opencode v2.0.1\\n');",
    '  process.exit(0);',
    '}',
    "if (args.includes('--help')) {",
    `  process.stdout.write(${JSON.stringify(v2HelpText)});`,
    '  process.exit(0);',
    '}',
    "if (args.includes('run')) {",
    `  const line = JSON.stringify({ type: 'text', sessionID: 'ses_v2_protect', part: { type: 'text', text: ${JSON.stringify(reviewPayload)} } });`,
    "  process.stdout.write(line + '\\n');",
    '  process.exit(0);',
    '}',
    'process.exit(0);',
  ].join('\n'));
  chmodSync(fakeBinPath, 0o755);

  const env = {
    ...process.env,
    OPENCODE_BIN: fakeBinPath,
    XDG_DATA_HOME: xdgDataHome,
  };
  delete env.OPENCODE_DB;

  const genDryRun = describeGenerateDryRun({
    provider: 'opencode',
    prompt: 'x',
    workspace,
    accessProfile: 'provider-default',
    agentMode: 'plan',
    env,
  });
  assert.equal(genDryRun.ok, true);

  const revDryRun = describeReviewDryRun({
    provider: 'opencode',
    prompt: 'x',
    taskIntent: 'review',
    workspace,
    env,
  });
  assert.equal(revDryRun.ok, true);

  const revResult = await review({
    provider: 'opencode',
    prompt: 'x',
    taskIntent: 'review',
    workspace,
    env,
  });
  assert.equal(revResult.ok, true);
  assert.equal(revResult.review?.verdict, 'approve');

  // getProvider('opencode').buildInvocation({prompt:'x', workspace, env}) (unresolved)
  const unresolvedInvocation = getProvider('opencode').buildInvocation({
    prompt: 'x',
    workspace,
    env,
  });
  assert.ok(unresolvedInvocation.env.OPENCODE_DB.endsWith('opencode.db'), `expected opencode.db, got: ${unresolvedInvocation.env.OPENCODE_DB}`);
  unresolvedInvocation.cleanup?.();

  // Legacy bytes/mtime must not change
  const legacyBytesAfter = readFileSync(legacyDb);
  const legacyMtimeAfter = statSync(legacyDb).mtimeMs;
  assert.deepEqual(legacyBytesAfter, legacyBytesBefore, 'legacy database bytes must not change');
  assert.equal(legacyMtimeAfter, legacyMtimeBefore, 'legacy database mtime must not change');

  // Check marker: no models/agent marker, run invocations use db ending with opencode.db
  const calls = existsSync(markerPath)
    ? readFileSync(markerPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

  assert.equal(calls.some((c) => c.argv.includes('models') || c.argv.includes('agent')), false, 'must not invoke models or agent');
  const runCalls = calls.filter((c) => c.argv.includes('run') && !c.argv.includes('--help'));
  assert.ok(runCalls.length > 0, 'review() must spawn run');
  for (const call of runCalls) {
    assert.ok(call.db && call.db.endsWith('opencode.db'), `run DB must end with opencode.db, got: ${call.db}`);
  }
});
