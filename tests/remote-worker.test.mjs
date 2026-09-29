import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isolateTmpdir } from './helpers/isolated-tmpdir.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_BIN = resolve(__dirname, '../scripts/claude-remote-worker.mjs');
const FAKE_CLAUDE_BIN = resolve(__dirname, 'fixtures/fake-ai-cli.mjs');

function runWorker(args, stdinPayload, env = {}) {
  const res = spawnSync(process.execPath, [WORKER_BIN, ...args], {
    input: typeof stdinPayload === 'string' ? stdinPayload : (stdinPayload ? JSON.stringify(stdinPayload) : undefined),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return res;
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  writeFileSync(join(dir, 'file.txt'), 'hello world\n', 'utf8');
  execFileSync('git', ['add', 'file.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir });
}

test('claude-remote-worker --mode selftest returns probe details', () => {
  const res = runWorker(['--mode', 'selftest', '--claude-bin', FAKE_CLAUDE_BIN]);
  assert.equal(res.status, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.node, process.version);
  assert.equal(data.claudeBin, FAKE_CLAUDE_BIN);
  assert.equal(data.claudeVersion, '9.9.9');
});

test('claude-remote-worker --mode fingerprint computes repository digest', (t) => {
  const tmp = isolateTmpdir(t, 'worker-fp-git-');
  const repoDir = join(tmp, 'repo');
  execFileSync('mkdir', ['-p', repoDir]);
  initGitRepo(repoDir);

  const res = runWorker(['--mode', 'fingerprint'], {
    schema: 'webmcp-ai-claude-remote-request/1',
    mode: 'fingerprint',
    cwd: repoDir,
    workspaceRoot: repoDir,
  });

  assert.equal(res.status, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.nonGit, false);
  assert.equal(typeof data.head, 'string');
  assert.equal(data.head.length, 40);
  assert.equal(typeof data.tree, 'string');
  assert.equal(typeof data.statusDigest, 'string');
  assert.equal(typeof data.diffDigest, 'string');
  assert.equal(data.untrackedCount, 0);
  assert.equal(typeof data.untrackedDigest, 'string');
});

test('claude-remote-worker --mode fingerprint handles untracked files > 1 MiB', (t) => {
  const tmp = isolateTmpdir(t, 'worker-fp-large-');
  const repoDir = join(tmp, 'repo');
  execFileSync('mkdir', ['-p', repoDir]);
  initGitRepo(repoDir);

  // Create an untracked file larger than 1 MiB
  const largeBuf = Buffer.alloc(1024 * 1024 + 16, 0x61);
  writeFileSync(join(repoDir, 'large.bin'), largeBuf);

  const res = runWorker(['--mode', 'fingerprint'], {
    schema: 'webmcp-ai-claude-remote-request/1',
    mode: 'fingerprint',
    cwd: repoDir,
    workspaceRoot: repoDir,
  });

  assert.equal(res.status, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.nonGit, false);
  assert.equal(data.untrackedCount, 1);
  assert.equal(data.untrackedDigest, null);
});

test('claude-remote-worker --mode fingerprint returns nonGit:true outside a git repository', (t) => {
  const tmp = isolateTmpdir(t, 'worker-fp-nongit-');
  const nonGitDir = join(tmp, 'empty');
  execFileSync('mkdir', ['-p', nonGitDir]);

  const res = runWorker(['--mode', 'fingerprint'], {
    schema: 'webmcp-ai-claude-remote-request/1',
    mode: 'fingerprint',
    cwd: nonGitDir,
    workspaceRoot: nonGitDir,
  });

  assert.equal(res.status, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.nonGit, true);
});

test('claude-remote-worker --mode fingerprint enforces containment under workspaceRoot', (t) => {
  const tmp = isolateTmpdir(t, 'worker-fp-contain-');
  const root = join(tmp, 'root');
  const other = join(tmp, 'outside');
  execFileSync('mkdir', ['-p', root]);
  execFileSync('mkdir', ['-p', other]);

  const res = runWorker(['--mode', 'fingerprint'], {
    schema: 'webmcp-ai-claude-remote-request/1',
    mode: 'fingerprint',
    cwd: other,
    workspaceRoot: root,
  });

  assert.equal(res.status, 64);
  assert.match(res.stderr, /contained under workspaceRoot/);
});

test('claude-remote-worker --mode run executes claude and returns structured envelope', (t) => {
  const tmp = isolateTmpdir(t, 'worker-run-ok-');
  const ws = join(tmp, 'ws');
  execFileSync('mkdir', ['-p', ws]);

  const res = runWorker(
    ['--mode', 'run', '--claude-bin', FAKE_CLAUDE_BIN],
    {
      schema: 'webmcp-ai-claude-remote-request/1',
      mode: 'run',
      args: ['-p', '--safe-mode', '--no-chrome', '--output-format', 'json', '--no-session-persistence'],
      prompt: 'hello from worker test',
      cwd: ws,
      workspaceRoot: ws,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
      env: {},
    },
    { FAKE_PROVIDER: 'claude' },
  );

  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'must output exactly one JSON line');
  const data = JSON.parse(lines[0]);
  assert.equal(data.schema, 'webmcp-ai-claude-remote-response/1');
  assert.equal(data.mode, 'run');
  assert.equal(data.exitCode, 0);
  assert.equal(data.timedOut, false);
  assert.match(data.stdout, /hello from worker test/);
});

test('claude-remote-worker --mode run rejects dangerous or unknown flags with exit 64', (t) => {
  const tmp = isolateTmpdir(t, 'worker-run-flags-');
  const ws = join(tmp, 'ws');
  execFileSync('mkdir', ['-p', ws]);

  const dangerousFlags = [
    '--dangerously-skip-permissions',
    '--settings',
    '--mcp-config',
    '--add-dir',
    '--agents',
    '--plugin-dir',
    '--continue',
    '-c',
    '--unknown-flag',
    'bare-token-without-flag',
  ];

  for (const flag of dangerousFlags) {
    const res = runWorker(
      ['--mode', 'run', '--claude-bin', FAKE_CLAUDE_BIN],
      {
        schema: 'webmcp-ai-claude-remote-request/1',
        mode: 'run',
        args: ['-p', flag, 'sensitive-value-should-not-leak'],
        prompt: 'test',
        cwd: ws,
        workspaceRoot: ws,
        timeoutMs: 5000,
        maxOutputBytes: 1024 * 1024,
        env: {},
      },
    );

    assert.equal(res.status, 64, `flag ${flag} should cause exit 64`);
    assert.doesNotMatch(res.stderr, /sensitive-value-should-not-leak/);
  }
});

test('claude-remote-worker --mode run compose mode (cwd:null) creates and cleans up temp directory', (t) => {
  const tmp = isolateTmpdir(t, 'worker-compose-clean-');
  const tmpBefore = readdirSync(tmp).filter((f) => f.startsWith('webmcp-ai-claude-remote-worker-compose-'));

  const res = runWorker(
    ['--mode', 'run', '--claude-bin', FAKE_CLAUDE_BIN],
    {
      schema: 'webmcp-ai-claude-remote-request/1',
      mode: 'run',
      args: ['-p', '--safe-mode', '--no-chrome', '--output-format', 'json', '--no-session-persistence'],
      prompt: 'compose test',
      cwd: null,
      workspaceRoot: '/tmp',
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
      env: {},
    },
    { FAKE_PROVIDER: 'claude', FAKE_REPLY_CWD: '1', TMPDIR: tmp },
  );

  assert.equal(res.status, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.exitCode, 0);
  assert.match(data.stdout, /webmcp-ai-claude-remote-worker-compose-/);

  // Verify that the created compose directory was cleaned up
  const tmpAfter = readdirSync(tmp).filter((f) => f.startsWith('webmcp-ai-claude-remote-worker-compose-'));
  assert.equal(tmpAfter.length, tmpBefore.length, 'compose temp directory must be removed in finally');
});

test('claude-remote-worker --mode run strips prohibited environment variables', (t) => {
  const tmp = isolateTmpdir(t, 'worker-run-env-');
  const ws = join(tmp, 'ws');
  execFileSync('mkdir', ['-p', ws]);

  const res = runWorker(
    ['--mode', 'run', '--claude-bin', FAKE_CLAUDE_BIN],
    {
      schema: 'webmcp-ai-claude-remote-request/1',
      mode: 'run',
      args: ['-p', '--safe-mode', '--no-chrome', '--output-format', 'json', '--no-session-persistence'],
      prompt: 'env test',
      cwd: ws,
      workspaceRoot: ws,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
      env: {
        WEBMCP_LEAK: 'leak1',
        ANTHROPIC_API_KEY: 'leak2',
        MY_SECRET_TOKEN: 'leak3',
        SSH_AUTH_SOCK: 'leak4',
        CUSTOM_SAFE_VAR: 'safe-value',
      },
    },
    {
      FAKE_PROVIDER: 'claude',
      FAKE_ECHO_ENV: 'WEBMCP_LEAK,ANTHROPIC_API_KEY,MY_SECRET_TOKEN,SSH_AUTH_SOCK,CUSTOM_SAFE_VAR',
    },
  );

  assert.equal(res.status, 0);
  const data = JSON.parse(res.stdout);
  assert.doesNotMatch(data.stdout, /leak1/);
  assert.doesNotMatch(data.stdout, /leak2/);
  assert.doesNotMatch(data.stdout, /leak3/);
  assert.doesNotMatch(data.stdout, /leak4/);
});

test('claude-remote-worker --mode run enforces maxOutputBytes and flags truncation', (t) => {
  const tmp = isolateTmpdir(t, 'worker-run-trunc-');
  const ws = join(tmp, 'ws');
  execFileSync('mkdir', ['-p', ws]);

  const res = runWorker(
    ['--mode', 'run', '--claude-bin', FAKE_CLAUDE_BIN],
    {
      schema: 'webmcp-ai-claude-remote-request/1',
      mode: 'run',
      args: ['-p', '--safe-mode', '--no-chrome', '--output-format', 'json', '--no-session-persistence'],
      prompt: 'x'.repeat(2000),
      cwd: ws,
      workspaceRoot: ws,
      timeoutMs: 10_000,
      maxOutputBytes: 100,
      env: {},
    },
    { FAKE_PROVIDER: 'claude' },
  );

  assert.equal(res.status, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.truncated.stdout, true);
  assert.ok(Buffer.byteLength(data.stdout, 'utf8') <= 100);
});

test('claude-remote-worker --mode run handles child timeout with SIGTERM/SIGKILL', (t) => {
  const tmp = isolateTmpdir(t, 'worker-run-timeout-');
  const ws = join(tmp, 'ws');
  execFileSync('mkdir', ['-p', ws]);

  const res = runWorker(
    ['--mode', 'run', '--claude-bin', FAKE_CLAUDE_BIN],
    {
      schema: 'webmcp-ai-claude-remote-request/1',
      mode: 'run',
      args: ['-p', '--safe-mode', '--no-chrome', '--output-format', 'json', '--no-session-persistence'],
      prompt: 'timeout test',
      cwd: ws,
      workspaceRoot: ws,
      timeoutMs: 500,
      maxOutputBytes: 1024 * 1024,
      env: {},
    },
    { FAKE_PROVIDER: 'claude', FAKE_DELAY_MS: '2000' },
  );

  assert.equal(res.status, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.timedOut, true);
});
