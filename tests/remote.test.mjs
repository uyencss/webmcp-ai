import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildSshArgs,
  listClaudeRemoteHosts,
  probeRemoteClaude,
  readRemoteClaudeState,
  resolveClaudeRemoteHost,
  resolveSshBin,
  selectClaudeHost,
} from '../src/remote.mjs';

function writeExecutable(path, content) {
  writeFileSync(path, content, 'utf8');
  chmodSync(path, 0o755);
}

// A fake ssh binary that mirrors the fake-ai-cli.mjs fixture style: driven
// entirely by env vars so each test controls behavior without touching the
// real network. Reads the last argv token (the remote --version/--help flag
// forwarded after the ssh option set + sshHost + remote binary path).
function writeFakeSsh(dir) {
  const script = join(dir, 'fake-ssh.mjs');
  writeExecutable(script, `#!/usr/bin/env node
if (process.env.FAKE_SSH_SLEEP_MS) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_SSH_SLEEP_MS)));
}
const args = process.argv.slice(2);
const last = args[args.length - 1];
if (process.env.FAKE_SSH_EXIT_CODE) {
  process.stderr.write('simulated ssh failure host=secret-host-should-not-leak user=secret-user\\n');
  process.exit(Number(process.env.FAKE_SSH_EXIT_CODE));
}
if (last === '--version') {
  process.stdout.write((process.env.FAKE_SSH_VERSION || '2.1.283 (Claude Code)') + '\\n');
  process.exit(0);
}
if (last === '--help') {
  if (process.env.FAKE_SSH_HELP_EXIT_CODE) {
    process.stderr.write('simulated ssh help-call failure\\n');
    process.exit(Number(process.env.FAKE_SSH_HELP_EXIT_CODE));
  }
  process.stdout.write('--disable-slash-commands --permission-prompts none\\n');
  process.exit(0);
}
process.exit(1);
`);
  return script;
}

test('listClaudeRemoteHosts exposes the declared m1 registry entry', () => {
  const hosts = listClaudeRemoteHosts();
  const m1 = hosts.find((h) => h.id === 'm1');
  assert.ok(m1, 'm1 must be declared');
  assert.equal(m1.sshHost, 'mac-pro14');
  assert.equal(m1.binary, '/Users/ttcenter/.local/bin/claude');
  assert.equal(m1.workspaceRoot, '/Users/ttcenter/Desktop/VIBE_CODE');
});

test('resolveClaudeRemoteHost returns the declared entry with no env overrides', () => {
  const host = resolveClaudeRemoteHost('m1', {});
  assert.equal(host.id, 'm1');
  assert.equal(host.sshHost, 'mac-pro14');
  assert.equal(host.binary, '/Users/ttcenter/.local/bin/claude');
  assert.equal(host.worker, '/Users/ttcenter/.webmcp-ai/claude-remote-worker.mjs');
  assert.equal(host.workspaceRoot, '/Users/ttcenter/Desktop/VIBE_CODE');
});

test('resolveClaudeRemoteHost applies valid operator env overrides per field', () => {
  const host = resolveClaudeRemoteHost('m1', {
    WEBMCP_AI_CLAUDE_SSH_ALIAS: 'other-host-1',
    WEBMCP_AI_CLAUDE_REMOTE_BIN: '/opt/claude/claude',
    WEBMCP_AI_CLAUDE_REMOTE_WORKER: '/opt/claude/worker.mjs',
    WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: '/opt/workspace',
  });
  assert.equal(host.sshHost, 'other-host-1');
  assert.equal(host.binary, '/opt/claude/claude');
  assert.equal(host.worker, '/opt/claude/worker.mjs');
  assert.equal(host.workspaceRoot, '/opt/workspace');
});

test('resolveClaudeRemoteHost rejects an unknown host id without leaking it', () => {
  assert.throws(
    () => resolveClaudeRemoteHost('super-secret-unknown-host', {}),
    (err) => {
      assert.equal(err.code, 'CLAUDE_REMOTE_CONFIG_INVALID');
      assert.deepEqual(err.details, { field: 'hostId' });
      assert.equal(err.message.includes('super-secret-unknown-host'), false);
      return true;
    },
  );
});

const INVALID_ENV_CLASSES = [
  {
    label: 'sshHost with a space',
    env: { WEBMCP_AI_CLAUDE_SSH_ALIAS: 'evil host; rm -rf /' },
    field: 'sshHost',
    rawValue: 'evil host; rm -rf /',
  },
  {
    label: 'sshHost starting with a dash (flag injection shape)',
    env: { WEBMCP_AI_CLAUDE_SSH_ALIAS: '-oProxyCommand=curl-evil-secret' },
    field: 'sshHost',
    rawValue: 'curl-evil-secret',
  },
  {
    label: 'binary relative path',
    env: { WEBMCP_AI_CLAUDE_REMOTE_BIN: 'relative/claude-secret-path' },
    field: 'binary',
    rawValue: 'relative/claude-secret-path',
  },
  {
    label: 'binary with .. segment',
    env: { WEBMCP_AI_CLAUDE_REMOTE_BIN: '/opt/../etc/secret-passwd-path' },
    field: 'binary',
    rawValue: 'secret-passwd-path',
  },
  {
    label: 'binary with a null byte',
    env: { WEBMCP_AI_CLAUDE_REMOTE_BIN: '/opt/claude-secret\0-path' },
    field: 'binary',
    rawValue: 'claude-secret',
  },
  {
    label: 'worker relative path',
    env: { WEBMCP_AI_CLAUDE_REMOTE_WORKER: 'worker-secret-relative.mjs' },
    field: 'worker',
    rawValue: 'worker-secret-relative.mjs',
  },
  {
    label: 'workspaceRoot relative path',
    env: { WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: 'secret-relative-workspace' },
    field: 'workspaceRoot',
    rawValue: 'secret-relative-workspace',
  },
  {
    label: 'workspaceRoot with .. escape',
    env: { WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: '/a/../secret-escape-workspace' },
    field: 'workspaceRoot',
    rawValue: 'secret-escape-workspace',
  },
];

for (const { label, env, field, rawValue } of INVALID_ENV_CLASSES) {
  test(`resolveClaudeRemoteHost rejects invalid ${label} as CLAUDE_REMOTE_CONFIG_INVALID`, () => {
    assert.throws(
      () => resolveClaudeRemoteHost('m1', env),
      (err) => {
        assert.equal(err.code, 'CLAUDE_REMOTE_CONFIG_INVALID');
        assert.equal(err.details?.field, field);
        const serialized = JSON.stringify(err.details ?? {});
        assert.equal(err.message.includes(rawValue), false, 'message must not leak the raw invalid value');
        assert.equal(serialized.includes(rawValue), false, 'details must not leak the raw invalid value');
        return true;
      },
    );
  });
}

// F1 (reviewer L1, Muse 1.3): ssh joins the post-host argv into a remote
// shell command, so a path override containing shell metacharacters would be
// interpreted remotely instead of treated as an opaque path. Every class
// below must now be rejected as CLAUDE_REMOTE_CONFIG_INVALID with the raw
// value never reaching message/details, across every path-shaped override
// field (binary/worker/workspaceRoot).
const SHELL_METACHAR_PATHS = [
  { label: 'semicolon command chain', value: '/tmp/x; touch PWNED' },
  { label: 'embedded space', value: '/tmp/a b' },
  { label: 'dollar-paren command substitution', value: '/tmp/$(touch PWNED)' },
  { label: 'backtick command substitution', value: '/tmp/`touch PWNED`' },
  { label: 'pipe', value: '/tmp/a|b' },
  { label: 'double ampersand chain', value: '/tmp/a&&b' },
  { label: 'output redirect', value: '/tmp/a>b' },
  { label: 'input redirect', value: '/tmp/a<b' },
  { label: 'double quote', value: '/tmp/a"b' },
  { label: 'single quote', value: "/tmp/a'b" },
  { label: 'backslash escape', value: '/tmp/a\\b' },
  { label: 'glob asterisk', value: '/tmp/a*b' },
  { label: 'control character (tab)', value: '/tmp/a\tb' },
];

const PATH_OVERRIDE_FIELDS = [
  { field: 'binary', envKey: 'WEBMCP_AI_CLAUDE_REMOTE_BIN' },
  { field: 'worker', envKey: 'WEBMCP_AI_CLAUDE_REMOTE_WORKER' },
  { field: 'workspaceRoot', envKey: 'WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE' },
];

for (const { field, envKey } of PATH_OVERRIDE_FIELDS) {
  for (const { label, value } of SHELL_METACHAR_PATHS) {
    test(`F1: ${field} override rejects ${label} as CLAUDE_REMOTE_CONFIG_INVALID (no shell-arg injection)`, () => {
      assert.throws(
        () => resolveClaudeRemoteHost('m1', { [envKey]: value }),
        (err) => {
          assert.equal(err.code, 'CLAUDE_REMOTE_CONFIG_INVALID');
          assert.equal(err.details?.field, field);
          const serialized = JSON.stringify(err.details ?? {});
          assert.equal(err.message.includes(value), false, 'message must not leak the raw invalid value');
          assert.equal(serialized.includes(value), false, 'details must not leak the raw invalid value');
          assert.equal(err.message.includes('PWNED'), false);
          assert.equal(serialized.includes('PWNED'), false);
          return true;
        },
      );
    });
  }
}

test('F1: a plain safe absolute path is still accepted (no over-rejection)', () => {
  const host = resolveClaudeRemoteHost('m1', {
    WEBMCP_AI_CLAUDE_REMOTE_BIN: '/opt/claude-2.1/bin/claude_v2',
    WEBMCP_AI_CLAUDE_REMOTE_WORKER: '/opt/claude-2.1/worker.mjs',
    WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: '/opt/workspace-1',
  });
  assert.equal(host.binary, '/opt/claude-2.1/bin/claude_v2');
  assert.equal(host.worker, '/opt/claude-2.1/worker.mjs');
  assert.equal(host.workspaceRoot, '/opt/workspace-1');
});

test('selectClaudeHost: unset/empty/local resolve to local; declared id passes through; unknown fails closed', () => {
  assert.equal(selectClaudeHost({}), 'local');
  assert.equal(selectClaudeHost({ WEBMCP_AI_CLAUDE_HOST: '' }), 'local');
  assert.equal(selectClaudeHost({ WEBMCP_AI_CLAUDE_HOST: '   ' }), 'local');
  assert.equal(selectClaudeHost({ WEBMCP_AI_CLAUDE_HOST: 'local' }), 'local');
  assert.equal(selectClaudeHost({ WEBMCP_AI_CLAUDE_HOST: 'LOCAL' }), 'local');
  assert.equal(selectClaudeHost({ WEBMCP_AI_CLAUDE_HOST: 'm1' }), 'm1');
  assert.throws(
    () => selectClaudeHost({ WEBMCP_AI_CLAUDE_HOST: 'super-secret-unknown-host-2' }),
    (err) => {
      assert.equal(err.code, 'CLAUDE_REMOTE_CONFIG_INVALID');
      assert.equal(err.details?.field, 'WEBMCP_AI_CLAUDE_HOST');
      assert.equal(err.message.includes('super-secret-unknown-host-2'), false);
      return true;
    },
  );
});

test('resolveSshBin defaults to ssh and honors the operator/test override seam', () => {
  assert.equal(resolveSshBin({}), 'ssh');
  assert.equal(resolveSshBin({ WEBMCP_AI_SSH_BIN: '/opt/bin/ssh' }), '/opt/bin/ssh');
});

test('buildSshArgs returns an argv array only, never a shell string', () => {
  const args = buildSshArgs('mac-pro14');
  assert.ok(Array.isArray(args));
  for (const a of args) assert.equal(typeof a, 'string');
  assert.deepEqual(args, [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=6',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    'mac-pro14',
  ]);
  const custom = buildSshArgs('mac-pro14', { connectTimeoutSeconds: 3 });
  assert.ok(custom.includes('ConnectTimeout=3'));
});

// R4-FIX2: under concurrent load (many test files spawning Node subprocesses
// at once), a short probe budget can make even a *successful* fake-ssh spawn
// exceed its per-call timeout (perCallTimeoutMs = floor(timeoutMs/2)), which
// then maps to CLAUDE_REMOTE_UNREACHABLE/timeout and both fails the success
// test and silently "passes" the exit-code mapping tests below for the wrong
// reason. A generous, explicit budget lets the real path be exercised even on
// a loaded machine; the dedicated timeout test further down still proves the
// timeout path deliberately with its own small budget.
const GENEROUS_PROBE_TIMEOUT_MS = 30_000;

test('probeRemoteClaude succeeds and returns version + helpText via a fake ssh binary', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-probe-ok-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakeSsh = writeFakeSsh(dir);
  const env = { ...process.env, WEBMCP_AI_SSH_BIN: fakeSsh };
  const result = await probeRemoteClaude({ hostId: 'm1', env, timeoutMs: GENEROUS_PROBE_TIMEOUT_MS });
  assert.equal(result.available, true);
  assert.match(result.version, /2\.1\.283/);
  assert.match(result.helpText, /--disable-slash-commands/);
});

test('probeRemoteClaude maps a non-zero ssh exit to CLAUDE_REMOTE_UNREACHABLE without leaking stderr', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-probe-unreachable-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakeSsh = writeFakeSsh(dir);
  const env = { ...process.env, WEBMCP_AI_SSH_BIN: fakeSsh, FAKE_SSH_EXIT_CODE: '255' };
  await assert.rejects(
    () => probeRemoteClaude({ hostId: 'm1', env, timeoutMs: GENEROUS_PROBE_TIMEOUT_MS }),
    (err) => {
      assert.equal(err.code, 'CLAUDE_REMOTE_UNREACHABLE');
      assert.equal(err.details?.host, 'm1');
      // Must be the genuine exit-error path, not a timeout masquerading as
      // "some string reason" (see R4-FIX2 comment above).
      assert.equal(err.details?.reason, 'exit-error');
      const serialized = JSON.stringify(err.details ?? {});
      assert.equal(serialized.includes('secret-host-should-not-leak'), false);
      assert.equal(serialized.includes('secret-user'), false);
      assert.equal(err.message.includes('secret-host-should-not-leak'), false);
      return true;
    },
  );
});

test('probeRemoteClaude maps a missing ssh binary to CLAUDE_REMOTE_UNREACHABLE reason ssh-not-installed', async () => {
  const env = { ...process.env, WEBMCP_AI_SSH_BIN: '/definitely/missing/ssh-binary-does-not-exist' };
  await assert.rejects(
    () => probeRemoteClaude({ hostId: 'm1', env, timeoutMs: GENEROUS_PROBE_TIMEOUT_MS }),
    (err) => {
      assert.equal(err.code, 'CLAUDE_REMOTE_UNREACHABLE');
      assert.equal(err.details?.reason, 'ssh-not-installed');
      assert.equal(err.details?.host, 'm1');
      return true;
    },
  );
});

test('probeRemoteClaude maps a slow ssh call to CLAUDE_REMOTE_UNREACHABLE reason timeout', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-probe-timeout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakeSsh = writeFakeSsh(dir);
  // Deliberately small probe budget (perCallTimeoutMs = 750ms) against a fake
  // that sleeps well beyond it; runProcess kills the child at the per-call
  // timeout, so this resolves in well under a second, not the full 3000ms.
  const env = { ...process.env, WEBMCP_AI_SSH_BIN: fakeSsh, FAKE_SSH_SLEEP_MS: '3000' };
  await assert.rejects(
    () => probeRemoteClaude({ hostId: 'm1', env, timeoutMs: 1500 }),
    (err) => {
      assert.equal(err.code, 'CLAUDE_REMOTE_UNREACHABLE');
      assert.equal(err.details?.reason, 'timeout');
      assert.equal(err.details?.host, 'm1');
      return true;
    },
  );
});

test('readRemoteClaudeState never throws: match/drift/missing/unreachable', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakeSsh = writeFakeSsh(dir);

  const matched = await readRemoteClaudeState({
    hostId: 'm1', env: { ...process.env, WEBMCP_AI_SSH_BIN: fakeSsh }, pin: '2.1.283', timeoutMs: GENEROUS_PROBE_TIMEOUT_MS,
  });
  assert.deepEqual(matched, { state: 'match', installedVersion: '2.1.283', transport: 'ssh' });

  const drifted = await readRemoteClaudeState({
    hostId: 'm1',
    env: { ...process.env, WEBMCP_AI_SSH_BIN: fakeSsh, FAKE_SSH_VERSION: '2.1.200 (Claude Code)' },
    pin: '2.1.283',
    timeoutMs: GENEROUS_PROBE_TIMEOUT_MS,
  });
  assert.equal(drifted.state, 'drift');
  assert.equal(drifted.installedVersion, '2.1.200');
  assert.equal(drifted.transport, 'ssh');

  const unreachable = await readRemoteClaudeState({
    hostId: 'm1',
    env: { ...process.env, WEBMCP_AI_SSH_BIN: fakeSsh, FAKE_SSH_EXIT_CODE: '255' },
    pin: '2.1.283',
    timeoutMs: GENEROUS_PROBE_TIMEOUT_MS,
  });
  assert.deepEqual(unreachable, { state: 'unreachable', installedVersion: null, transport: 'ssh' });

  // A config-invalid env override (e.g. an unparseable sshHost override) must
  // also resolve to 'unreachable', never throw and never crash a plan.
  const configInvalid = await readRemoteClaudeState({
    hostId: 'm1',
    env: { ...process.env, WEBMCP_AI_SSH_BIN: fakeSsh, WEBMCP_AI_CLAUDE_SSH_ALIAS: 'bad host with spaces' },
    pin: '2.1.283',
    timeoutMs: GENEROUS_PROBE_TIMEOUT_MS,
  });
  assert.deepEqual(configInvalid, { state: 'unreachable', installedVersion: null, transport: 'ssh' });
});

test('probeRemoteClaude maps a help-call-only failure to CLAUDE_REMOTE_UNREACHABLE (version call already succeeded)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-probe-help-fail-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakeSsh = writeFakeSsh(dir);
  const env = { ...process.env, WEBMCP_AI_SSH_BIN: fakeSsh, FAKE_SSH_HELP_EXIT_CODE: '3' };
  await assert.rejects(
    () => probeRemoteClaude({ hostId: 'm1', env, timeoutMs: GENEROUS_PROBE_TIMEOUT_MS }),
    (err) => {
      assert.equal(err.code, 'CLAUDE_REMOTE_UNREACHABLE');
      assert.equal(err.details?.host, 'm1');
      // The version call succeeds; only the help call exits 3 -> exit-error,
      // not a timeout masquerading as the intended failure mode.
      assert.equal(err.details?.reason, 'exit-error');
      return true;
    },
  );
});

test('readRemoteClaudeState resolves state missing when the probed version has no semver token', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-state-missing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakeSsh = writeFakeSsh(dir);
  const missing = await readRemoteClaudeState({
    hostId: 'm1',
    env: { ...process.env, WEBMCP_AI_SSH_BIN: fakeSsh, FAKE_SSH_VERSION: 'unknown build, no version token here' },
    pin: '2.1.283',
    timeoutMs: GENEROUS_PROBE_TIMEOUT_MS,
  });
  assert.deepEqual(missing, { state: 'missing', installedVersion: null, transport: 'ssh' });
});
