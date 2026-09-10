import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { describeTools, handleToolCall, TOOL_PROTOCOL } from '../src/protocol.mjs';
import { describeReviewDryRun, review } from '../src/review.mjs';
import { validateReviewResult } from '../src/review-result.mjs';

const fakeBin = fileURLToPath(new URL('./fixtures/fake-ai-cli.mjs', import.meta.url));
const bin = fileURLToPath(new URL('../bin/webmcp-ai.mjs', import.meta.url));
chmodSync(fakeBin, 0o755);

function makeReviewFake(t, verdict = 'approve') {
  const dir = mkdtempSync(join(tmpdir(), 'webmcp-ai-review-fake-'));
  const fake = join(dir, 'fake-review.mjs');
  const base = { schema: 'webmcp-ai-review-result/1', verdict, summary: 'ok-fixture' };
  if (verdict === 'blocked') base.blockedReason = 'fixture-blocked';
  const payload = JSON.stringify(base);
  writeFileSync(fake, [
    '#!/usr/bin/env node',
    "import { readFileSync, writeFileSync } from 'node:fs';",
    `const payload = ${JSON.stringify(payload)};`,
    'const args = process.argv.slice(2);',
    'if (args.includes("--version")) { process.stdout.write("fake-cli 9.9.9\\n"); process.exit(0); }',
    'if (args.includes("--help")) {',
    '  const p = process.env.FAKE_PROVIDER || "opencode";',
    '  if (p === "codex") { process.stdout.write("codex exec --sandbox read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --output-last-message --color resume -c, --config sandbox_mode\\n"); process.exit(0); }',
    '  if (p === "opencode") { process.stdout.write("opencode run --format json --agent build --dir /ws --model sonnet --variant effort\\n"); process.exit(0); }',
    '  process.stdout.write("-p --permission-mode --tools --disallowedTools --safe-mode --no-chrome --output-format json stream-json --verbose --no-session-persistence --resume --model --effort\\n"); process.exit(0);',
    '}',
    'const outIdx = args.indexOf("--output-last-message");',
    // codex path: write payload to the output file
    'if (outIdx >= 0) { writeFileSync(args[outIdx + 1], payload); process.stdout.write("{\\"type\\":\\"completed\\"}\\n"); process.exit(0); }',
    // claude path: JSON with result
    'if (process.env.FAKE_PROVIDER === "claude") { process.stdout.write(JSON.stringify({ result: payload, session_id: "s1" })); process.exit(0); }',
    // opencode path: NDJSON text event carrying the payload
    'if (process.env.FAKE_PROVIDER === "opencode") {',
    '  const line = JSON.stringify({ type: "text", sessionID: "ses_test", part: { type: "text", text: payload } });',
    '  process.stdout.write(line + "\\n"); process.exit(0);',
    '}',
    'process.stdout.write(payload);',
    '',
  ].join('\n'));
  chmodSync(fake, 0o755);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return fake;
}

test('review() with plain-text provider output is typed REVIEW_RESULT_INCOMPLETE', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'review-incomplete-'));
  try {
    await assert.rejects(
      review({
        provider: 'opencode',
        prompt: 'review this diff',
        taskIntent: 'review',
        accessProfile: 'review-readonly',
        workspace: ws,
        allowedReadRoots: [ws],
        env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' },
      }),
      (e) => e.code === 'REVIEW_RESULT_INCOMPLETE',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('generate and ai.generate cannot bypass the review result contract', async () => {
  const { generate } = await import('../src/client.mjs');
  const ws = mkdtempSync(join(tmpdir(), 'generate-review-contract-'));
  try {
    await assert.rejects(
      generate({
        provider: 'opencode',
        prompt: 'review this diff',
        taskIntent: 'review',
        accessProfile: 'review-readonly',
        workspace: ws,
        env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' },
      }),
      (error) => error.code === 'REVIEW_RESULT_INCOMPLETE',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('review() with valid review-result JSON returns the verdict', async (t) => {
  const fake = makeReviewFake(t, 'approve');
  const ws = mkdtempSync(join(tmpdir(), 'review-ok-'));
  try {
    const result = await review({
      provider: 'opencode',
      prompt: 'review this diff',
      taskIntent: 'review',
      workspace: ws,
      allowedReadRoots: [ws],
      env: { ...process.env, OPENCODE_BIN: fake, FAKE_PROVIDER: 'opencode' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.review.verdict, 'approve');
    assert.equal(result.review.schema, 'webmcp-ai-review-result/1');
    assert.equal(result.capability.accessProfile, 'review-readonly');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('review() plan-only fixture is typed REVIEW_RESULT_INCOMPLETE', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'review-planonly-'));
  const fake = join(dir, 'fake-plan.mjs');
  writeFileSync(fake, [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    'if (args.includes("--version")) { process.stdout.write("fake-cli 9.9.9\\n"); process.exit(0); }',
    'if (args.includes("--help")) { process.stdout.write("opencode run --format json --agent build --dir /ws --model sonnet --variant effort\\n"); process.exit(0); }',
    'const line = JSON.stringify({ type: "text", sessionID: "ses_test", part: { type: "text", text: JSON.stringify({ plan: "do things" }) } });',
    'process.stdout.write(line + "\\n");',
    '',
  ].join('\n'));
  chmodSync(fake, 0o755);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = mkdtempSync(join(tmpdir(), 'review-plan-ws-'));
  try {
    await assert.rejects(
      review({
        provider: 'opencode',
        prompt: 'review this',
        taskIntent: 'review',
        workspace: ws,
        env: { ...process.env, OPENCODE_BIN: fake, FAKE_PROVIDER: 'opencode' },
      }),
      (e) => e.code === 'REVIEW_RESULT_INCOMPLETE',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('ai.review tool-call succeeds with verdict and stays protocol-shaped on failure', async (t) => {
  const fake = makeReviewFake(t, 'request-changes');
  const ws = mkdtempSync(join(tmpdir(), 'review-tool-'));
  try {
    const ok = await handleToolCall({
      protocol: TOOL_PROTOCOL,
      requestId: 'rev-1',
      tool: 'ai.review',
      input: { provider: 'opencode', prompt: 'review me', workspace: ws, taskIntent: 'review' },
    }, { env: { ...process.env, OPENCODE_BIN: fake, FAKE_PROVIDER: 'opencode' } });
    assert.equal(ok.ok, true);
    assert.equal(ok.protocol, 'webmcp-tool-v1');
    assert.equal(ok.output.verdict, 'request-changes');
    assert.equal(ok.metadata.review.verdict, 'request-changes');
    // forbidden generate-only fields fail closed
    await assert.rejects(
      handleToolCall({
        protocol: TOOL_PROTOCOL, requestId: 'rev-2', tool: 'ai.review',
        input: { provider: 'opencode', prompt: 'x', workspace: ws, agentMode: 'plan' },
      }, { env: { ...process.env, OPENCODE_BIN: fake, FAKE_PROVIDER: 'opencode' } }),
      (e) => e.code === 'INVALID_INPUT',
    );
    // contradiction fails before spawn (missing binary would be CLI_NOT_INSTALLED if spawned)
    await assert.rejects(
      handleToolCall({
        protocol: TOOL_PROTOCOL, requestId: 'rev-3', tool: 'ai.review',
        input: { provider: 'codex', prompt: 'x', workspace: ws, taskIntent: 'review', accessProfile: 'full' },
      }, { env: { ...process.env, CODEX_BIN: '/definitely/missing/codex' } }),
      (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
    );
    // malformed provider output surfaces as REVIEW_RESULT_INCOMPLETE
    await assert.rejects(
      handleToolCall({
        protocol: TOOL_PROTOCOL, requestId: 'rev-4', tool: 'ai.review',
        input: { provider: 'opencode', prompt: 'x', workspace: ws, taskIntent: 'review' },
      }, { env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' } }),
      (e) => e.code === 'REVIEW_RESULT_INCOMPLETE',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('generate with taskIntent contradiction fails before spawn', async () => {
  const { generate } = await import('../src/client.mjs');
  const ws = mkdtempSync(join(tmpdir(), 'gen-intent-'));
  try {
    await assert.rejects(
      generate({
        provider: 'codex',
        prompt: 'x',
        taskIntent: 'review',
        accessProfile: 'full',
        workspace: ws,
        env: { ...process.env, CODEX_BIN: '/definitely/missing/codex' },
      }),
      (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
    );
    await assert.rejects(
      generate({
        provider: 'codex',
        prompt: 'x',
        taskIntent: 'teleport',
        workspace: ws,
        env: { ...process.env, CODEX_BIN: '/definitely/missing/codex' },
      }),
      (e) => e.code === 'TASK_INTENT_INVALID',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('review dry-run reuses the resolver, is sanitized, and never spawns', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'review-dry-'));
  try {
    const preview = describeReviewDryRun({
      provider: 'opencode',
      prompt: 'super secret prompt must not appear',
      taskIntent: 'review',
      workspace: ws,
      env: { ...process.env, OPENCODE_BIN: '/definitely/missing/opencode', GITHUB_TOKEN: 'must-not-leak' },
    });
    assert.equal(preview.ok, true);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.provider, 'opencode');
    assert.equal(preview.taskIntent, 'review');
    assert.equal(preview.accessProfile, 'review-readonly');
    const str = JSON.stringify(preview);
    assert.equal(str.includes('super secret prompt'), false);
    assert.equal(str.includes('must-not-leak'), false);
    assert.equal(str.includes(ws), false, 'dry-run must use digests, not absolute paths');
    assert.match(str, /workspaceDigest|capability/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('review dry-run redacts resumable session identifiers while preserving resumed state', () => {
  const ws = mkdtempSync(join(tmpdir(), 'review-session-preview-'));
  try {
    const preview = describeReviewDryRun({
      provider: 'opencode',
      prompt: 'resume preview',
      taskIntent: 'review',
      workspace: ws,
      sessionId: 'ses_private_resume_123',
    });
    const text = JSON.stringify(preview);
    assert.equal(preview.resumed, true);
    assert.equal(preview.sessionId, '<resumed-session>');
    assert.equal(text.includes('ses_private_resume_123'), false);
    assert.equal(text.includes('<resumed-session>'), true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('CLI review --dry-run and --help reuse the same resolver', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cli-review-'));
  try {
    const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /review/);
    const dry = spawnSync(process.execPath, [bin, 'review', '--provider', 'opencode', '--prompt', 'hello', '--workspace', ws, '--dry-run', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, OPENCODE_BIN: '/definitely/missing/opencode' },
    });
    assert.equal(dry.status, 0, dry.stderr);
    const payload = JSON.parse(dry.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.accessProfile, 'review-readonly');
    // contradiction via CLI fails before spawn
    const bad = spawnSync(process.execPath, [bin, 'review', '--provider', 'codex', '--prompt', 'x', '--workspace', ws, '--task-intent', 'review', '--access-profile', 'full', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_BIN: fakeBin, FAKE_PROVIDER: 'codex' },
    });
    assert.equal(bad.status, 2);
    assert.equal(JSON.parse(bad.stdout).error.code, 'TASK_INTENT_ACCESS_CONFLICT');
    // AGY review via CLI is typed unsupported
    const agy = spawnSync(process.execPath, [bin, 'review', '--provider', 'agy', '--prompt', 'x', '--workspace', ws, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, AGY_BIN: fakeBin, FAKE_PROVIDER: 'agy' },
    });
    assert.equal(agy.status, 2);
    assert.equal(JSON.parse(agy.stdout).error.code, 'UNSUPPORTED_CAPABILITY');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('CLI review real run with fixture verdict and incomplete typing', async (t) => {
  const fake = makeReviewFake(t, 'blocked');
  const ws = mkdtempSync(join(tmpdir(), 'cli-review-real-'));
  try {
    const ok = spawnSync(process.execPath, [bin, 'review', '--provider', 'opencode', '--prompt', 'review me', '--workspace', ws, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, OPENCODE_BIN: fake, FAKE_PROVIDER: 'opencode' },
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).review.verdict, 'blocked');
    const incomplete = spawnSync(process.execPath, [bin, 'review', '--provider', 'opencode', '--prompt', 'review me', '--workspace', ws, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' },
    });
    assert.equal(incomplete.status, 1);
    assert.equal(JSON.parse(incomplete.stdout).error.code, 'REVIEW_RESULT_INCOMPLETE');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
