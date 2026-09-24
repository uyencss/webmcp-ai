import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  PROVIDER_INSTALL_MANIFEST,
  applyProviderInstall,
  planProviderInstall,
  readBackProviderInstall,
} from '../src/providers/install.mjs';

import { createRequire } from 'node:module';

const cliBin = fileURLToPath(new URL('../bin/webmcp-ai.mjs', import.meta.url));

function writeExecutable(filePath, content) {
  writeFileSync(filePath, content, 'utf8');
  chmodSync(filePath, 0o755);
}

function makeSqliteFixture(filePath) {
  mkdirSync(join(filePath, '..'), { recursive: true });
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

test('1. planProviderInstall local returns 4 pinned providers, no mutations, no update spawn', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'plan-local-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const markerPath = join(tmp, 'marker-update.log');
  const fakeClaude = join(tmp, 'fake-claude.mjs');
  writeExecutable(fakeClaude, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.280 (Claude Code)\\n');
  process.exit(0);
}
appendFileSync(${JSON.stringify(markerPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(0);
`);

  const fakeOpencode = join(tmp, 'fake-opencode.mjs');
  writeExecutable(fakeOpencode, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  process.stdout.write('opencode v2.0.15\\n');
  process.exit(0);
}
appendFileSync(${JSON.stringify(markerPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(0);
`);

  const env = {
    ...process.env,
    CLAUDE_BIN: fakeClaude,
    OPENCODE_BIN: fakeOpencode,
  };

  const plan = planProviderInstall({ host: 'local', env });
  assert.equal(plan.ok, true);
  assert.equal(plan.schema, 'webmcp-ai-provider-install-plan/1');
  assert.deepEqual(plan.mutations, []);
  assert.equal(plan.providers.length, 4);

  const byId = Object.fromEntries(plan.providers.map((p) => [p.id, p]));
  assert.equal(byId.claude.version, '2.1.280');
  assert.equal(byId.opencode.version, '2.0.15');
  assert.equal(byId.codex.version, '0.155.0-alpha.16');
  assert.equal(byId.agy.version, '1.2.9');

  assert.equal(existsSync(markerPath), false, 'plan must never spawn update commands');
});

test('2. planProviderInstall throws PROVIDER_PIN_MISSING when a provider lacks version', () => {
  const badManifest = {
    ...PROVIDER_INSTALL_MANIFEST,
    hosts: {
      ...PROVIDER_INSTALL_MANIFEST.hosts,
      local: {
        authorized: true,
        providers: [
          { id: 'claude', bin: 'claude', source: 'native-installer', installable: true },
        ],
      },
    },
  };

  assert.throws(
    () => planProviderInstall({ host: 'local', manifest: badManifest }),
    (err) => {
      assert.equal(err.code, 'PROVIDER_PIN_MISSING');
      assert.equal(err.exitCode, 5);
      return true;
    },
  );
});

test('3. planProviderInstall orbit returns authorized:false, no spawn, action host-authorization-required', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'plan-orbit-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const marker = join(tmp, 'marker.log');
  const plan = planProviderInstall({ host: 'orbit', env: { ...process.env, CODEX_BIN: marker } });

  assert.equal(plan.ok, true);
  assert.equal(plan.schema, 'webmcp-ai-provider-install-plan/1');
  assert.equal(plan.host, 'orbit');
  assert.equal(plan.hostScoped, true);
  assert.equal(plan.authorized, false);
  assert.deepEqual(plan.mutations, []);
  assert.equal(plan.providers[0].id, 'codex');
  assert.equal(plan.providers[0].action, 'host-authorization-required');
  assert.equal(plan.providers[0].installed, null);
  assert.equal(plan.providers[0].state, 'not-probed');
  assert.equal(existsSync(marker), false);
});

test('4. applyProviderInstall orbit throws HOST_SCOPE_NOT_AUTHORIZED without local spawn', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'apply-orbit-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const marker = join(tmp, 'marker.log');
  const env = { ...process.env, CLAUDE_BIN: marker, OPENCODE_BIN: marker };

  await assert.rejects(
    () => applyProviderInstall({ host: 'orbit', env }),
    (err) => {
      assert.equal(err.code, 'HOST_SCOPE_NOT_AUTHORIZED');
      assert.equal(err.exitCode, 3);
      assert.equal(err.details?.host, 'orbit');
      assert.equal(err.details?.scope, 'host');
      return true;
    },
  );
  assert.equal(existsSync(marker), false);
});

test('5. applyProviderInstall local: execute:false -> operator-required, execute:true -> updated with allowlisted argv', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'apply-local-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const marker = join(tmp, 'marker.log');
  const fakeClaude = join(tmp, 'fake-claude.mjs');
  writeExecutable(fakeClaude, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.279 (Claude Code)\\n'); // drift
  process.exit(0);
}
appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(0);
`);

  const env = {
    ...process.env,
    CLAUDE_BIN: fakeClaude,
  };

  // execute: false -> operator-required, no spawn
  const receiptNoExec = await applyProviderInstall({ host: 'local', env, execute: false });
  assert.equal(receiptNoExec.ok, true);
  const claudeNoExec = receiptNoExec.providers.find((p) => p.id === 'claude');
  assert.equal(claudeNoExec.action, 'operator-required');
  assert.equal(claudeNoExec.command, 'claude update');
  assert.equal(existsSync(marker), false);

  // execute: true -> spawns allowlisted argv
  const receiptExec = await applyProviderInstall({ host: 'local', env, execute: true });
  assert.equal(receiptExec.ok, true);
  const claudeExec = receiptExec.providers.find((p) => p.id === 'claude');
  assert.equal(claudeExec.action, 'updated');
  assert.equal(existsSync(marker), true);

  const runs = readFileSync(marker, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(runs[0], ['update']);
});

test('6. receipt security hygiene: no auth:true, auth:not-assessed, canary:not-run, no tmpdir path', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'hygiene-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const fakeClaude = join(tmp, 'fake-claude.mjs');
  writeExecutable(fakeClaude, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.280\\n');
  process.exit(0);
}
process.exit(0);
`);

  const env = {
    ...process.env,
    CLAUDE_BIN: fakeClaude,
  };

  const receipt = await applyProviderInstall({ host: 'local', env, execute: false });
  assert.equal(receipt.auth, 'not-assessed');
  assert.equal(receipt.canary, 'not-run');

  const text = JSON.stringify(receipt);
  assert.equal(/"auth":\s*true/.test(text), false);
  assert.equal(/"authenticated":\s*true/.test(text), false);
  assert.equal(text.includes(tmp), false);
  assert.equal(text.includes(process.env.HOME), false);
});

test('7. readBackProviderInstall local: v2 ready when sqlite valid, missing when absent (never throws)', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'readback-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const fakeOpencode = join(tmp, 'fake-opencode.mjs');
  writeExecutable(fakeOpencode, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('opencode v2.0.15\\n');
  process.exit(0);
}
process.exit(0);
`);

  const fakeXdg = join(tmp, 'fake-xdg');
  const validDb = join(fakeXdg, 'opencode', 'opencode.db');
  makeSqliteFixture(validDb);

  const envWithDb = {
    ...process.env,
    OPENCODE_BIN: fakeOpencode,
    XDG_DATA_HOME: fakeXdg,
  };

  const rbReady = await readBackProviderInstall({ host: 'local', env: envWithDb });
  assert.equal(rbReady.ok, true);
  const opencodeReady = rbReady.providers.find((p) => p.id === 'opencode');
  assert.equal(opencodeReady.database, 'ready');
  assert.equal(opencodeReady.state, 'match');

  // Now delete the DB file
  rmSync(validDb, { force: true });
  const rbMissing = await readBackProviderInstall({ host: 'local', env: envWithDb });
  assert.equal(rbMissing.ok, true);
  const opencodeMissing = rbMissing.providers.find((p) => p.id === 'opencode');
  assert.equal(opencodeMissing.database, 'missing');
});

test('8. CLI smoke: providers install --plan --json and --host orbit --apply --json exit codes', () => {
  const planRun = spawnSync(process.execPath, [cliBin, 'providers', 'install', '--plan', '--json'], {
    encoding: 'utf8',
  });
  assert.equal(planRun.status, 0);
  const planJson = JSON.parse(planRun.stdout);
  assert.equal(planJson.ok, true);
  assert.equal(planJson.schema, 'webmcp-ai-provider-install-plan/1');

  const orbitRun = spawnSync(process.execPath, [cliBin, 'providers', 'install', '--host', 'orbit', '--apply', '--json'], {
    encoding: 'utf8',
  });
  assert.equal(orbitRun.status, 3);
  const orbitJson = JSON.parse(orbitRun.stdout);
  assert.equal(orbitJson.ok, false);
  assert.equal(orbitJson.error?.code, 'HOST_SCOPE_NOT_AUTHORIZED');
});
