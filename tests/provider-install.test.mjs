import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  PROVIDER_INSTALL_MANIFEST,
  applyProviderInstall,
  computePinDigest,
  planProviderInstall,
  readBackProviderInstall,
  versionMatchesPin,
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

test('5. applyProviderInstall local: execute:false -> operator-required, execute:true -> pin verification governs match/updated', async (t) => {
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

  // execute: true with version staying 2.1.279 -> state: drift, action: update-failed
  const receiptExec = await applyProviderInstall({ host: 'local', env, execute: true });
  assert.equal(receiptExec.ok, true);
  const claudeExec = receiptExec.providers.find((p) => p.id === 'claude');
  assert.equal(claudeExec.state, 'drift');
  assert.equal(claudeExec.action, 'update-failed');
  assert.equal(existsSync(marker), true);

  const runs = readFileSync(marker, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(runs[0], ['update']);

  // Successful update case: fake writes state file during update, then --version returns 2.1.280
  const stateFile = join(tmp, 'claude-updated.state');
  const fakeClaudeSuccess = join(tmp, 'fake-claude-success.mjs');
  writeExecutable(fakeClaudeSuccess, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  if (existsSync(${JSON.stringify(stateFile)})) {
    process.stdout.write('2.1.280 (Claude Code)\\n');
  } else {
    process.stdout.write('2.1.279 (Claude Code)\\n');
  }
  process.exit(0);
}
if (process.argv.includes('update')) {
  writeFileSync(${JSON.stringify(stateFile)}, 'done');
  process.exit(0);
}
process.exit(0);
`);

  const envSuccess = {
    ...process.env,
    CLAUDE_BIN: fakeClaudeSuccess,
  };

  const receiptSuccess = await applyProviderInstall({ host: 'local', env: envSuccess, execute: true });
  assert.equal(receiptSuccess.ok, true);
  const claudeSuccess = receiptSuccess.providers.find((p) => p.id === 'claude');
  assert.equal(claudeSuccess.state, 'match');
  assert.equal(claudeSuccess.action, 'updated');
  assert.equal(claudeSuccess.installedVersion, '2.1.280');
});

test('6. receipt security hygiene: no auth:true, auth:not-assessed, canary:not-run per-provider, no tmpdir path', async (t) => {
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
  for (const p of receipt.providers) {
    assert.equal(p.auth, 'not-assessed');
    assert.equal(p.canary, 'not-run');
  }

  const text = JSON.stringify(receipt);
  assert.equal(/"auth":\s*true/.test(text), false);
  assert.equal(/"authenticated":\s*true/.test(text), false);
  assert.equal(text.includes(tmp), false);
  assert.equal(text.includes(process.env.HOME), false);

  const plan = planProviderInstall({ host: 'local', env });
  for (const p of plan.providers) {
    assert.equal(p.auth, 'not-assessed');
    assert.equal(p.canary, 'not-run');
  }
  const planText = JSON.stringify(plan);
  assert.equal(/"auth":\s*true/.test(planText), false);
  assert.equal(/"authenticated":\s*true/.test(planText), false);

  const orbitPlan = planProviderInstall({ host: 'orbit', env });
  for (const p of orbitPlan.providers) {
    assert.equal(p.auth, 'not-assessed');
    assert.equal(p.canary, 'not-run');
  }

  const rb = await readBackProviderInstall({ host: 'local', env });
  assert.equal(rb.auth, 'not-assessed');
  assert.equal(rb.canary, 'not-run');
  for (const p of rb.providers) {
    assert.equal(p.auth, 'not-assessed');
    assert.equal(p.canary, 'not-run');
  }
  const rbText = JSON.stringify(rb);
  assert.equal(/"auth":\s*true/.test(rbText), false);
  assert.equal(/"authenticated":\s*true/.test(rbText), false);

  const orbitRb = await readBackProviderInstall({ host: 'orbit', env });
  assert.equal(orbitRb.auth, 'not-assessed');
  assert.equal(orbitRb.canary, 'not-run');
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

test('9. Sol counterexample: manifest override pin 9.9.9 with /usr/bin/true execute:true never matches', async () => {
  const customManifest = {
    ...PROVIDER_INSTALL_MANIFEST,
    hosts: {
      ...PROVIDER_INSTALL_MANIFEST.hosts,
      local: {
        authorized: true,
        providers: [
          {
            id: 'claude',
            bin: 'claude',
            env: 'CLAUDE_BIN',
            version: '9.9.9',
            source: 'native-installer',
            installKind: 'self-update',
            updateArgs: ['update'],
            installable: true,
          },
        ],
      },
    },
  };

  const env = {
    ...process.env,
    CLAUDE_BIN: '/usr/bin/true',
  };

  const receipt = await applyProviderInstall({
    host: 'local',
    env,
    execute: true,
    manifest: customManifest,
  });

  assert.equal(receipt.ok, true);
  const claude = receipt.providers.find((p) => p.id === 'claude');
  assert.notEqual(claude.state, 'match');
  assert.equal(claude.state, 'drift');
  assert.equal(claude.action, 'update-failed');
});

test('10. binary hash: small fake bin receipt + read-back has real sha256, hashSource binary-sha256, manifest algorithm', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'hash-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  assert.equal(PROVIDER_INSTALL_MANIFEST.hashAlgorithm, 'sha256');

  const fakeClaude = join(tmp, 'fake-claude.mjs');
  writeExecutable(fakeClaude, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.280\\n');
  process.exit(0);
}
process.exit(0);
`);

  const fileBytes = readFileSync(fakeClaude);
  const expectedHash = `sha256:${createHash('sha256').update(fileBytes).digest('hex')}`;
  assert.match(expectedHash, /^sha256:[0-9a-f]{64}$/);

  const env = {
    ...process.env,
    CLAUDE_BIN: fakeClaude,
  };

  const receipt = await applyProviderInstall({ host: 'local', env, execute: false });
  const claudeReceipt = receipt.providers.find((p) => p.id === 'claude');
  assert.equal(claudeReceipt.hash, expectedHash);
  assert.equal(claudeReceipt.hashSource, 'binary-sha256');

  const rb = await readBackProviderInstall({ host: 'local', env });
  const claudeRb = rb.providers.find((p) => p.id === 'claude');
  assert.equal(claudeRb.hash, expectedHash);
  assert.equal(claudeRb.hashSource, 'binary-sha256');

  const plan = planProviderInstall({ host: 'local', env });
  const claudePlan = plan.providers.find((p) => p.id === 'claude');
  assert.equal(claudePlan.hash, expectedHash);
  assert.equal(claudePlan.hashSource, 'binary-sha256');
});

test('11. versionMatchesPin matches exact semver tokens and rejects substring matches', () => {
  assert.equal(versionMatchesPin('24.19.0', '4.19.0'), false);
  assert.equal(versionMatchesPin('4.19.01', '4.19.0'), false);
  assert.equal(versionMatchesPin('2.1.280 (Claude Code)', '2.1.280'), true);
  assert.equal(versionMatchesPin('Claude Code 2.1.280', '2.1.280'), true);
  assert.equal(versionMatchesPin('0.155.0-alpha.16', '0.155.0-alpha.16'), true);
  assert.equal(versionMatchesPin('opencode v2.0.15', '2.0.15'), true);
  assert.equal(versionMatchesPin(null, '1.0.0'), false);
  assert.equal(versionMatchesPin('1.0.0', null), false);
  assert.equal(versionMatchesPin('', '1.0.0'), false);
});

test('12. Sol counterexample #2: manifest override pin 4.19.0 with binary printing 24.19.0 drifts, never matches via substring', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'sol-counterexample-2-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const fakeClaude = join(tmp, 'fake-claude-24.mjs');
  writeExecutable(fakeClaude, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('24.19.0\\n');
  process.exit(0);
}
process.exit(0);
`);

  const customManifest = {
    ...PROVIDER_INSTALL_MANIFEST,
    hosts: {
      ...PROVIDER_INSTALL_MANIFEST.hosts,
      local: {
        authorized: true,
        providers: [
          {
            id: 'claude',
            bin: 'claude',
            env: 'CLAUDE_BIN',
            version: '4.19.0',
            source: 'native-installer',
            installKind: 'self-update',
            updateArgs: ['update'],
            installable: true,
          },
        ],
      },
    },
  };

  const env = {
    ...process.env,
    CLAUDE_BIN: fakeClaude,
  };

  const plan = planProviderInstall({ host: 'local', env, manifest: customManifest });
  assert.equal(plan.ok, true);
  const plannedClaude = plan.providers.find((p) => p.id === 'claude');
  assert.equal(plannedClaude.state, 'drift');
  assert.notEqual(plannedClaude.state, 'match');
  assert.equal(plannedClaude.action, 'upgrade');

  const receipt = await applyProviderInstall({
    host: 'local',
    env,
    execute: true,
    manifest: customManifest,
  });
  assert.equal(receipt.ok, true);
  const claudeReceipt = receipt.providers.find((p) => p.id === 'claude');
  assert.equal(claudeReceipt.state, 'drift');
  assert.notEqual(claudeReceipt.state, 'match');
  assert.equal(claudeReceipt.action, 'update-failed');
});

test('13. pinDigest: shape sha256 hex, independent canonical JSON computation matches manifest, override changes digest, plan/receipt/read-back match', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'pin-digest-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  assert.equal(PROVIDER_INSTALL_MANIFEST.pinDigestAlgorithm, 'sha256');

  // Independent canonical JSON recomputation helper in test
  function independentPinDigest(p) {
    const payload = {
      id: p.id,
      installable: Boolean(p.installable),
      source: p.source,
      updateArgs: Array.isArray(p.updateArgs) ? p.updateArgs : [],
      version: p.version,
    };
    const keys = Object.keys(payload).sort();
    const canonical = `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(payload[k])}`).join(',')}}`;
    return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
  }

  // 1. Check all providers in local and orbit hosts
  const allProviders = [
    ...PROVIDER_INSTALL_MANIFEST.hosts.local.providers,
    ...PROVIDER_INSTALL_MANIFEST.hosts.orbit.providers,
  ];

  for (const p of allProviders) {
    assert.match(p.pinDigest, /^sha256:[0-9a-f]{64}$/, `provider ${p.id} pinDigest must match sha256 hex pattern`);
    const expected = independentPinDigest(p);
    assert.equal(p.pinDigest, expected, `independent canonical recompute for ${p.id} must equal manifest pinDigest`);
  }

  // 2. Changing version in manifest override changes digest
  const originalClaude = PROVIDER_INSTALL_MANIFEST.hosts.local.providers.claude;
  const overriddenClaude = {
    ...originalClaude,
    version: '2.1.999',
  };
  const overriddenDigest = independentPinDigest(overriddenClaude);
  assert.notEqual(overriddenDigest, originalClaude.pinDigest);

  // 3. Plan, receipt, and read-back entries match provider def pinDigest
  const fakeClaude = join(tmp, 'fake-claude.mjs');
  writeExecutable(fakeClaude, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.280\\n');
  process.exit(0);
}
process.exit(0);
`);
  const env = { ...process.env, CLAUDE_BIN: fakeClaude };

  // Plan local
  const plan = planProviderInstall({ host: 'local', env });
  for (const entry of plan.providers) {
    const def = PROVIDER_INSTALL_MANIFEST.hosts.local.providers.find((p) => p.id === entry.id);
    assert.ok(def, `manifest provider def found for ${entry.id}`);
    assert.equal(entry.pinDigest, def.pinDigest, `plan entry pinDigest must match provider def for ${entry.id}`);
  }

  // Plan orbit
  const orbitPlan = planProviderInstall({ host: 'orbit', env });
  for (const entry of orbitPlan.providers) {
    const def = PROVIDER_INSTALL_MANIFEST.hosts.orbit.providers.find((p) => p.id === entry.id);
    assert.ok(def, `manifest provider def found for orbit ${entry.id}`);
    assert.equal(entry.pinDigest, def.pinDigest, `orbit plan entry pinDigest must match provider def for ${entry.id}`);
  }

  // Receipt
  const receipt = await applyProviderInstall({ host: 'local', env, execute: false });
  for (const entry of receipt.providers) {
    const def = PROVIDER_INSTALL_MANIFEST.hosts.local.providers.find((p) => p.id === entry.id);
    assert.ok(def);
    assert.equal(entry.pinDigest, def.pinDigest, `receipt entry pinDigest must match provider def for ${entry.id}`);
  }

  // Read-back
  const rb = await readBackProviderInstall({ host: 'local', env });
  for (const entry of rb.providers) {
    const def = PROVIDER_INSTALL_MANIFEST.hosts.local.providers.find((p) => p.id === entry.id);
    assert.ok(def);
    assert.equal(entry.pinDigest, def.pinDigest, `read-back entry pinDigest must match provider def for ${entry.id}`);
  }
});

test('14. a mutated pin can never carry a stale pinDigest', async (t) => {
  const manifest = structuredClone(PROVIDER_INSTALL_MANIFEST);
  const oldClaude = manifest.hosts.local.providers.find((p) => p.id === 'claude');
  const staleDigest = oldClaude.pinDigest;               // digest của fields CŨ
  manifest.hosts.local.providers = manifest.hosts.local.providers.map((p) =>
    p.id === 'claude' ? { ...p, version: '4.19.0' } : { ...p, installable: false }); // spread giữ pinDigest cũ
  const newClaude = manifest.hosts.local.providers.find((p) => p.id === 'claude');
  assert.equal(newClaude.pinDigest, staleDigest, 'carried digest is stale by construction');
  const expected = computePinDigest({ ...newClaude });    // recompute từ fields MỚI
  assert.notEqual(expected, staleDigest);
  const env = { ...process.env, CLAUDE_BIN: '/usr/bin/true' };
  const plan = planProviderInstall({ host: 'local', env, manifest });
  const planned = plan.providers.find((p) => p.id === 'claude');
  assert.equal(planned.pinDigest, expected);
  assert.notEqual(planned.pinDigest, staleDigest);
  const receipt = await applyProviderInstall({ host: 'local', env, manifest });
  const applied = receipt.providers.find((p) => p.id === 'claude');
  assert.equal(applied.pinDigest, expected);
  assert.notEqual(applied.pinDigest, staleDigest);
});


