import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { generate } from '../src/client.mjs';
import {
  computeWorkspaceFingerprint,
  mapWorkspaceToRemote,
  probeRemoteClaude,
  probeRemoteWorker,
  readRemoteClaudeState,
  resolveClaudeRemoteHost,
  runRemoteClaude,
  runRemoteFingerprint,
  verifyRemoteWorkspace,
} from '../src/remote.mjs';
import { review } from '../src/review.mjs';
import { isolateTmpdir } from './helpers/isolated-tmpdir.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_BIN = resolve(__dirname, '../scripts/claude-remote-worker.mjs');
const FAKE_CLAUDE_BIN = resolve(__dirname, 'fixtures/fake-ai-cli.mjs');
const FAKE_SSH_BIN = resolve(__dirname, 'fixtures/fake-ssh.mjs');

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  writeFileSync(join(dir, 'file.txt'), 'hello world\n', 'utf8');
  execFileSync('git', ['add', 'file.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir });
}

function writeFakeClaudeWithMarker(path, markerPath) {
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write('claude-cli 2.1.283\\n');
  process.exit(0);
}
if (args.includes('--help')) {
  process.stdout.write('-p --permission-mode --tools --disallowedTools --safe-mode --no-chrome --output-format json stream-json --verbose --no-session-persistence --disable-slash-commands --permission-prompts none --resume --fork-session --model --effort\\n');
  process.exit(0);
}
if (args.includes('-p')) {
  if (${JSON.stringify(markerPath)}) {
    writeFileSync(${JSON.stringify(markerPath)}, 'SPAWNED\\n', 'utf8');
  }
  const reply = process.env.FAKE_REPLY || 'reply:claude:ok';
  process.stdout.write(JSON.stringify({ result: reply, session_id: 'claude-session' }));
  process.exit(0);
}
process.exit(0);
`,
    'utf8',
  );
  chmodSync(path, 0o755);
}

// 1. Happy-path generate over "ssh"
test('1. Happy-path generate over ssh returns response and transport metadata', async (t) => {
  const tmp = isolateTmpdir(t, 'remote-happy-');
  const repoDir = join(tmp, 'repo');
  execFileSync('mkdir', ['-p', repoDir]);
  initGitRepo(repoDir);

  const env = {
    ...process.env,
    WEBMCP_AI_CLAUDE_HOST: 'm1',
    WEBMCP_AI_SSH_BIN: FAKE_SSH_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_BIN: FAKE_CLAUDE_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKER: WORKER_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: repoDir,
    WEBMCP_AI_CLAUDE_REMOTE_MAP: `${repoDir}=${repoDir}`,
    FAKE_PROVIDER: 'claude',
    FAKE_VERSION: '2.1.283',
    FAKE_SSH_VERSION: '2.1.283 (Claude Code)',
  };

  const res = await generate(
    {
      provider: 'claude',
      prompt: 'hello remote claude',
      workspace: repoDir,
      env,
    },
  );

  assert.equal(res.ok, true);
  assert.deepEqual(res.transport, { type: 'ssh', host: 'm1' });
  assert.match(res.response.text, /reply:claude:hello remote claude/);
});

// 2. Review lane over remote
test('2. Review lane over remote validates help probe and returns ssh transport', async (t) => {
  const tmp = isolateTmpdir(t, 'remote-review-');
  const repoDir = join(tmp, 'repo');
  execFileSync('mkdir', ['-p', repoDir]);
  initGitRepo(repoDir);

  const validReviewResult = JSON.stringify({
    schema: 'webmcp-ai-review-result/1',
    verdict: 'approve',
    summary: 'all good',
    findings: [],
  });

  const env = {
    ...process.env,
    WEBMCP_AI_CLAUDE_HOST: 'm1',
    WEBMCP_AI_SSH_BIN: FAKE_SSH_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_BIN: FAKE_CLAUDE_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKER: WORKER_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: repoDir,
    WEBMCP_AI_CLAUDE_REMOTE_MAP: `${repoDir}=${repoDir}`,
    FAKE_PROVIDER: 'claude',
    FAKE_VERSION: '2.1.283',
    FAKE_SSH_VERSION: '2.1.283 (Claude Code)',
    FAKE_REPLY: validReviewResult,
  };

  const res = await review(
    {
      provider: 'claude',
      prompt: 'review this code',
      workspace: repoDir,
      cwd: repoDir,
      env,
    },
  );

  assert.equal(res.ok, true);
  assert.equal(res.review.verdict, 'approve');
  assert.equal(res.review.schema, 'webmcp-ai-review-result/1');
  assert.deepEqual(res.transport, { type: 'ssh', host: 'm1' });
});

// 3. Workspace mismatch -> CLAUDE_REMOTE_WORKSPACE_MISMATCH and no model spawn
test('3. Workspace mismatch throws CLAUDE_REMOTE_WORKSPACE_MISMATCH and proves no model spawn', async (t) => {
  const tmp = isolateTmpdir(t, 'remote-mismatch-');
  const localRepo = join(tmp, 'local');
  const remoteRepo = join(tmp, 'remote');
  execFileSync('mkdir', ['-p', localRepo]);
  execFileSync('mkdir', ['-p', remoteRepo]);
  initGitRepo(localRepo);
  initGitRepo(remoteRepo);

  // Diverge the remote repository by making a second commit
  writeFileSync(join(remoteRepo, 'different.txt'), 'different remote content\n', 'utf8');
  execFileSync('git', ['add', 'different.txt'], { cwd: remoteRepo });
  execFileSync('git', ['commit', '-m', 'remote extra commit'], { cwd: remoteRepo });

  const markerFile = join(tmp, 'model-spawned.marker');
  const fakeClaudeBin = join(tmp, 'fake-claude-marker.mjs');
  writeFakeClaudeWithMarker(fakeClaudeBin, markerFile);

  const env = {
    ...process.env,
    WEBMCP_AI_CLAUDE_HOST: 'm1',
    WEBMCP_AI_SSH_BIN: FAKE_SSH_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_BIN: fakeClaudeBin,
    WEBMCP_AI_CLAUDE_REMOTE_WORKER: WORKER_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: remoteRepo,
    WEBMCP_AI_CLAUDE_REMOTE_MAP: `${localRepo}=${remoteRepo}`,
    FAKE_SSH_VERSION: '2.1.283 (Claude Code)',
  };

  await assert.rejects(
    () =>
      generate({
        provider: 'claude',
        prompt: 'implement something',
        workspace: localRepo,
        taskIntent: 'implement',
        accessProfile: 'full',
        env,
      }),
    (err) => {
      assert.equal(err.code, 'CLAUDE_REMOTE_WORKSPACE_MISMATCH');
      assert.equal(err.details?.host, 'm1');
      assert.ok(err.details?.local);
      assert.ok(err.details?.remote);
      assert.notDeepEqual(err.details.local, err.details.remote);
      return true;
    },
  );

  // Assert the model binary was NEVER spawned
  assert.equal(existsSync(markerFile), false, 'fake claude marker must not exist; model was never spawned');
});

// 4. No local fallback: remote selected + FAKE_SSH_MODE=unreachable + local claude fixture present
test('4. Remote unreachable never falls back to local Claude binary', async (t) => {
  const tmp = isolateTmpdir(t, 'remote-nofallback-');
  const repoDir = join(tmp, 'repo');
  execFileSync('mkdir', ['-p', repoDir]);
  initGitRepo(repoDir);

  const localMarkerFile = join(tmp, 'local-claude-spawned.marker');
  const localFakeClaude = join(tmp, 'local-fake-claude.mjs');
  writeFakeClaudeWithMarker(localFakeClaude, localMarkerFile);

  const env = {
    ...process.env,
    CLAUDE_BIN: localFakeClaude,
    WEBMCP_AI_CLAUDE_HOST: 'm1',
    WEBMCP_AI_SSH_BIN: FAKE_SSH_BIN,
    FAKE_SSH_MODE: 'unreachable',
    WEBMCP_AI_CLAUDE_REMOTE_BIN: FAKE_CLAUDE_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKER: WORKER_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: repoDir,
    WEBMCP_AI_CLAUDE_REMOTE_MAP: `${repoDir}=${repoDir}`,
  };

  await assert.rejects(
    () =>
      generate({
        provider: 'claude',
        prompt: 'test prompt',
        workspace: repoDir,
        env,
      }),
    (err) => {
      assert.equal(err.code, 'CLAUDE_REMOTE_UNREACHABLE');
      return true;
    },
  );

  assert.equal(existsSync(localMarkerFile), false, 'local Claude binary was NEVER spawned on remote failure');
});

// 5. Timeout: fake claude sleeps, worker kills it -> PROVIDER_TIMEOUT
test('5. Remote timeout results in typed PROVIDER_TIMEOUT with ssh transport details', async (t) => {
  const tmp = isolateTmpdir(t, 'remote-timeout-');
  const repoDir = join(tmp, 'repo');
  execFileSync('mkdir', ['-p', repoDir]);
  initGitRepo(repoDir);

  const env = {
    ...process.env,
    WEBMCP_AI_CLAUDE_HOST: 'm1',
    WEBMCP_AI_SSH_BIN: FAKE_SSH_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_BIN: FAKE_CLAUDE_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKER: WORKER_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: repoDir,
    WEBMCP_AI_CLAUDE_REMOTE_MAP: `${repoDir}=${repoDir}`,
    FAKE_PROVIDER: 'claude',
    FAKE_VERSION: '2.1.283',
    FAKE_SSH_VERSION: '2.1.283 (Claude Code)',
    FAKE_DELAY_MS: '2000',
  };

  await assert.rejects(
    () =>
      generate({
        provider: 'claude',
        prompt: 'sleepy prompt',
        workspace: repoDir,
        timeoutMs: 400,
        env,
      }),
    (err) => {
      assert.equal(err.code, 'PROVIDER_TIMEOUT');
      assert.equal(err.details?.transport, 'ssh');
      assert.equal(err.details?.host, 'm1');
      return true;
    },
  );
});

// 6. Cancellation: AbortSignal mid-run kills ssh and remote child
test('6. AbortSignal aborts remote invocation and kills process', async (t) => {
  const tmp = isolateTmpdir(t, 'remote-abort-');
  const repoDir = join(tmp, 'repo');
  execFileSync('mkdir', ['-p', repoDir]);
  initGitRepo(repoDir);

  const env = {
    ...process.env,
    WEBMCP_AI_CLAUDE_HOST: 'm1',
    WEBMCP_AI_SSH_BIN: FAKE_SSH_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_BIN: FAKE_CLAUDE_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKER: WORKER_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: repoDir,
    WEBMCP_AI_CLAUDE_REMOTE_MAP: `${repoDir}=${repoDir}`,
    FAKE_PROVIDER: 'claude',
    FAKE_VERSION: '2.1.283',
    FAKE_SSH_VERSION: '2.1.283 (Claude Code)',
    FAKE_DELAY_MS: '5000',
  };

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);

  await assert.rejects(
    () =>
      generate({
        provider: 'claude',
        prompt: 'abort me',
        workspace: repoDir,
        signal: controller.signal,
        env,
      }),
    (err) => {
      assert.equal(err.code, 'PROVIDER_ABORTED');
      return true;
    },
  );
});

// 7. Injection refusal and bounds
test('7. Injection attempts fail closed with bounded errors', async (t) => {
  const tmp = isolateTmpdir(t, 'remote-inject-');
  const repoDir = join(tmp, 'repo');
  execFileSync('mkdir', ['-p', repoDir]);
  initGitRepo(repoDir);

  // Hostile override path
  const hostileEnv = {
    ...process.env,
    WEBMCP_AI_CLAUDE_HOST: 'm1',
    WEBMCP_AI_CLAUDE_REMOTE_BIN: '/bin/sh; rm -rf /',
  };
  await assert.rejects(
    () => generate({ provider: 'claude', prompt: 'test', workspace: repoDir, env: hostileEnv }),
    (err) => {
      assert.equal(err.code, 'CLAUDE_REMOTE_CONFIG_INVALID');
      assert.equal(err.message.includes('rm -rf'), false);
      return true;
    },
  );

  // Worker refusal on disallowed flags
  const workerRefusalEnv = {
    ...process.env,
    WEBMCP_AI_CLAUDE_HOST: 'm1',
    WEBMCP_AI_SSH_BIN: FAKE_SSH_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_BIN: FAKE_CLAUDE_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKER: WORKER_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: repoDir,
  };
  await assert.rejects(
    () =>
      runRemoteClaude({
        hostId: 'm1',
        env: workerRefusalEnv,
        args: ['-p', '--dangerously-skip-permissions'],
        prompt: 'test',
        cwd: repoDir,
      }),
    (err) => {
      assert.equal(err.code, 'CLAUDE_REMOTE_WORKER_ERROR');
      return true;
    },
  );

  // Prompt with newlines and UTF-8 round-trips intact
  const complexPrompt = 'Line 1: 🚀 Special\nLine 2: 日本語 UTF-8\nLine 3: \\"escaped\\"';
  const goodEnv = {
    ...process.env,
    WEBMCP_AI_CLAUDE_HOST: 'm1',
    WEBMCP_AI_SSH_BIN: FAKE_SSH_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_BIN: FAKE_CLAUDE_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKER: WORKER_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: repoDir,
    WEBMCP_AI_CLAUDE_REMOTE_MAP: `${repoDir}=${repoDir}`,
    FAKE_PROVIDER: 'claude',
    FAKE_VERSION: '2.1.283',
    FAKE_SSH_VERSION: '2.1.283 (Claude Code)',
  };

  const res = await generate({ provider: 'claude', prompt: complexPrompt, workspace: repoDir, env: goodEnv });
  assert.equal(res.ok, true);
  assert.ok(res.response.text.includes(complexPrompt));
});

// 8. Fingerprint equality: local computeWorkspaceFingerprint === worker --mode fingerprint
test('8. Local computeWorkspaceFingerprint matches remote worker fingerprint byte-for-byte', async (t) => {
  const tmp = isolateTmpdir(t, 'remote-fp-eq-');
  const repoDir = join(tmp, 'repo');
  execFileSync('mkdir', ['-p', repoDir]);
  initGitRepo(repoDir);

  // Add an untracked file to exercise the untracked digest computation
  writeFileSync(join(repoDir, 'untracked.js'), 'console.log("untracked");\n', 'utf8');

  const localFp = computeWorkspaceFingerprint(repoDir);

  const env = {
    ...process.env,
    WEBMCP_AI_CLAUDE_HOST: 'm1',
    WEBMCP_AI_SSH_BIN: FAKE_SSH_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_BIN: FAKE_CLAUDE_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKER: WORKER_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: repoDir,
  };

  const remoteFp = await runRemoteFingerprint({
    hostId: 'm1',
    env,
    cwd: repoDir,
  });

  assert.equal(localFp.nonGit, false);
  assert.equal(remoteFp.nonGit, false);
  assert.equal(localFp.head, remoteFp.head);
  assert.equal(localFp.tree, remoteFp.tree);
  assert.equal(localFp.statusDigest, remoteFp.statusDigest);
  assert.equal(localFp.diffDigest, remoteFp.diffDigest);
  assert.equal(localFp.untrackedCount, remoteFp.untrackedCount);
  assert.equal(localFp.untrackedDigest, remoteFp.untrackedDigest);

  // Non-git directory check
  const emptyDir = join(tmp, 'empty-nongit');
  execFileSync('mkdir', ['-p', emptyDir]);
  const localNonGit = computeWorkspaceFingerprint(emptyDir);
  const remoteNonGit = await runRemoteFingerprint({
    hostId: 'm1',
    env: { ...env, WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: emptyDir },
    cwd: emptyDir,
  });
  assert.equal(localNonGit.nonGit, true);
  assert.equal(remoteNonGit.nonGit, true);
});

// 9. Compose-only over remote
test('9. Compose mode over remote operates without workspace requirement and cleans up', async (t) => {
  const env = {
    ...process.env,
    WEBMCP_AI_CLAUDE_HOST: 'm1',
    WEBMCP_AI_SSH_BIN: FAKE_SSH_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_BIN: FAKE_CLAUDE_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKER: WORKER_BIN,
    FAKE_PROVIDER: 'claude',
    FAKE_VERSION: '2.1.283',
    FAKE_SSH_VERSION: '2.1.283 (Claude Code)',
  };

  const res = await generate({
    provider: 'claude',
    prompt: 'compose something',
    taskIntent: 'compose',
    accessProfile: 'compose-only',
    env,
  });

  assert.equal(res.ok, true);
  assert.deepEqual(res.transport, { type: 'ssh', host: 'm1' });
  assert.match(res.response.text, /reply:claude:compose something/);
});

// 10. Privacy & security hygiene: no sensitive paths or usernames leak in errors
test('10. Errors never leak sensitive paths, usernames, or secrets', async (t) => {
  const sensitiveUser = 'uyenuyen';
  const sensitivePath = `/Users/${sensitiveUser}/secret-folder`;

  const env = {
    ...process.env,
    WEBMCP_AI_CLAUDE_HOST: 'm1',
    WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: `${sensitivePath}/..`,
  };

  try {
    resolveClaudeRemoteHost('m1', env);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'CLAUDE_REMOTE_CONFIG_INVALID');
    assert.equal(err.message.includes(sensitiveUser), false);
    assert.equal(err.message.includes('/Users/'), false);
    const detailsStr = JSON.stringify(err.details || {});
    assert.equal(detailsStr.includes(sensitiveUser), false);
    assert.equal(detailsStr.includes('/Users/'), false);
  }
});

// 11. Truncated worker output at exit 0 fails closed with PROVIDER_OUTPUT_LIMIT
test('11. Truncated remote run output rejects with PROVIDER_OUTPUT_LIMIT', async (t) => {
  const tmp = isolateTmpdir(t, 'remote-trunc-');
  const fakeWorker = join(tmp, 'fake-trunc-worker.mjs');
  writeFileSync(
    fakeWorker,
    `#!/usr/bin/env node
const truncated = { stdout: process.env.FAKE_TRUNCATE_STDOUT === '1', stderr: process.env.FAKE_TRUNCATE_STDERR === '1' };
process.stdout.write(JSON.stringify({
  schema: 'webmcp-ai-claude-remote-response/1',
  mode: 'run',
  exitCode: 0,
  signal: null,
  stdout: 'ok-output',
  stderr: '',
  timedOut: false,
  truncated,
}) + '\\n');
`,
    'utf8',
  );
  chmodSync(fakeWorker, 0o755);

  const baseEnv = {
    ...process.env,
    WEBMCP_AI_SSH_BIN: FAKE_SSH_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_BIN: FAKE_CLAUDE_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKER: fakeWorker,
    WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: tmp,
  };

  // exitCode 0 + truncated stdout -> typed PROVIDER_OUTPUT_LIMIT
  await assert.rejects(
    () => runRemoteClaude({
      hostId: 'm1',
      env: { ...baseEnv, FAKE_TRUNCATE_STDOUT: '1' },
      args: ['-p', 'hi'],
      prompt: 'hi',
      cwd: tmp,
    }),
    (err) => {
      assert.equal(err.code, 'PROVIDER_OUTPUT_LIMIT');
      assert.equal(err.details?.transport, 'ssh');
      assert.equal(err.details?.host, 'm1');
      assert.equal(err.details?.stdout, true);
      assert.equal(err.details?.stderr, false);
      return true;
    },
  );

  // exitCode 0 + truncated stderr -> same typed error naming stderr
  await assert.rejects(
    () => runRemoteClaude({
      hostId: 'm1',
      env: { ...baseEnv, FAKE_TRUNCATE_STDERR: '1' },
      args: ['-p', 'hi'],
      prompt: 'hi',
      cwd: tmp,
    }),
    (err) => {
      assert.equal(err.code, 'PROVIDER_OUTPUT_LIMIT');
      assert.equal(err.details?.stdout, false);
      assert.equal(err.details?.stderr, true);
      assert.match(err.message, /stderr/);
      return true;
    },
  );

  // Untruncated exit-0 response still resolves normally.
  const res = await runRemoteClaude({
    hostId: 'm1',
    env: baseEnv,
    args: ['-p', 'hi'],
    prompt: 'hi',
    cwd: tmp,
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, 'ok-output');
});

// 12. Null==null digests (untracked file >1 MiB on both sides) fail closed
test('12. Unverifiable fingerprint (oversize untracked file) rejects instead of matching null==null', async (t) => {
  const tmp = isolateTmpdir(t, 'remote-unverifiable-');
  const repoDir = join(tmp, 'repo');
  execFileSync('mkdir', ['-p', repoDir]);
  initGitRepo(repoDir);

  // An untracked file above the 1 MiB cutoff makes untrackedDigest null.
  writeFileSync(join(repoDir, 'big-untracked.bin'), Buffer.alloc(1024 * 1024 + 1, 0x61));

  const localFp = computeWorkspaceFingerprint(repoDir);
  assert.equal(localFp.untrackedDigest, null);

  const env = {
    ...process.env,
    WEBMCP_AI_SSH_BIN: FAKE_SSH_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_BIN: FAKE_CLAUDE_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKER: WORKER_BIN,
    WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: repoDir,
  };

  await assert.rejects(
    () => verifyRemoteWorkspace({ hostId: 'm1', env, localDir: repoDir, remoteDir: repoDir }),
    (err) => {
      assert.equal(err.code, 'CLAUDE_REMOTE_WORKSPACE_MISMATCH');
      assert.equal(err.details?.reason, 'unverifiable-fingerprint');
      assert.ok(err.details?.localNull.includes('untrackedDigest'));
      assert.ok(err.details?.remoteNull.includes('untrackedDigest'));
      return true;
    },
  );
});

// 13. Crafted remote fingerprints: null digest fails closed, equal passes, differing mismatches
test('13. verifyRemoteWorkspace fails closed on null digests but passes equal fingerprints', async (t) => {
  const tmp = isolateTmpdir(t, 'remote-fp-verify-');
  const repoDir = join(tmp, 'repo');
  execFileSync('mkdir', ['-p', repoDir]);
  initGitRepo(repoDir);

  const localFp = computeWorkspaceFingerprint(repoDir);

  async function verifyAgainst(remoteFp) {
    const fakeWorker = join(tmp, `fake-fp-worker-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(fakeWorker, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(remoteFp))} + '\\n');\n`, 'utf8');
    chmodSync(fakeWorker, 0o755);
    const env = {
      ...process.env,
      WEBMCP_AI_SSH_BIN: FAKE_SSH_BIN,
      WEBMCP_AI_CLAUDE_REMOTE_BIN: FAKE_CLAUDE_BIN,
      WEBMCP_AI_CLAUDE_REMOTE_WORKER: fakeWorker,
      WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE: repoDir,
    };
    return verifyRemoteWorkspace({ hostId: 'm1', env, localDir: repoDir, remoteDir: repoDir });
  }

  // Null statusDigest on the remote side -> unverifiable-fingerprint.
  await assert.rejects(
    () => verifyAgainst({ ...localFp, statusDigest: null }),
    (err) => {
      assert.equal(err.code, 'CLAUDE_REMOTE_WORKSPACE_MISMATCH');
      assert.equal(err.details?.reason, 'unverifiable-fingerprint');
      assert.ok(err.details?.remoteNull.includes('statusDigest'));
      return true;
    },
  );

  // Null diffDigest on the remote side -> same fail-closed path.
  await assert.rejects(
    () => verifyAgainst({ ...localFp, diffDigest: null }),
    (err) => {
      assert.equal(err.code, 'CLAUDE_REMOTE_WORKSPACE_MISMATCH');
      assert.equal(err.details?.reason, 'unverifiable-fingerprint');
      return true;
    },
  );

  // Genuine value difference -> the existing mismatch path (no unverifiable reason).
  await assert.rejects(
    () => verifyAgainst({ ...localFp, head: '0'.repeat(40) }),
    (err) => {
      assert.equal(err.code, 'CLAUDE_REMOTE_WORKSPACE_MISMATCH');
      assert.equal(err.details?.reason, undefined);
      assert.ok(err.details?.local);
      assert.ok(err.details?.remote);
      return true;
    },
  );

  // Equal normal fingerprints still pass.
  const ok = await verifyAgainst({ ...localFp });
  assert.equal(ok.ok, true);
});
