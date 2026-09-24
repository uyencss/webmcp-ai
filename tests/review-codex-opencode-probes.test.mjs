import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { describeReviewDryRun, review } from '../src/review.mjs';
import { handleToolCall, TOOL_PROTOCOL } from '../src/protocol.mjs';
import { withV2Db } from './fixtures/opencode-v2-db.mjs';

const bin = fileURLToPath(new URL('../bin/webmcp-ai.mjs', import.meta.url));

const CODEX_GOOD_HELP = 'codex exec --sandbox read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --output-last-message --color resume -c, --config sandbox_mode model_reasoning_effort';
const OPENCODE_GOOD_HELP = 'opencode run --standalone --format json --agent build --model sonnet#effort';

function makeHelpFake(t, { provider, helpText, versionText = (provider === 'opencode' ? 'fake-cli 2.0.3' : 'fake-cli 1.18.30') }) {
  const dir = mkdtempSync(join(tmpdir(), `probe-help-${provider}-`));
  const fake = join(dir, `fake-${provider}.mjs`);
  writeFileSync(fake, [
    '#!/usr/bin/env node',
    `const help = ${JSON.stringify(helpText)};`,
    `const version = ${JSON.stringify(versionText)};`,
    'const args = process.argv.slice(2);',
    'if (args.includes("--version")) { process.stdout.write(version + "\\n"); process.exit(0); }',
    'if (args.includes("--help")) { process.stdout.write(help + "\\n"); process.exit(0); }',
    'process.stderr.write("unexpected model invocation\\n"); process.exit(42);',
    '',
  ].join('\n'));
  chmodSync(fake, 0o755);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return fake;
}

function makeCodexSpawnFake(t, { helpText, markerPath, verdict }) {
  const dir = mkdtempSync(join(tmpdir(), 'probe-codex-spawn-'));
  const fake = join(dir, 'fake-codex-probe.mjs');
  const verdictText = JSON.stringify(verdict);
  writeFileSync(fake, [
    '#!/usr/bin/env node',
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    `const help = ${JSON.stringify(helpText)};`,
    `const verdict = ${JSON.stringify(verdictText)};`,
    `const marker = ${JSON.stringify(markerPath)};`,
    'const args = process.argv.slice(2);',
    'if (args.includes("--version")) { process.stdout.write("codex-cli 9.9.9\\n"); process.exit(0); }',
    'if (args.includes("--help")) { process.stdout.write(help + "\\n"); process.exit(0); }',
    'try { appendFileSync(marker, "model-invoked\\n"); } catch {}',
    'const outIdx = args.indexOf("--output-last-message");',
    'if (outIdx >= 0) { writeFileSync(args[outIdx + 1], verdict); process.stdout.write("{\\"type\\":\\"completed\\"}\\n"); process.exit(0); }',
    'process.stdout.write(verdict);',
    '',
  ].join('\n'));
  chmodSync(fake, 0o755);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return fake;
}

function makeOpencodeSpawnFake(t, { helpText, markerPath, verdict }) {
  const dir = mkdtempSync(join(tmpdir(), 'probe-opencode-spawn-'));
  const fake = join(dir, 'fake-opencode-probe.mjs');
  const verdictText = JSON.stringify(verdict);
  writeFileSync(fake, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs';",
    `const help = ${JSON.stringify(helpText)};`,
    `const verdict = ${JSON.stringify(verdictText)};`,
    `const marker = ${JSON.stringify(markerPath)};`,
    'const args = process.argv.slice(2);',
    'if (args.includes("--version")) { process.stdout.write("opencode-cli 2.0.3\\n"); process.exit(0); }',
    'if (args.includes("--help")) { process.stdout.write(help + "\\n"); process.exit(0); }',
    'try { appendFileSync(marker, "model-invoked\\n"); } catch {}',
    'const line = JSON.stringify({ type: "text", sessionID: "ses_probe", part: { type: "text", text: verdict } });',
    'process.stdout.write(line + "\\n");',
    '',
  ].join('\n'));
  chmodSync(fake, 0o755);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return fake;
}

// ---- Validators: good vs drifted, typed output, no leakage ----
test('RED: codex review validator accepts good help and fails drifted with typed drift', async () => {
  const { validateCodexReviewSupport } = await import('../src/providers/codex.mjs');
  assert.ok(validateCodexReviewSupport(CODEX_GOOD_HELP));
  assert.throws(
    () => validateCodexReviewSupport(CODEX_GOOD_HELP.replace('-c, --config', '--color')),
    (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT'
      && e.details?.missing?.includes('-c')
      && e.details?.missing?.includes('--config'),
    ' --color must not satisfy the short -c/config capability',
  );
  assert.throws(
    () => validateCodexReviewSupport(CODEX_GOOD_HELP.replace('-c, ', '')),
    (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT' && e.details?.missing?.includes('-c'),
    'long --config must not silently replace the emitted short -c option',
  );
  assert.throws(
    () => validateCodexReviewSupport(CODEX_GOOD_HELP.replace('--skip-git-repo-check ', '').replace('--color ', '')),
    (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT'
      && e.details?.missing?.includes('--skip-git-repo-check')
      && e.details?.missing?.includes('--color'),
    'fresh invocation options must be proven',
  );
  assert.throws(
    () => validateCodexReviewSupport('codex --help --sandbox only'),
    (e) => {
      assert.equal(e.code, 'PROVIDER_CAPABILITY_DRIFT');
      assert.ok(Array.isArray(e.details?.missing) && e.details.missing.length > 0);
      const str = JSON.stringify({ message: e.message, details: e.details });
      assert.equal(str.includes('/tmp'), false);
      assert.equal(str.includes('codex --help --sandbox only'), false);
      // Bounded missing names only: each missing is a known flag token.
      for (const m of e.details.missing) {
        assert.equal(typeof m, 'string');
        assert.ok(m.length < 64);
      }
      return true;
    },
  );
  // Direct adapter with drifted help text fails before temp dir side effects.
  const { getProvider } = await import('../src/providers/index.mjs');
  assert.throws(
    () => getProvider('codex').buildInvocation({
      prompt: 'x', taskIntent: 'review', accessProfile: 'review-readonly', codexHelpText: 'drifted',
    }),
    (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT',
  );
  const goodInvocation = getProvider('codex').buildInvocation({
    prompt: 'x', taskIntent: 'review', accessProfile: 'review-readonly', codexHelpText: CODEX_GOOD_HELP,
  });
  try {
    assert.ok(goodInvocation.args.includes('exec'));
  } finally {
    goodInvocation.cleanup?.();
  }
});

test('RED: opencode review validator accepts good help and fails drifted with typed drift', async () => {
  const { validateOpencodeReviewSupport } = await import('../src/providers/opencode.mjs');
  assert.ok(validateOpencodeReviewSupport(OPENCODE_GOOD_HELP));
  assert.throws(
    () => validateOpencodeReviewSupport('run --formatting --agent-mode --directory --models --variants'),
    (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT',
    'OpenCode option names must be matched on token boundaries',
  );
  assert.throws(
    () => validateOpencodeReviewSupport('opencode --help run only'),
    (e) => {
      assert.equal(e.code, 'PROVIDER_CAPABILITY_DRIFT');
      assert.ok(Array.isArray(e.details?.missing) && e.details.missing.length > 0);
      const str = JSON.stringify({ message: e.message, details: e.details });
      assert.equal(str.includes('/tmp'), false);
      assert.equal(str.includes('run only'), false);
      return true;
    },
  );
  const { getProvider } = await import('../src/providers/index.mjs');
  assert.throws(
    () => getProvider('opencode').buildInvocation({
      prompt: 'x', workspace: tmpdir(), taskIntent: 'review', accessProfile: 'review-readonly',
      allowedReadRoots: [], allowedWriteRoots: [], protectedPaths: [], env: {}, opencodeHelpText: 'drifted',
    }),
    (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT',
  );
});

// ---- Inspect: good yields taskReady true; drifted/missing fail closed ----
test('RED: providers inspect codex probes help truthfully (good/drifted/missing)', async (t) => {
  const goodFake = makeHelpFake(t, { provider: 'codex', helpText: CODEX_GOOD_HELP });
  const good = spawnSync(process.execPath, [bin, 'providers', 'inspect', 'codex', '--task-intent', 'review', '--json'], {
    encoding: 'utf8', env: { ...process.env, CODEX_BIN: goodFake },
  });
  assert.equal(good.status, 0, good.stderr);
  const g = JSON.parse(good.stdout);
  assert.equal(g.ok, true);
  assert.equal(g.installed, true);
  assert.equal(g.authenticated, null);
  assert.equal(g.canaryProven, false);
  assert.equal(g.taskReady, true);
  assert.equal(g.supported, true);
  assert.equal(g.code, null);
  assert.deepEqual(g.missing, []);
  assert.ok(g.mapping?.sandbox?.includes('read-only'));
  assert.ok(g.mapping?.resume?.includes('resume'));
  assert.equal(JSON.stringify(g).includes(goodFake), false, 'must not leak executable path');

  const driftedFake = makeHelpFake(t, { provider: 'codex', helpText: 'codex --help --sandbox only' });
  const drifted = spawnSync(process.execPath, [bin, 'providers', 'inspect', 'codex', '--task-intent', 'review', '--json'], {
    encoding: 'utf8', env: { ...process.env, CODEX_BIN: driftedFake },
  });
  assert.equal(drifted.status, 0, drifted.stderr);
  const d = JSON.parse(drifted.stdout);
  assert.equal(d.installed, true);
  assert.equal(d.taskReady, false);
  assert.equal(d.supported, false);
  assert.equal(d.code, 'PROVIDER_CAPABILITY_DRIFT');
  assert.ok(Array.isArray(d.missing) && d.missing.length > 0);
  assert.equal(d.authenticated, null);
  assert.equal(d.canaryProven, false);
  assert.equal(JSON.stringify(d).includes(driftedFake), false);
  assert.equal(JSON.stringify(d).includes('--sandbox only'), false, 'must not leak raw help');

  const missing = spawnSync(process.execPath, [bin, 'providers', 'inspect', 'codex', '--task-intent', 'review', '--json'], {
    encoding: 'utf8', env: { ...process.env, CODEX_BIN: '/definitely/missing/codex' },
  });
  assert.equal(missing.status, 0, missing.stderr);
  const m = JSON.parse(missing.stdout);
  assert.equal(m.installed, false);
  assert.equal(m.taskReady, false);
  assert.equal(m.supported, false);
  assert.equal(m.code, 'CLI_NOT_INSTALLED');
});

test('RED: providers inspect opencode probes help truthfully (good/drifted/missing)', async (t) => {
  const goodFake = makeHelpFake(t, { provider: 'opencode', helpText: OPENCODE_GOOD_HELP });
  const good = spawnSync(process.execPath, [bin, 'providers', 'inspect', 'opencode', '--task-intent', 'review', '--json'], {
    encoding: 'utf8', env: { ...process.env, OPENCODE_BIN: goodFake },
  });
  assert.equal(good.status, 0, good.stderr);
  const g = JSON.parse(good.stdout);
  assert.equal(g.ok, true);
  assert.equal(g.installed, true);
  assert.equal(g.authenticated, null);
  assert.equal(g.canaryProven, false);
  assert.equal(g.taskReady, true);
  assert.equal(g.supported, true);
  assert.equal(g.code, null);
  assert.deepEqual(g.missing, []);
  // Wrapper read-only config mapping must be represented.
  assert.equal(g.mapping?.agent, 'build');
  assert.match(g.mapping?.permissions ?? '', /read-only/);
  assert.equal(JSON.stringify(g).includes(goodFake), false);

  const driftedFake = makeHelpFake(t, { provider: 'opencode', helpText: 'opencode --help run only' });
  const drifted = spawnSync(process.execPath, [bin, 'providers', 'inspect', 'opencode', '--task-intent', 'review', '--json'], {
    encoding: 'utf8', env: { ...process.env, OPENCODE_BIN: driftedFake },
  });
  assert.equal(drifted.status, 0, drifted.stderr);
  const d = JSON.parse(drifted.stdout);
  assert.equal(d.installed, true);
  assert.equal(d.taskReady, false);
  assert.equal(d.supported, false);
  assert.equal(d.code, 'PROVIDER_CAPABILITY_DRIFT');
  assert.ok(Array.isArray(d.missing) && d.missing.length > 0);
  assert.equal(d.authenticated, null);
  assert.equal(d.canaryProven, false);
  assert.equal(d.mapping?.agent, 'build');
  assert.equal(JSON.stringify(d).includes(driftedFake), false);
  assert.equal(JSON.stringify(d).includes('run only'), false);

  const missing = spawnSync(process.execPath, [bin, 'providers', 'inspect', 'opencode', '--task-intent', 'review', '--json'], {
    encoding: 'utf8', env: { ...process.env, OPENCODE_BIN: '/definitely/missing/opencode' },
  });
  assert.equal(missing.status, 0, missing.stderr);
  const m = JSON.parse(missing.stdout);
  assert.equal(m.installed, false);
  assert.equal(m.taskReady, false);
  assert.equal(m.supported, false);
  assert.equal(m.code, 'CLI_NOT_INSTALLED');
});

// ---- Review spawn gating: drifted fails before model; good reaches model ----
test('RED: codex review with drifted help fails before model; good help reaches model', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'probe-codex-review-'));
  try {
    const verdict = { schema: 'webmcp-ai-review-result/1', verdict: 'approve', summary: 'codex good' };
    const driftMarker = join(ws, 'codex-drift.log');
    const driftedFake = makeCodexSpawnFake(t, { helpText: 'codex --help --sandbox only', markerPath: driftMarker, verdict });
    await assert.rejects(
      review({ provider: 'codex', prompt: 'review me', taskIntent: 'review', workspace: ws, env: { ...process.env, CODEX_BIN: driftedFake } }),
      (e) => {
        assert.equal(e.code, 'PROVIDER_CAPABILITY_DRIFT');
        const str = JSON.stringify({ message: e.message, details: e.details });
        assert.equal(str.includes(driftedFake), false);
        assert.equal(str.includes('--sandbox only'), false);
        return true;
      },
    );
    assert.equal(readdirSync(ws).includes('codex-drift.log'), false, 'drifted codex review must not invoke model');

    const driftMarker2 = join(ws, 'codex-drift2.log');
    const driftedFake2 = makeCodexSpawnFake(t, { helpText: 'codex --help --sandbox only', markerPath: driftMarker2, verdict });
    await assert.rejects(
      handleToolCall({
        protocol: TOOL_PROTOCOL, requestId: 'probe-codex-drift', tool: 'ai.review',
        input: { provider: 'codex', prompt: 'review me', workspace: ws, taskIntent: 'review' },
      }, { env: { ...process.env, CODEX_BIN: driftedFake2 } }),
      (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT',
    );
    assert.equal(readdirSync(ws).includes('codex-drift2.log'), false);

    const goodMarker = join(ws, 'codex-good.log');
    const goodFake = makeCodexSpawnFake(t, { helpText: CODEX_GOOD_HELP, markerPath: goodMarker, verdict });
    const good = await review({
      provider: 'codex', prompt: 'review me', taskIntent: 'review', workspace: ws,
      env: { ...process.env, CODEX_BIN: goodFake },
    });
    assert.equal(good.ok, true);
    assert.equal(good.review.verdict, 'approve');
    assert.equal(readFileSync(goodMarker, 'utf8').includes('model-invoked'), true);

    const dryMarker = join(ws, 'codex-dry.log');
    const dryFake = makeCodexSpawnFake(t, { helpText: 'codex --help --sandbox only', markerPath: dryMarker, verdict });
    const dry = describeReviewDryRun({
      provider: 'codex', prompt: 'review me', taskIntent: 'review', workspace: ws,
      env: { ...process.env, CODEX_BIN: dryFake },
    });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(readdirSync(ws).includes('codex-dry.log'), false, 'dry-run must never spawn');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('RED: opencode review with drifted help fails before model; good help reaches model', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'probe-opencode-review-'));
  try {
    const verdict = { schema: 'webmcp-ai-review-result/1', verdict: 'approve', summary: 'opencode good' };
    const driftMarker = join(ws, 'opencode-drift.log');
    const driftedFake = makeOpencodeSpawnFake(t, { helpText: 'opencode --help run only', markerPath: driftMarker, verdict });
    await assert.rejects(
      review({ provider: 'opencode', prompt: 'review me', taskIntent: 'review', workspace: ws, env: withV2Db({ ...process.env, OPENCODE_BIN: driftedFake }) }),
      (e) => {
        assert.equal(e.code, 'PROVIDER_CAPABILITY_DRIFT');
        const str = JSON.stringify({ message: e.message, details: e.details });
        assert.equal(str.includes(driftedFake), false);
        assert.equal(str.includes('run only'), false);
        return true;
      },
    );
    assert.equal(readdirSync(ws).includes('opencode-drift.log'), false, 'drifted opencode review must not invoke model');

    const goodMarker = join(ws, 'opencode-good.log');
    const goodFake = makeOpencodeSpawnFake(t, { helpText: OPENCODE_GOOD_HELP, markerPath: goodMarker, verdict });
    const good = await review({
      provider: 'opencode', prompt: 'review me', taskIntent: 'review', workspace: ws,
      env: withV2Db({ ...process.env, OPENCODE_BIN: goodFake }),
    });
    assert.equal(good.ok, true);
    assert.equal(good.review.verdict, 'approve');
    assert.equal(readFileSync(goodMarker, 'utf8').includes('model-invoked'), true);

    const dryMarker = join(ws, 'opencode-dry.log');
    const dryFake = makeOpencodeSpawnFake(t, { helpText: 'opencode --help run only', markerPath: dryMarker, verdict });
    const dry = describeReviewDryRun({
      provider: 'opencode', prompt: 'review me', taskIntent: 'review', workspace: ws,
      env: { ...process.env, OPENCODE_BIN: dryFake },
    });
    assert.equal(dry.ok, true);
    assert.equal(readdirSync(ws).includes('opencode-dry.log'), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---- F2: review+compose-only fails before compose temp workspace; legacy preserved ----
test('RED: review+compose-only fails TASK_INTENT_ACCESS_CONFLICT with no compose temp dir; legacy compose-only preserved', async () => {
  const { resolveTaskIntent } = await import('../src/task-intent.mjs');
  assert.throws(
    () => resolveTaskIntent({ taskIntent: 'review', accessProfile: 'compose-only' }),
    (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
  );
  assert.throws(
    () => resolveTaskIntent({ taskIntent: 'plan', accessProfile: 'compose-only' }),
    (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
  );
  // Legacy no-taskIntent compose-only stays valid.
  assert.equal(resolveTaskIntent({}).taskIntent, null);
  const { generate } = await import('../src/client.mjs');
  const PREFIXES = ['webmcp-ai-codex-compose-', 'webmcp-ai-claude-compose-', 'webmcp-ai-opencode-compose-', 'webmcp-ai-agy-compose-'];
  const snapshot = () => new Set(readdirSync(tmpdir()).filter((n) => PREFIXES.some((p) => n.startsWith(p))));
  const before = snapshot();
  const ws = mkdtempSync(join(tmpdir(), 'probe-intent-ws-'));
  try {
    await assert.rejects(
      generate({
        provider: 'codex', prompt: 'x', taskIntent: 'review', accessProfile: 'compose-only', workspace: ws,
        env: { ...process.env, CODEX_BIN: '/definitely/missing/codex' },
      }),
      (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
    );
    await assert.rejects(
      generate({
        provider: 'opencode', prompt: 'x', taskIntent: 'review', accessProfile: 'compose-only', workspace: ws,
        env: { ...process.env, OPENCODE_BIN: '/definitely/missing/opencode' },
      }),
      (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
    );
    const afterRejected = snapshot();
    assert.deepEqual([...afterRejected].sort(), [...before].sort(), 'review+compose-only must not create a compose temp dir');
    // Legacy no-taskIntent compose-only still creates (and cleans) its isolated workspace.
    const fakeBin = fileURLToPath(new URL('./fixtures/fake-ai-cli.mjs', import.meta.url));
    const legacy = await generate({
      provider: 'agy', prompt: 'hello legacy compose', toolPolicy: 'compose-only',
      env: { ...process.env, AGY_BIN: fakeBin, FAKE_PROVIDER: 'agy', FAKE_REPLY_CWD: '1', FAKE_EXPECT_HOOKS: '1' },
    });
    assert.equal(legacy.ok, true);
    assert.match(legacy.response.text, /webmcp-ai-agy-compose-/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('RED: AGY vNext rejection does not leak compose or dry-run temp directories', async () => {
  const { generate, describeGenerateDryRun } = await import('../src/client.mjs');
  const prefixes = ['webmcp-ai-agy-compose-', 'webmcp-ai-dryrun-'];
  const snapshot = () => new Set(readdirSync(tmpdir()).filter((name) => prefixes.some((prefix) => name.startsWith(prefix))));
  const before = snapshot();
  await assert.rejects(
    generate({ provider: 'agy', prompt: 'x', taskIntent: 'compose', env: { AGY_BIN: '/definitely/missing/agy' } }),
    (e) => e.code === 'UNSUPPORTED_CAPABILITY',
  );
  await assert.rejects(
    async () => describeGenerateDryRun({ provider: 'agy', prompt: 'x', taskIntent: 'compose', env: {} }),
    (e) => e.code === 'UNSUPPORTED_CAPABILITY',
  );
  assert.deepEqual([...snapshot()].sort(), [...before].sort());
});
