import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { generate } from '../src/client.mjs';
import { handleToolCall, TOOL_PROTOCOL } from '../src/protocol.mjs';
import { getProvider } from '../src/providers/index.mjs';
import { normalizeReviewTarget, resolveReviewTargetForRequest } from '../src/providers/codex.mjs';
import { buildReviewPrompt, describeReviewDryRun, review } from '../src/review.mjs';
import { isolateTmpdir } from './helpers/isolated-tmpdir.mjs';

const bin = fileURLToPath(new URL('../bin/webmcp-ai.mjs', import.meta.url));

const CODEX_REVIEW_TARGET_GOOD_HELP = 'codex exec review --uncommitted --base <BRANCH> --commit <SHA> --ephemeral --ignore-user-config --ignore-rules --output-schema <FILE> -o, --output-last-message <FILE> -c, --config <key=value>';

function makeGitRepo(t) {
  const ws = mkdtempSync(join(tmpdir(), 'codex-review-target-git-'));
  spawnSync('git', ['init'], { cwd: ws });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: ws });
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  return ws;
}

function makeCodexReviewTargetFake(t, { helpText = CODEX_REVIEW_TARGET_GOOD_HELP, markerPath, verdict }) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-codex-review-target-'));
  const fake = join(dir, 'fake-codex.mjs');
  const verdictText = JSON.stringify(verdict);
  writeFileSync(fake, [
    '#!/usr/bin/env node',
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    `const help = ${JSON.stringify(helpText)};`,
    `const verdict = ${JSON.stringify(verdictText)};`,
    `const marker = ${JSON.stringify(markerPath ?? '')};`,
    'const args = process.argv.slice(2);',
    'if (args.includes("--help")) { process.stdout.write(help + "\\n"); process.exit(0); }',
    'if (marker) { try { appendFileSync(marker, `model-invoked:${args.join(" ")}\\n`); } catch {} }',
    'const outIdx = args.indexOf("--output-last-message");',
    'if (outIdx >= 0) { writeFileSync(args[outIdx + 1], verdict); process.stdout.write("{\\"type\\":\\"completed\\"}\\n"); process.exit(0); }',
    'process.stdout.write(verdict);',
    '',
  ].join('\n'));
  chmodSync(fake, 0o755);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return fake;
}

// ---- normalizeReviewTarget / resolveReviewTargetForRequest (pure shape gate) ----

test('normalizeReviewTarget: three variants canonicalize; empty/absent resolve to null', () => {
  assert.equal(normalizeReviewTarget(null), null);
  assert.equal(normalizeReviewTarget(undefined), null);
  assert.equal(normalizeReviewTarget({}), null, 'empty object is an explicit no-target declaration');
  assert.deepEqual(normalizeReviewTarget({ type: 'uncommitted' }), { type: 'uncommitted' });
  assert.deepEqual(normalizeReviewTarget({ type: 'base', ref: 'main' }), { type: 'base', ref: 'main' });
  assert.deepEqual(normalizeReviewTarget({ type: 'commit', sha: 'abc123' }), { type: 'commit', sha: 'abc123' });
});

test('normalizeReviewTarget: malformed shapes fail typed INVALID_INPUT before any spawn', () => {
  const cases = [
    ['not an object', 'string value'],
    [['array'], 'array value'],
    [{ type: 'diff' }, 'unknown type enum'],
    [{ type: 'base' }, 'missing ref'],
    [{ type: 'commit' }, 'missing sha'],
    [{ type: 'uncommitted', ref: 'main' }, 'extra key on uncommitted'],
    [{ type: 'base', ref: 'main', sha: 'abc' }, 'both ref and sha present (neither pure variant)'],
    [{ type: 'commit', sha: 'abc', extra: 1 }, 'unknown extra key'],
    [{ type: 'base', ref: '' }, 'empty ref'],
    [{ type: 'base', ref: '-danger' }, 'ref must never start with -' ],
    [{ type: 'commit', sha: 'a'.repeat(201) }, 'sha exceeds bounded length'],
    [{ type: 'commit', sha: 'abc\u0000def' }, 'sha contains a null byte'],
    [{ type: 'base', ref: 42 }, 'ref must be a string'],
  ];
  for (const [value, label] of cases) {
    assert.throws(() => normalizeReviewTarget(value), (e) => e.code === 'INVALID_INPUT', label);
  }
});

test('resolveReviewTargetForRequest: provider/taskIntent/sessionId conflicts are typed', () => {
  assert.equal(resolveReviewTargetForRequest(null, { providerId: 'codex', taskIntent: 'review' }), null);
  assert.equal(resolveReviewTargetForRequest({}, { providerId: 'claude', taskIntent: 'review' }), null, 'empty object is provider-agnostic no-op');
  assert.throws(
    () => resolveReviewTargetForRequest({ type: 'uncommitted' }, { providerId: 'claude', taskIntent: 'review' }),
    (e) => e.code === 'UNSUPPORTED_CAPABILITY' && e.details?.capability === 'reviewTarget',
  );
  assert.throws(
    () => resolveReviewTargetForRequest({ type: 'uncommitted' }, { providerId: 'codex', taskIntent: 'compose' }),
    (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
  );
  assert.throws(
    () => resolveReviewTargetForRequest({ type: 'uncommitted' }, { providerId: 'codex', taskIntent: 'review', sessionId: 'sess-1' }),
    (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
  );
  assert.deepEqual(
    resolveReviewTargetForRequest({ type: 'base', ref: 'main' }, { providerId: 'codex', taskIntent: 'review' }),
    { type: 'base', ref: 'main' },
  );
});

// ---- Prompt text: fail-closed clause on target lanes only (F1 fix) ----

const FAIL_CLOSED_SENTENCE = 'If you cannot determine exactly this scope via the named read-only git command (unknown ref, git error, or empty diff context), return verdict "blocked" with a "blockedReason" describing what was unresolvable — never review a different scope instead.';

test('buildReviewPrompt: portable lane is byte-identical and never carries the fail-closed clause', () => {
  const portable = buildReviewPrompt('review this');
  assert.equal(portable, 'review this\n\nRespond with ONLY compact JSON matching schema "webmcp-ai-review-result/1": {"schema":"webmcp-ai-review-result/1","verdict":"approve|request-changes|blocked|indeterminate","summary":"<one-line reason>"}. Include "blockedReason" when verdict is "blocked". Findings, when present, must be [{id:"F1",severity:"critical|high|medium|low",file:"<path>",line:<n>,message:"<defect>",recommendation:"<repair>"}]; omit file/line only for architectural findings. Do not emit plans, diffs, or prose outside that JSON. Do not run shell commands, edit files, or access the network.');
  assert.equal(portable.includes(FAIL_CLOSED_SENTENCE), false);
  assert.equal(buildReviewPrompt('review this', { reviewTarget: null }), portable);
  assert.equal(buildReviewPrompt('review this', {}), portable);
});

test('buildReviewPrompt: every reviewTarget variant carries the fail-closed blocked-verdict clause (F1 fix)', () => {
  for (const target of [
    { type: 'uncommitted' },
    { type: 'base', ref: 'main' },
    { type: 'commit', sha: 'HEAD' },
  ]) {
    const withTarget = buildReviewPrompt('review this', { reviewTarget: target });
    assert.ok(withTarget.includes(FAIL_CLOSED_SENTENCE), `missing fail-closed clause for ${JSON.stringify(target)}`);
    assert.ok(withTarget.includes('The sandbox is read-only; do not attempt any write.'));
    // The fail-closed clause must follow the read-only sentence, not replace it.
    assert.ok(
      withTarget.indexOf('The sandbox is read-only; do not attempt any write.') < withTarget.indexOf(FAIL_CLOSED_SENTENCE),
    );
    assert.equal(withTarget.includes('Do not run shell commands, edit files, or access the network.'), false);
  }
});

// ---- Adapter argv shape: three variants + byte-identical portable lane ----
//
// Real-CLI finding (canary 2026-09-29, codex-cli 0.157.1): `exec review`
// hard-rejects combining --uncommitted/--base/--commit with any custom
// [PROMPT] (clap conflict, exit 2 before any spawn), and even without a
// prompt those flags' built-in review flow ignores --output-schema entirely
// (free prose, not the JSON contract). So the adapter never emits
// --uncommitted/--base/--commit as argv for any of the three target shapes —
// the scope lives in the prompt instead (see review.mjs buildReviewPrompt).
// This test proves that identically-shaped, target-flag-free argv, plus the
// fact that reviewTarget still governs validation/prompting even though argv
// is invariant across the three shapes.

test('codex adapter: reviewTarget never emits --uncommitted/--base/--commit; argv is target-shape-invariant', () => {
  const argvFor = (target) => {
    const inv = getProvider('codex').buildInvocation({
      prompt: 'x', taskIntent: 'review', accessProfile: 'review-readonly', reviewTarget: target,
      model: 'gpt-6-sol', effort: 'low',
    });
    const stripped = inv.args.map((a) => (typeof a === 'string' && a.includes(tmpdir()) ? '<tmp>' : a));
    inv.cleanup?.();
    return stripped;
  };
  const shapes = [
    { type: 'uncommitted' },
    { type: 'base', ref: 'main' },
    { type: 'commit', sha: 'HEAD' },
  ];
  const argvs = shapes.map(argvFor);
  for (const args of argvs) {
    assert.deepEqual(args.slice(0, 2), ['exec', 'review']);
    assert.ok(args.includes('sandbox_mode="read-only"'));
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.includes('--ephemeral'));
    assert.ok(args.includes('--ignore-user-config'));
    assert.ok(args.includes('--ignore-rules'));
    assert.ok(args.includes('--output-schema'));
    assert.ok(args.includes('--output-last-message'));
    assert.ok(args.includes('-m'));
    assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-sol');
    assert.ok(args.includes('model_reasoning_effort="low"'));
    assert.equal(args.at(-1), '-');
    assert.equal(args.includes('--sandbox'), false);
    assert.equal(args.includes('--color'), false);
    assert.equal(args.includes('--skip-git-repo-check'), false);
    assert.equal(args.includes('--uncommitted'), false);
    assert.equal(args.includes('--base'), false);
    assert.equal(args.includes('--commit'), false);
  }
  // Target-shape-invariant: uncommitted/base/commit produce the identical
  // argv (the scope only ever shows up in the prompt, never in argv).
  assert.deepEqual(argvs[0], argvs[1]);
  assert.deepEqual(argvs[1], argvs[2]);
});

test('codex adapter: portable review lane argv is byte-identical with no reviewTarget', () => {
  const withoutTarget = getProvider('codex').buildInvocation({
    prompt: 'x', taskIntent: 'review', accessProfile: 'review-readonly',
  });
  const withEmptyTarget = getProvider('codex').buildInvocation({
    prompt: 'x', taskIntent: 'review', accessProfile: 'review-readonly', reviewTarget: {},
  });
  try {
    // Both invocations mkdtemp their own private temp dir, so the
    // --output-last-message/--output-schema absolute paths legitimately
    // differ between calls; strip them before the byte-identical comparison.
    const stripTmp = (args) => args.map((a) => (typeof a === 'string' && a.includes(tmpdir()) ? '<tmp>' : a));
    assert.deepEqual(stripTmp(withoutTarget.args), stripTmp(withEmptyTarget.args));
    assert.ok(withoutTarget.args.includes('--skip-git-repo-check'));
    assert.ok(withoutTarget.args.includes('--color'));
    assert.equal(withoutTarget.args.includes('exec review'), false);
    assert.deepEqual(withoutTarget.args.slice(0, 1), ['exec']);
  } finally {
    withoutTarget.cleanup?.();
    withEmptyTarget.cleanup?.();
  }
});

// ---- Adapter-level conflicts (final defense for direct callers) ----

test('codex adapter: reviewTarget conflicts are typed before any temp dir side effect', (t) => {
  const isolatedTmp = isolateTmpdir(t, 'codex-review-target-tmpdir-');
  const prefixSnapshot = () => new Set(readdirSync(isolatedTmp).filter((n) => n.startsWith('webmcp-ai-codex-')));
  const before = prefixSnapshot();

  assert.throws(
    () => getProvider('codex').buildInvocation({ prompt: 'x', taskIntent: 'compose', reviewTarget: { type: 'uncommitted' } }),
    (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
  );
  assert.throws(
    () => getProvider('codex').buildInvocation({ prompt: 'x', taskIntent: 'implement', accessProfile: 'full', reviewTarget: { type: 'uncommitted' } }),
    (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
  );
  assert.throws(
    () => getProvider('codex').buildInvocation({
      prompt: 'x', taskIntent: 'review', accessProfile: 'review-readonly',
      reviewTarget: { type: 'uncommitted' }, sessionId: 'sess-1',
    }),
    (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
  );
  assert.throws(
    () => getProvider('codex').buildInvocation({
      prompt: 'x', taskIntent: 'review', accessProfile: 'review-readonly',
      reviewTarget: { type: 'base' },
    }),
    (e) => e.code === 'INVALID_INPUT',
  );
  assert.deepEqual([...prefixSnapshot()].sort(), [...before].sort(), 'no rejected reviewTarget request may strand a temp dir');
});

// ---- Provider mismatch and sessionId conflict at the client/review layer ----

test('generate(): non-codex provider with reviewTarget is typed UNSUPPORTED_CAPABILITY before spawn', async () => {
  await assert.rejects(
    generate({
      provider: 'claude', prompt: 'x', taskIntent: 'review', accessProfile: 'review-readonly',
      reviewTarget: { type: 'uncommitted' }, env: { CLAUDE_BIN: '/definitely/missing/claude' },
    }),
    (e) => e.code === 'UNSUPPORTED_CAPABILITY' && e.details?.capability === 'reviewTarget',
  );
});

test('generate(): reviewTarget without taskIntent review is typed TASK_INTENT_ACCESS_CONFLICT before spawn', async () => {
  await assert.rejects(
    generate({
      provider: 'codex', prompt: 'x', reviewTarget: { type: 'uncommitted' },
      env: { CODEX_BIN: '/definitely/missing/codex' },
    }),
    (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
  );
});

test('review(): reviewTarget + sessionId is typed TASK_INTENT_ACCESS_CONFLICT before spawn', async () => {
  await assert.rejects(
    review({
      provider: 'codex', prompt: 'x', reviewTarget: { type: 'uncommitted' }, sessionId: 'sess-1',
      env: { CODEX_BIN: '/definitely/missing/codex' },
    }),
    (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
  );
});

// ---- Non-git workspace ----

test('review(): reviewTarget on a non-Git workspace is typed REVIEW_TARGET_NOT_GIT before model invocation', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'codex-review-target-notgit-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const marker = join(ws, 'marker.log');
  const fake = makeCodexReviewTargetFake(t, { markerPath: marker, verdict: { schema: 'webmcp-ai-review-result/1', verdict: 'approve', summary: 'x' } });
  await assert.rejects(
    review({
      provider: 'codex', prompt: 'review me', reviewTarget: { type: 'uncommitted' }, workspace: ws,
      env: { ...process.env, CODEX_BIN: fake },
    }),
    (e) => e.code === 'REVIEW_TARGET_NOT_GIT',
  );
  assert.equal(readdirSync(ws).includes('marker.log'), false, 'non-git workspace must never reach the model');
});

// ---- Help-probe drift vs good, real spawn ----

test('review(): reviewTarget help-probe drift fails before model; good help reaches the model with a real Git repo', async (t) => {
  const ws = makeGitRepo(t);
  const verdict = { schema: 'webmcp-ai-review-result/1', verdict: 'approve', summary: 'codex diff good' };

  const driftMarker = join(ws, '.git', 'drift-marker.log');
  const driftedFake = makeCodexReviewTargetFake(t, { helpText: 'codex exec review --sandbox only', markerPath: driftMarker, verdict });
  await assert.rejects(
    review({
      provider: 'codex', prompt: 'review me', reviewTarget: { type: 'uncommitted' }, workspace: ws,
      env: { ...process.env, CODEX_BIN: driftedFake },
    }),
    (e) => {
      assert.equal(e.code, 'PROVIDER_CAPABILITY_DRIFT');
      const str = JSON.stringify({ message: e.message, details: e.details });
      assert.equal(str.includes(driftedFake), false);
      assert.equal(str.includes('--sandbox only'), false);
      return true;
    },
  );
  assert.equal(existsSync(driftMarker), false, 'drifted help must fail before the model marker is ever written');

  const goodMarker = join(ws, '.git', 'good-marker.log');
  const goodFake = makeCodexReviewTargetFake(t, { markerPath: goodMarker, verdict });
  const good = await review({
    provider: 'codex', prompt: 'review me', reviewTarget: { type: 'base', ref: 'main' }, workspace: ws,
    env: { ...process.env, CODEX_BIN: goodFake },
  });
  assert.equal(good.ok, true);
  assert.equal(good.review.verdict, 'approve');
  const invokedArgs = readFileSync(goodMarker, 'utf8');
  assert.match(invokedArgs, /model-invoked:.*exec review/);
  // Real-CLI finding: --base cannot be combined with the custom prompt, so
  // the scope reaches the model only via stdin (the prompt), never as argv.
  assert.equal(invokedArgs.includes('--base'), false);
  assert.equal(invokedArgs.includes('--sandbox'), false);
  assert.equal(invokedArgs.includes('--skip-git-repo-check'), false);
});

test('ai.review tool-call: reviewTarget reaches the codex reviewTarget lane end to end', async (t) => {
  const ws = makeGitRepo(t);
  const verdict = { schema: 'webmcp-ai-review-result/1', verdict: 'request-changes', summary: 'diff findings', findings: [{ id: 'F1', severity: 'low', message: 'nit', recommendation: 'polish' }] };
  const fake = makeCodexReviewTargetFake(t, { verdict });
  const result = await handleToolCall({
    protocol: TOOL_PROTOCOL, requestId: 'review-target-1', tool: 'ai.review',
    input: { provider: 'codex', prompt: 'review me', workspace: ws, reviewTarget: { type: 'commit', sha: 'HEAD' } },
  }, { env: { ...process.env, CODEX_BIN: fake } });
  assert.equal(result.ok, true);
  assert.equal(result.output.verdict, 'request-changes');
});

test('ai.generate tool-call: reviewTarget is rejected as an unknown field', async () => {
  await assert.rejects(
    handleToolCall({
      protocol: TOOL_PROTOCOL, requestId: 'gen-reject-1', tool: 'ai.generate',
      input: { provider: 'codex', prompt: 'x', reviewTarget: { type: 'uncommitted' } },
    }),
    (e) => e.code === 'INVALID_INPUT' && e.details?.field === 'reviewTarget',
  );
});

// ---- Dry-run redaction ----

test('describeReviewDryRun: reviewTarget preview redacts prompt/tmp paths but never spawns', () => {
  const ws = mkdtempSync(join(tmpdir(), 'codex-review-target-dryrun-'));
  try {
    const dry = describeReviewDryRun({
      provider: 'codex', prompt: 'super secret review prompt text', workspace: ws,
      reviewTarget: { type: 'base', ref: 'release/9.9' },
    });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.reviewTarget, { type: 'base', ref: 'release/9.9' });
    const serialized = JSON.stringify(dry);
    assert.equal(serialized.includes('super secret review prompt text'), false);
    assert.equal(serialized.includes(ws), false);
    assert.equal(serialized.includes(tmpdir()), false);
    assert.ok(dry.args.includes('<tmp>'));
    assert.equal(dry.args.includes('--sandbox'), false);
    assert.equal(dry.args.includes('--color'), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---- CLI wiring ----

test('CLI: review --review-target dry-run variants and typed rejections', () => {
  const uncommitted = spawnSync(process.execPath, [bin, 'review', '--provider', 'codex', '--prompt', 'x', '--review-target', 'uncommitted', '--dry-run', '--json'], { encoding: 'utf8' });
  assert.equal(uncommitted.status, 0, uncommitted.stderr);
  const u = JSON.parse(uncommitted.stdout);
  assert.deepEqual(u.reviewTarget, { type: 'uncommitted' });

  const commit = spawnSync(process.execPath, [bin, 'review', '--provider', 'codex', '--prompt', 'x', '--review-target', 'commit', '--review-commit', 'HEAD', '--dry-run', '--json'], { encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stderr);
  const c = JSON.parse(commit.stdout);
  assert.deepEqual(c.reviewTarget, { type: 'commit', sha: 'HEAD' });

  const claudeRejected = spawnSync(process.execPath, [bin, 'review', '--provider', 'claude', '--prompt', 'x', '--review-target', 'uncommitted', '--json'], { encoding: 'utf8' });
  assert.notEqual(claudeRejected.status, 0);
  assert.equal(JSON.parse(claudeRejected.stdout).error.code, 'UNSUPPORTED_CAPABILITY');

  const generateRejected = spawnSync(process.execPath, [bin, 'generate', '--provider', 'codex', '--prompt', 'x', '--review-target', 'uncommitted', '--json'], { encoding: 'utf8' });
  assert.notEqual(generateRejected.status, 0);
  assert.equal(JSON.parse(generateRejected.stdout).error.code, 'UNSUPPORTED_CAPABILITY');
});
