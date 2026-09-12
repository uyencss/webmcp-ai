import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { describeReviewDryRun, review } from '../src/review.mjs';
import { handleToolCall, TOOL_PROTOCOL } from '../src/protocol.mjs';

const bin = fileURLToPath(new URL('../bin/webmcp-ai.mjs', import.meta.url));

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function makeReviewFixture(t, payloadObj, provider) {
  const dir = mkdtempSync(join(tmpdir(), `fresh-review-${provider}-`));
  const fake = join(dir, `fake-${provider}.mjs`);
  const payload = JSON.stringify(payloadObj);
  const goodHelp = provider === 'codex'
    ? 'codex exec --sandbox read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --output-last-message --color resume -c, --config sandbox_mode'
    : provider === 'opencode'
      ? 'opencode run --format json --agent build --dir /ws --model sonnet --variant effort'
      : '-p --permission-mode --tools --disallowedTools --safe-mode --no-chrome --output-format json stream-json --verbose --no-session-persistence --resume --model --effort';
  writeFileSync(fake, [
    '#!/usr/bin/env node',
    "import { readFileSync, writeFileSync } from 'node:fs';",
    `const payload = ${JSON.stringify(payload)};`,
    `const goodHelp = ${JSON.stringify(goodHelp)};`,
    'const args = process.argv.slice(2);',
    'if (args.includes("--version")) { process.stdout.write("fake-cli 1.18.30\\n"); process.exit(0); }',
    'if (args.includes("--help")) { process.stdout.write(goodHelp + "\\n"); process.exit(0); }',
    'const outIdx = args.indexOf("--output-last-message");',
    'if (outIdx >= 0) { writeFileSync(args[outIdx + 1], payload); process.stdout.write("{\\"type\\":\\"completed\\"}\\n"); process.exit(0); }',
    'if (process.env.FAKE_PROVIDER === "claude") { process.stdout.write(JSON.stringify({ result: payload, session_id: "s-claude-1" })); process.exit(0); }',
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

function makeClaudeHelpFake(t, { helpText, versionText = 'claude-cli 2.0.0' }) {
  const dir = mkdtempSync(join(tmpdir(), 'fresh-claude-help-'));
  const fake = join(dir, 'fake-claude.mjs');
  writeFileSync(fake, [
    '#!/usr/bin/env node',
    `const help = ${JSON.stringify(helpText)};`,
    `const version = ${JSON.stringify(versionText)};`,
    'const args = process.argv.slice(2);',
    'if (args.includes("--version")) { process.stdout.write(version + "\\n"); process.exit(0); }',
    'if (args.includes("--help")) { process.stdout.write(help + "\\n"); process.exit(0); }',
    // Model invocation must never happen during inspect; fail loudly if it does.
    'process.stderr.write("unexpected model invocation\\n"); process.exit(42);',
    '',
  ].join('\n'));
  chmodSync(fake, 0o755);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return fake;
}

const PLAN_EXAMPLE = {
  schema: 'webmcp-ai-review-result/1',
  verdict: 'request-changes',
  summary: 'Bounded summary',
  findings: [
    {
      id: 'F1',
      severity: 'high',
      file: 'src/example.mjs',
      line: 42,
      message: 'Concrete defect',
      recommendation: 'Concrete repair direction',
    },
  ],
  blockedReason: null,
};

// F2: Claude inspect probes installed binary/version/help truthfully.
test('F2: providers inspect claude reports available, missing and drifted without fabrication', async (t) => {
  const goodHelp = '-p --permission-mode --tools --disallowedTools --safe-mode --no-chrome --output-format json stream-json --verbose --no-session-persistence --resume --model --effort';
  const availableFake = makeClaudeHelpFake(t, { helpText: `claude --help ${goodHelp}` });
  const driftedFake = makeClaudeHelpFake(t, { helpText: 'claude --help --tools only' });

  const available = spawnSync(process.execPath, [bin, 'providers', 'inspect', 'claude', '--task-intent', 'review', '--json'], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_BIN: availableFake },
  });
  assert.equal(available.status, 0, available.stderr);
  const aPayload = JSON.parse(available.stdout);
  assert.equal(aPayload.installed, true);
  assert.equal(aPayload.policySupported, true);
  assert.equal(aPayload.canaryProven, false);
  assert.equal(aPayload.taskReady, true);
  assert.equal(aPayload.supported, true);
  assert.equal(aPayload.authenticated, null);
  assert.deepEqual(aPayload.missing, []);
  assert.equal(JSON.stringify(aPayload).includes(availableFake), false, 'must not leak executable path');
  // F2 remediation (§8.1): task-ready/support must carry the bounded managed/
  // enterprise override limitation without paths/secrets.
  assert.ok(Array.isArray(aPayload.limitations) && aPayload.limitations.length > 0, 'task-ready inspect must report limitations');

  const quotedHelpFake = makeClaudeHelpFake(t, {
    helpText: 'claude --help -p --permission-mode --tools --disallowedTools --safe-mode --no-chrome --output-format <format> (choices: "text", "json", "stream-json") --verbose --no-session-persistence --resume --model --effort',
  });
  const quoted = spawnSync(process.execPath, [bin, 'providers', 'inspect', 'claude', '--task-intent', 'review', '--json'], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_BIN: quotedHelpFake },
  });
  assert.equal(quoted.status, 0, quoted.stderr);
  assert.equal(JSON.parse(quoted.stdout).taskReady, true, 'quoted help choices must be recognized');

  const hostileVersionFake = makeClaudeHelpFake(t, {
    helpText: `claude --help ${goodHelp}`,
    versionText: 'claude secret=/Users/ttcenter/private-token\u0007',
  });
  const hostile = spawnSync(process.execPath, [bin, 'providers', 'inspect', 'claude', '--task-intent', 'review', '--json'], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_BIN: hostileVersionFake },
  });
  assert.equal(hostile.status, 0, hostile.stderr);
  const hostilePayload = JSON.parse(hostile.stdout);
  assert.equal(hostilePayload.version, '<redacted>');
  assert.equal(JSON.stringify(hostilePayload).includes('/Users/ttcenter'), false);
  assert.equal(JSON.stringify(hostilePayload).includes('private-token'), false);
  const limitText = aPayload.limitations.join(' ');
  assert.match(limitText, /managed|enterprise/i, 'limitations must name managed/enterprise override');
  assert.match(limitText, /override/i, 'limitations must warn that settings may override grants');
  assert.match(limitText, /command-line/i, 'limitations must reference command-line grants');
  assert.equal(limitText.includes(availableFake), false, 'limitations must not leak executable path');
  assert.equal(/[A-Za-z]:[\\/]|~\/\.claude|\/\.config|\/etc\//.test(limitText), false, 'limitations must not expose settings paths');

  const missing = spawnSync(process.execPath, [bin, 'providers', 'inspect', 'claude', '--task-intent', 'review', '--json'], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_BIN: '/definitely/missing/claude' },
  });
  assert.equal(missing.status, 0, missing.stderr);
  const mPayload = JSON.parse(missing.stdout);
  assert.equal(mPayload.installed, false);
  assert.equal(mPayload.taskReady, false);
  assert.equal(mPayload.supported, false);
  assert.equal(mPayload.code, 'CLI_NOT_INSTALLED');

  const drifted = spawnSync(process.execPath, [bin, 'providers', 'inspect', 'claude', '--task-intent', 'review', '--json'], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_BIN: driftedFake },
  });
  assert.equal(drifted.status, 0, drifted.stderr);
  const dPayload = JSON.parse(drifted.stdout);
  assert.equal(dPayload.installed, true);
  assert.equal(dPayload.taskReady, false);
  assert.equal(dPayload.supported, false);
  assert.equal(dPayload.code, 'PROVIDER_CAPABILITY_DRIFT');
  assert.ok(Array.isArray(dPayload.missing) && dPayload.missing.length > 0);
});

// F1: review/ai.review version-probes claude --help before model invocation.
test('F1: review with drifted help fails PROVIDER_CAPABILITY_DRIFT before model invocation', async (t) => {
  const goodHelp = '-p --permission-mode --tools --disallowedTools --safe-mode --no-chrome --output-format json stream-json --verbose --no-session-persistence --resume --model --effort';
  const verdictPayload = {
    schema: 'webmcp-ai-review-result/1', verdict: 'approve', summary: 'good probe verdict',
  };
  const verdictText = JSON.stringify(verdictPayload);
  function makeSpawnProbeFake({ helpText, markerPath }) {
    const dir = mkdtempSync(join(tmpdir(), 'fresh-review-probe-'));
    const fake = join(dir, 'fake-claude-probe.mjs');
    writeFileSync(fake, [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `const help = ${JSON.stringify(helpText)};`,
      `const verdict = ${JSON.stringify(verdictText)};`,
      `const marker = ${JSON.stringify(markerPath)};`,
      'const args = process.argv.slice(2);',
      'if (args.includes("--version")) { process.stdout.write("claude-cli 2.0.0\\n"); process.exit(0); }',
      'if (args.includes("--help")) { process.stdout.write(help + "\\n"); process.exit(0); }',
      // Model invocation lane: record that spawn was reached, then answer the verdict.
      'try { appendFileSync(marker, "model-invoked\\n"); } catch {}',
      'process.stdout.write(JSON.stringify({ result: verdict, session_id: "s-probe-1" }));',
      '',
    ].join('\n'));
    chmodSync(fake, 0o755);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return fake;
  }
  const ws = mkdtempSync(join(tmpdir(), 'fresh-probe-ws-'));
  try {
    // Drifted help: review() must fail typed DRIFT and never reach the model lane.
    const driftMarker = join(ws, 'drift-marker.log');
    const driftedFake = makeSpawnProbeFake({ helpText: 'claude --help --tools only', markerPath: driftMarker });
    const driftEnv = { ...process.env, CLAUDE_BIN: driftedFake, FAKE_PROVIDER: 'claude' };
    await assert.rejects(
      review({ provider: 'claude', prompt: 'review me', taskIntent: 'review', workspace: ws, env: driftEnv }),
      (e) => {
        assert.equal(e.code, 'PROVIDER_CAPABILITY_DRIFT');
        const str = JSON.stringify({ message: e.message, details: e.details });
        assert.equal(str.includes(driftedFake), false, 'must not leak executable path');
        assert.equal(str.includes('--tools only'), false, 'must not leak raw help text');
        return true;
      },
      'drifted help must fail before model invocation',
    );
    assert.equal(readdirSync(ws).includes('drift-marker.log'), false, 'drifted review must not invoke the model');
    // ai.review protocol lane maps the same drift without model invocation.
    const driftMarker2 = join(ws, 'drift-marker2.log');
    const driftedFake2 = makeSpawnProbeFake({ helpText: 'claude --help --tools only', markerPath: driftMarker2 });
    await assert.rejects(
      handleToolCall({
        protocol: TOOL_PROTOCOL, requestId: 'fresh-probe-drift', tool: 'ai.review',
        input: { provider: 'claude', prompt: 'review me', workspace: ws, taskIntent: 'review' },
      }, { env: { ...process.env, CLAUDE_BIN: driftedFake2, FAKE_PROVIDER: 'claude' } }),
      (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT',
    );
    assert.equal(readdirSync(ws).includes('drift-marker2.log'), false, 'ai.review drift must not invoke the model');
    // Good help: the same lane must reach the fixture verdict.
    const goodMarker = join(ws, 'good-marker.log');
    const goodFake = makeSpawnProbeFake({ helpText: `claude --help ${goodHelp}`, markerPath: goodMarker });
    const good = await review({
      provider: 'claude', prompt: 'review me', taskIntent: 'review', workspace: ws,
      env: { ...process.env, CLAUDE_BIN: goodFake, FAKE_PROVIDER: 'claude' },
    });
    assert.equal(good.ok, true);
    assert.equal(good.review.verdict, 'approve');
    assert.equal(readFileSync(goodMarker, 'utf8').includes('model-invoked'), true, 'good help must reach the model');
    // Dry-run with drifted help must remain no-spawn (no DRIFT, no marker).
    const dryMarker = join(ws, 'dry-marker.log');
    const dryFake = makeSpawnProbeFake({ helpText: 'claude --help --tools only', markerPath: dryMarker });
    const dry = describeReviewDryRun({
      provider: 'claude', prompt: 'review me', taskIntent: 'review', workspace: ws,
      env: { ...process.env, CLAUDE_BIN: dryFake, FAKE_PROVIDER: 'claude' },
    });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(readdirSync(ws).includes('dry-marker.log'), false, 'dry-run must never spawn even with drifted help');
    // Legacy generate without taskIntent must remain unprobed (no --help needed).
    const { generate } = await import('../src/client.mjs');
    const legacyFake = fileURLToPath(new URL('./fixtures/fake-ai-cli.mjs', import.meta.url));
    const legacy = await generate({
      provider: 'claude', prompt: 'hello legacy',
      env: { ...process.env, CLAUDE_BIN: legacyFake, FAKE_PROVIDER: 'claude' },
    });
    assert.equal(legacy.ok, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// F2: ordinary review dry-run never spawns a provider process.
test('F2: review dry-run never spawns even with a missing binary', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'fresh-nosspawn-'));
  try {
    for (const provider of ['claude', 'codex', 'opencode']) {
      const preview = describeReviewDryRun({
        provider, prompt: 'dry-run no-spawn check', taskIntent: 'review', workspace: ws,
        env: {
          ...process.env,
          CLAUDE_BIN: '/definitely/missing/claude',
          CODEX_BIN: '/definitely/missing/codex',
          OPENCODE_BIN: '/definitely/missing/opencode',
        },
      });
      assert.equal(preview.ok, true);
      assert.equal(preview.dryRun, true);
      assert.equal(preview.provider, provider);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// F6: fixture-backed end-to-end review() for Claude and Codex.
test('F6: review() end-to-end for claude and codex with workspace hash stability', async (t) => {
  for (const provider of ['claude', 'codex']) {
    const fake = makeReviewFixture(t, PLAN_EXAMPLE, provider);
    const ws = mkdtempSync(join(tmpdir(), `fresh-e2e-${provider}-`));
    const sentinel = join(ws, 'sentinel.txt');
    writeFileSync(sentinel, 'stable-content');
    const before = hashFile(sentinel);
    try {
      const dry = describeReviewDryRun({
        provider, prompt: 'review me', taskIntent: 'review', workspace: ws,
        env: { ...process.env, CLAUDE_BIN: fake, CODEX_BIN: fake, OPENCODE_BIN: fake, FAKE_PROVIDER: provider },
      });
      assert.equal(dry.ok, true);
      assert.equal(hashFile(sentinel), before, `${provider} dry-run must not mutate workspace`);
      const result = await review({
        provider, prompt: 'review me', taskIntent: 'review', workspace: ws,
        env: { ...process.env, CLAUDE_BIN: fake, CODEX_BIN: fake, OPENCODE_BIN: fake, FAKE_PROVIDER: provider },
      });
      assert.equal(result.ok, true);
      assert.equal(result.review.verdict, 'request-changes');
      assert.equal(result.review.findings[0].id, 'F1');
      assert.equal(result.review.findings[0].severity, 'high');
      assert.equal(result.resumed, false);
      assert.equal(hashFile(sentinel), before, `${provider} review must not mutate workspace`);
      assert.equal(result.capability.accessProfile, 'review-readonly');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }
});

// F6: denied edit/write cannot be reported as successful review completion.
test('F6: edit-claim text without a verdict is REVIEW_RESULT_INCOMPLETE, not success', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fresh-denied-'));
  const fake = join(dir, 'fake-edit-claim.mjs');
  writeFileSync(fake, [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    'if (args.includes("--version")) { process.stdout.write("fake-cli 1.18.30\\n"); process.exit(0); }',
    'if (args.includes("--help")) {',
    '  const p = process.env.FAKE_PROVIDER || "claude";',
    '  if (p === "codex") { process.stdout.write("codex exec --sandbox read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --output-last-message --color resume -c, --config sandbox_mode\\n"); process.exit(0); }',
    '  if (p === "opencode") { process.stdout.write("opencode run --format json --agent build --dir /ws --model sonnet --variant effort\\n"); process.exit(0); }',
    '  process.stdout.write("-p --permission-mode --tools --disallowedTools --safe-mode --no-chrome --output-format json stream-json --verbose --no-session-persistence --resume --model --effort\\n"); process.exit(0);',
    '}',
    'const outIdx = args.indexOf("--output-last-message");',
    'const text = "Edited src/example.mjs successfully";',
    'if (outIdx >= 0) { const { writeFileSync } = await import("node:fs"); writeFileSync(args[outIdx + 1], text); process.stdout.write("{\\"type\\":\\"completed\\"}\\n"); process.exit(0); }',
    'if (process.env.FAKE_PROVIDER === "claude") { process.stdout.write(JSON.stringify({ result: text, session_id: "s1" })); process.exit(0); }',
    'if (process.env.FAKE_PROVIDER === "opencode") {',
    '  const line = JSON.stringify({ type: "text", sessionID: "s1", part: { type: "text", text } });',
    '  process.stdout.write(line + "\\n"); process.exit(0);',
    '}',
    'process.stdout.write(text);',
    '',
  ].join('\n'));
  chmodSync(fake, 0o755);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const provider of ['claude', 'codex', 'opencode']) {
    const ws = mkdtempSync(join(tmpdir(), `fresh-denied-ws-${provider}-`));
    try {
      await assert.rejects(
        review({
          provider, prompt: 'review me', taskIntent: 'review', workspace: ws,
          env: { ...process.env, CLAUDE_BIN: fake, CODEX_BIN: fake, OPENCODE_BIN: fake, FAKE_PROVIDER: provider },
        }),
        (e) => e.code === 'REVIEW_RESULT_INCOMPLETE',
        `${provider} edit-claim must not succeed`,
      );
      // approve carrying critical/high/medium is also incomplete, not success.
      const badApprove = {
        schema: 'webmcp-ai-review-result/1', verdict: 'approve', summary: 'ok',
        findings: [{ id: 'F9', severity: 'critical', file: 'src/a.mjs', line: 1, message: 'bad', recommendation: 'fix' }],
      };
      const { validateReviewResult } = await import('../src/review-result.mjs');
      assert.throws(() => validateReviewResult(badApprove), (e) => e.code === 'REVIEW_RESULT_INCOMPLETE');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }
});

// F7: workspace read boundary for review (explicit preferred, cwd default documented).
test('F7: review without explicit workspace defaults to cwd read-only and never writes', async () => {
  const { resolveReviewRequest } = await import('../src/review.mjs');
  const cwd = process.cwd();
  const resolved = resolveReviewRequest({ provider: 'opencode', prompt: 'boundary check' });
  assert.equal(resolved.capability.workspace, cwd);
  assert.equal(resolved.accessProfile, 'review-readonly');
  const preview = describeReviewDryRun({ provider: 'opencode', prompt: 'boundary check' });
  assert.equal(preview.ok, true);
  const str = JSON.stringify(preview);
  assert.equal(str.includes(cwd), false, 'dry-run must use digests, not absolute cwd');
});

// F8: resumed review sessions are marked and documented as non-final evidence.
test('F8: resumed review sets resumed:true; fresh review sets resumed:false', async (t) => {
  const fake = makeReviewFixture(t, { schema: 'webmcp-ai-review-result/1', verdict: 'approve', summary: 'fresh looks good' }, 'opencode');
  const ws = mkdtempSync(join(tmpdir(), 'fresh-resumed-'));
  try {
    const env = { ...process.env, OPENCODE_BIN: fake, FAKE_PROVIDER: 'opencode' };
    const fresh = await review({ provider: 'opencode', prompt: 'review me', workspace: ws, env });
    assert.equal(fresh.resumed, false);
    assert.equal(fresh.session.id, null, 'review must not expose raw provider session IDs');
    const resumed = await review({ provider: 'opencode', prompt: 'review me', workspace: ws, sessionId: 'ses_test', env });
    assert.equal(resumed.resumed, true);
    const tool = await handleToolCall({
      protocol: TOOL_PROTOCOL, requestId: 'fresh-resumed-1', tool: 'ai.review',
      input: { provider: 'opencode', prompt: 'review me', workspace: ws, sessionId: 'ses_test' },
    }, { env });
    assert.equal(tool.metadata.resumed, true);
    assert.equal(tool.metadata.review.resumed, true);
    assert.equal(Object.hasOwn(tool.metadata, 'sessionId'), false, 'tool review metadata must not expose raw session IDs');
    // Explicit events contract: review rejects live telemetry.
    await assert.rejects(
      review({ provider: 'opencode', prompt: 'x', workspace: ws, onEvent: () => {}, env }),
      (e) => e.code === 'INVALID_INPUT',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// Codex temp-leak regression: rejected vNext intents must not create a temp dir.
// Scoped observation only: list tmpdir() filtered by the exact provider prefix;
// never delete unrelated files — only the successful control invocation is
// cleaned up via its own cleanup().
test('Codex rejected vNext intents leave no temp directory', async () => {
  const { getProvider } = await import('../src/providers/index.mjs');
  const PREFIX = 'webmcp-ai-codex-';
  const snapshot = () => new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(PREFIX)));
  const before = snapshot();

  const rejected = [
    { prompt: 'x', taskIntent: 'plan', accessProfile: 'review-readonly' },
    { prompt: 'x', taskIntent: 'implement', accessProfile: 'bounded-edit' },
    { prompt: 'x', taskIntent: 'review', accessProfile: 'full' },
  ];
  for (const request of rejected) {
    assert.throws(
      () => getProvider('codex').buildInvocation(request),
      (error) => error.code === 'UNSUPPORTED_CAPABILITY' || error.code === 'TASK_INTENT_ACCESS_CONFLICT' || error.code === 'TASK_INTENT_INVALID',
      `must reject ${JSON.stringify(request)} without a temp dir`,
    );
  }
  // Schema writes must also sit after validation: a rejected intent with a
  // schema must still leave no temp dir.
  assert.throws(
    () => getProvider('codex').buildInvocation({ prompt: 'x', taskIntent: 'plan', schema: { type: 'object' } }),
    (error) => error.code === 'UNSUPPORTED_CAPABILITY',
  );

  const afterRejected = snapshot();
  assert.deepEqual(
    [...afterRejected].sort(),
    [...before].sort(),
    'rejected Codex intents must not leak webmcp-ai-codex-* temp dirs',
  );

  // Control: a valid invocation still creates exactly one isolated dir and
  // removes it via cleanup(), preserving legacy behavior.
  const ok = getProvider('codex').buildInvocation({ prompt: 'x', taskIntent: 'review', accessProfile: 'review-readonly' });
  try {
    const during = snapshot();
    assert.equal(during.size, before.size + 1, 'valid invocation creates one temp dir');
    assert.ok(ok.args.includes('--sandbox'));
    assert.equal(ok.args[ok.args.indexOf('--sandbox') + 1], 'read-only');
  } finally {
    ok.cleanup();
  }
  const cleaned = snapshot();
  assert.deepEqual([...cleaned].sort(), [...before].sort(), 'cleanup must remove the control temp dir');
});
