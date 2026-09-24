import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bin = fileURLToPath(new URL('../bin/webmcp-jev.mjs', import.meta.url));
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

// No provider binary may exist behind these names, so any provider spawn
// attempt fails loudly instead of spending quota.
const NO_PROVIDER_ENV = {
  AGY_BIN: '/nonexistent/agy-bin',
  CLAUDE_BIN: '/nonexistent/claude-bin',
  CODEX_BIN: '/nonexistent/codex-bin',
  OPENCODE_BIN: '/nonexistent/opencode-bin',
};

function run(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    cwd: '/tmp',
    env: { ...process.env, ...NO_PROVIDER_ENV, ...env },
  });
}

test('help and bare invocation exit 0 without any provider', () => {
  for (const args of [[], ['--help'], ['-h'], ['help']]) {
    const result = run(args);
    assert.equal(result.status, 0, `${JSON.stringify(args)}: ${result.stderr}`);
    assert.match(result.stdout, /webmcp-jev doctor/);
    assert.match(result.stdout, /never falls back/);
  }
});

test('doctor --json emits one JSON object with separate readiness axes', () => {
  const result = run(['doctor', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.schema, 'webmcp-jev-doctor/1');
  assert.equal(payload.version, pkg.version);
  assert.equal(payload.route, 'jev');
  assert.ok(typeof payload.bin === 'string' && isAbsolute(payload.bin), 'bin must be an absolute path');
  assert.equal(payload.envOverrideUsed, false);
  assert.equal(payload.provider.installed, 'not-probed');
  assert.equal(payload.provider.authenticated, 'not-probed');
  assert.equal(payload.provider.canary, 'not-probed');
  assert.notEqual(payload.provider.authenticated, true, 'doctor must never claim authenticated');
  assert.notEqual(payload.provider.canary, true, 'doctor must never claim canary');
});

test('doctor honours WEBMCP_JEV_BIN without probing a provider', () => {
  const result = run(['doctor', '--json'], { env: { WEBMCP_JEV_BIN: '/tmp/custom-jev-bin.mjs' } });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.envOverrideUsed, true);
  assert.equal(payload.bin, '/tmp/custom-jev-bin.mjs');
  assert.equal(payload.provider.authenticated, 'not-probed');
});

test('doctor text mode stays human-readable with the same axes', () => {
  const result = run(['doctor']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp-jev doctor/);
  assert.match(result.stdout, /provider\.authenticated: not-probed/);
  assert.match(result.stdout, /provider\.canary: not-probed/);
});

test('unknown subcommand exits non-zero and never claims another route', () => {
  const result = run(['bogus-subcommand']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown jev command: bogus-subcommand/);
  assert.doesNotMatch(result.stderr, /Browser/);
  assert.doesNotMatch(result.stdout, /Browser/);
});

// Round 14 item 2: the canary stays blocked by default — bare exits 2,
// --live without attestation exits 1, and neither can reach the network
// (both return before any key file is read).
test('canary stays blocked without attestation', () => {
  const bare = run(['canary']);
  assert.equal(bare.status, 2, bare.stderr);
  assert.match(bare.stderr, /opt-in only/);
  const live = run(['canary', '--live']);
  assert.equal(live.status, 1, live.stderr);
  assert.match(live.stderr, /BLOCKED_BY_GATE0/);
});

test('canary help documents the attestation flag', () => {
  const result = run(['canary', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--attest-gate0/);
  assert.match(result.stdout, /--key-file/);
});

test('bin entry and ./jev export resolve to the jev runtime', async () => {
  assert.equal(pkg.bin['webmcp-jev'], 'bin/webmcp-jev.mjs');
  assert.equal(pkg.exports['./jev'], './src/jev/cli.mjs');
  const jevMod = await import('../src/jev/cli.mjs');
  assert.equal(typeof jevMod.runJevCli, 'function');
  const doctorMod = await import('../src/jev/doctor.mjs');
  assert.equal(typeof doctorMod.jevDoctor, 'function');
});
