import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  assertOpencodeV2DbReady,
  inspectOpencodeDb,
  resolveOpencodeCliDb,
} from '../src/providers/opencode.mjs';
import { getProvider } from '../src/providers/index.mjs';
import { generate, listAgents, listModels } from '../src/client.mjs';

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

test('resolveOpencodeCliDb resolves opencode.db for v2 and opencode-cli.db for v1', () => {
  const xdg = '/custom/xdg/data';
  const home = '/home/testuser';

  // v2 with XDG_DATA_HOME -> opencode.db, never opencode-cli.db
  const v2Resolved = resolveOpencodeCliDb({ XDG_DATA_HOME: xdg }, { profile: 'v2', homeDir: home });
  assert.equal(v2Resolved, join('/custom/xdg/data', 'opencode', 'opencode.db'));
  assert.equal(v2Resolved.includes('opencode-cli.db'), false);

  // v2 default -> <home>/.local/share/opencode/opencode.db
  const v2Default = resolveOpencodeCliDb({}, { profile: 'v2', homeDir: home });
  assert.equal(v2Default, join(home, '.local', 'share', 'opencode', 'opencode.db'));

  // v1 with XDG_DATA_HOME -> opencode-cli.db
  const v1Resolved = resolveOpencodeCliDb({ XDG_DATA_HOME: xdg }, { profile: 'v1', homeDir: home });
  assert.equal(v1Resolved, join('/custom/xdg/data', 'opencode', 'opencode-cli.db'));

  // v1 default -> <home>/.local/share/opencode/opencode-cli.db
  const v1Default = resolveOpencodeCliDb({}, { profile: 'v1', homeDir: home });
  assert.equal(v1Default, join(home, '.local', 'share', 'opencode', 'opencode-cli.db'));

  // v1 explicit override verbatim
  assert.equal(
    resolveOpencodeCliDb({ OPENCODE_DB: '/custom/path/opencode-cli.db' }, { profile: 'v1' }),
    '/custom/path/opencode-cli.db',
  );
  assert.equal(
    resolveOpencodeCliDb({ OPENCODE_DB: '/custom/path/my-custom.db' }, { profile: 'v1' }),
    '/custom/path/my-custom.db',
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

test('buildInvocation for v1 lanes preserves opencode-cli.db (regression guard)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-v1-lanes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const env = { XDG_DATA_HOME: dir };
  const provider = getProvider('opencode');

  const lanes = [
    {
      name: 'provider-default (default profile)',
      request: { prompt: 't', workspace: dir, env },
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
    const inv = provider.buildInvocation(lane.request);
    try {
      assert.ok(
        inv.env.OPENCODE_DB.endsWith(join('opencode', 'opencode-cli.db')),
        `${lane.name}: OPENCODE_DB (${inv.env.OPENCODE_DB}) must end with opencode/opencode-cli.db`,
      );
    } finally {
      inv.cleanup?.();
    }
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

test('generate validates opencodeProfile override against detected binary version and preserves v1 compat', async (t) => {
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

  // 1. Explicit opencodeProfile:'v1' + fake binary v2 -> rejects PROVIDER_CAPABILITY_DRIFT, details.detected === 'v2', does not spawn run
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
      assert.equal(err.details?.detected, 'v2');
      assert.equal(JSON.stringify(err).includes(fakeBinPath), false, 'must not leak binary path');
      return true;
    },
  );

  let calls = readFileSync(markerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal(calls.some((c) => c.args.includes('run')), false, 'run must not be spawned');

  // 2. Explicit opencodeProfile:'v2' + fake binary v1 -> drift
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
      assert.equal(err.details?.profile, 'v2');
      assert.equal(err.details?.detected, 'v1');
      return true;
    },
  );

  calls = readFileSync(markerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, ['--version']);
  assert.equal(calls.some((c) => c.args.includes('run')), false, 'run must not be spawned');

  // 3. Explicit opencodeProfile:'v1' + fake binary v1 -> still uses opencode-cli.db (compat preserved)
  const fakeXdg = join(dir, 'fake-xdg');
  const res = await generate({
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
  });
  assert.equal(res.ok, true);

  calls = readFileSync(markerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const runCall = calls.find((c) => c.args.includes('run'));
  assert.ok(runCall, 'run should be spawned for matching v1');
  assert.equal(runCall.opencodeDb.endsWith(join('opencode', 'opencode-cli.db')), true);
});

