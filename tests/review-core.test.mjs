import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { describeTools, handleToolCall, TOOL_PROTOCOL } from '../src/protocol.mjs';
import { generate } from '../src/client.mjs';
import { getProvider } from '../src/providers/index.mjs';

const fakeBin = fileURLToPath(new URL('./fixtures/fake-ai-cli.mjs', import.meta.url));

// ---- taskIntent / accessProfile matrix (strict portable) ----
test('RED: taskIntent values are strictly validated', async () => {
  const mod = await import('../src/task-intent.mjs');
  assert.deepEqual([...mod.VALID_TASK_INTENTS].sort(), ['compose', 'implement', 'plan', 'review']);
  assert.deepEqual([...mod.VALID_REVIEW_ACCESS_PROFILES].sort(), ['bounded-edit', 'compose-only', 'full', 'review-readonly']);
  assert.equal(mod.normalizeTaskIntent('review'), 'review');
  assert.throws(() => mod.normalizeTaskIntent('delete'), (e) => e.code === 'TASK_INTENT_INVALID');
  assert.throws(() => mod.normalizeTaskIntent(''), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => mod.normalizeTaskIntent(null), (e) => e.code === 'INVALID_INPUT');
});

test('RED: review and plan default to review-readonly; implement requires explicit write profile', async () => {
  const mod = await import('../src/task-intent.mjs');
  assert.equal(mod.resolveTaskIntent({ taskIntent: 'review' }).accessProfile, 'review-readonly');
  assert.equal(mod.resolveTaskIntent({ taskIntent: 'plan' }).accessProfile, 'review-readonly');
  assert.equal(mod.resolveTaskIntent({ taskIntent: 'compose' }).accessProfile, 'compose-only');
  assert.throws(
    () => mod.resolveTaskIntent({ taskIntent: 'implement' }),
    (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
  );
  assert.equal(mod.resolveTaskIntent({ taskIntent: 'implement', accessProfile: 'bounded-edit' }).accessProfile, 'bounded-edit');
  assert.equal(mod.resolveTaskIntent({ taskIntent: 'implement', accessProfile: 'full' }).accessProfile, 'full');
});

test('RED: contradictions fail before provider spawn', async () => {
  const mod = await import('../src/task-intent.mjs');
  for (const bad of [
    { taskIntent: 'review', accessProfile: 'bounded-edit' },
    { taskIntent: 'review', accessProfile: 'full' },
    { taskIntent: 'plan', accessProfile: 'bounded-edit' },
    { taskIntent: 'plan', accessProfile: 'full' },
    { taskIntent: 'implement', accessProfile: 'review-readonly' },
    { taskIntent: 'implement', accessProfile: 'compose-only' },
    { taskIntent: 'compose', accessProfile: 'full' },
    { taskIntent: 'compose', accessProfile: 'bounded-edit' },
  ]) {
    assert.throws(() => mod.resolveTaskIntent(bad), (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT', JSON.stringify(bad));
  }
  // strict portable: provider-default and gateway-tool are not valid review profiles
  assert.throws(() => mod.resolveTaskIntent({ taskIntent: 'review', accessProfile: 'provider-default' }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => mod.resolveTaskIntent({ taskIntent: 'review', accessProfile: 'gateway-tool' }), (e) => e.code === 'INVALID_INPUT');
});

test('RED: invalid review requests do not spawn a provider', async () => {
  const { review } = await import('../src/review.mjs');
  // Missing binary would give CLI_NOT_INSTALLED if spawn were attempted;
  // validation must win with TASK_INTENT_ACCESS_CONFLICT.
  await assert.rejects(
    review({
      provider: 'codex',
      prompt: 'x',
      taskIntent: 'review',
      accessProfile: 'full',
      workspace: mkdtempSync(join(tmpdir(), 'red-nosapwn-')),
      env: { ...process.env, CODEX_BIN: '/definitely/missing/codex' },
    }),
    (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
  );
});

// ---- ai.review protocol ----
test('RED: ai.review is additive under webmcp-tool-v1 (no v2)', async () => {
  assert.equal(TOOL_PROTOCOL, 'webmcp-tool-v1');
  const desc = describeTools();
  assert.equal(desc.protocol, 'webmcp-tool-v1');
  const ids = desc.tools.map((t) => t.id).sort();
  assert.ok(ids.includes('ai.generate'), 'keeps ai.generate');
  assert.ok(ids.includes('ai.review'), 'adds ai.review');
  assert.equal(desc.tools.some((t) => (t.id || '').includes('v2')), false);
  const reviewTool = desc.tools.find((t) => t.id === 'ai.review');
  assert.equal(reviewTool.risk, 'review');
  assert.ok(reviewTool.inputSchema.required.includes('provider'));
  assert.ok(reviewTool.inputSchema.required.includes('prompt'));
});

// ---- review result validation ----
test('RED: missing verdict and plan-only output are REVIEW_RESULT_INCOMPLETE', async () => {
  const mod = await import('../src/review-result.mjs');
  assert.equal(mod.REVIEW_RESULT_SCHEMA, 'webmcp-ai-review-result/1');
  assert.deepEqual([...mod.REVIEW_VERDICTS].sort(), ['approve', 'blocked', 'indeterminate', 'request-changes']);
  assert.deepEqual([...mod.REVIEW_FINDING_SEVERITIES].sort(), ['critical', 'high', 'low', 'medium']);
  const ok = mod.validateReviewResult(JSON.stringify({ schema: 'webmcp-ai-review-result/1', verdict: 'approve', summary: 'looks good' }));
  assert.equal(ok.verdict, 'approve');
  for (const bad of [
    'not json at all',
    '',
    JSON.stringify({ schema: 'webmcp-ai-review-result/1' }),
    JSON.stringify({ schema: 'webmcp-ai-review-result/1', verdict: 'maybe', summary: 'x' }),
    JSON.stringify({ schema: 'webmcp-ai-review-result/1', verdict: 'approve' }),
    JSON.stringify({ schema: 'webmcp-ai-review-result/1', verdict: 'blocked', summary: 'bad' }),
    JSON.stringify({ plan: 'do things', steps: [] }),
    JSON.stringify({ agent: 'plan', text: 'here is a plan' }),
  ]) {
    assert.throws(() => mod.validateReviewResult(bad), (e) => e.code === 'REVIEW_RESULT_INCOMPLETE', bad.slice(0, 80));
  }
});

test('F1: frozen plan example payload validates and approve rejects actionable findings', async () => {
  const mod = await import('../src/review-result.mjs');
  // Exact example from plan-task-intent-and-review-profiles.md §6.
  const example = {
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
  const parsed = mod.validateReviewResult(JSON.stringify(example));
  assert.equal(parsed.verdict, 'request-changes');
  assert.equal(parsed.findings[0].id, 'F1');
  assert.equal(parsed.findings[0].severity, 'high');
  // info is not in the frozen enum.
  assert.throws(
    () => mod.validateReviewResult(JSON.stringify({
      schema: 'webmcp-ai-review-result/1', verdict: 'request-changes', summary: 'x',
      findings: [{ id: 'F1', severity: 'info', message: 'm', recommendation: 'r' }],
    })),
    (e) => e.code === 'REVIEW_RESULT_INCOMPLETE',
  );
  // approve must reject critical/high/medium, allow low or empty.
  for (const sev of ['critical', 'high', 'medium']) {
    assert.throws(
      () => mod.validateReviewResult(JSON.stringify({
        schema: 'webmcp-ai-review-result/1', verdict: 'approve', summary: 'ok',
        findings: [{ id: 'F1', severity: sev, message: 'm', recommendation: 'r' }],
      })),
      (e) => e.code === 'REVIEW_RESULT_INCOMPLETE',
      `approve with ${sev} must fail`,
    );
  }
  const approveLow = mod.validateReviewResult(JSON.stringify({
    schema: 'webmcp-ai-review-result/1', verdict: 'approve', summary: 'ok',
    findings: [{ id: 'F1', severity: 'low', message: 'nit', recommendation: 'polish' }],
  }));
  assert.equal(approveLow.verdict, 'approve');
  // Architectural finding without file/line is allowed.
  const arch = mod.validateReviewResult(JSON.stringify({
    schema: 'webmcp-ai-review-result/1', verdict: 'request-changes', summary: 'x',
    findings: [{ id: 'A1', severity: 'medium', message: 'arch', recommendation: 'refactor' }],
  }));
  assert.equal(arch.findings[0].id, 'A1');
  // line without file is malformed.
  assert.throws(
    () => mod.validateReviewResult(JSON.stringify({
      schema: 'webmcp-ai-review-result/1', verdict: 'request-changes', summary: 'x',
      findings: [{ id: 'F1', severity: 'low', line: 3, message: 'm', recommendation: 'r' }],
    })),
    (e) => e.code === 'REVIEW_RESULT_INCOMPLETE',
  );
  for (const malformedLine of ['42', true]) {
    assert.throws(
      () => mod.validateReviewResult(JSON.stringify({
        schema: 'webmcp-ai-review-result/1', verdict: 'request-changes', summary: 'x',
        findings: [{ id: 'F1', severity: 'low', file: 'src/a.mjs', line: malformedLine, message: 'm', recommendation: 'r' }],
      })),
      (e) => e.code === 'REVIEW_RESULT_INCOMPLETE',
      `line ${JSON.stringify(malformedLine)} must not be coerced`,
    );
  }
  // Safe aliases: summary->message and path->file apply only as fallback.
  const aliased = mod.validateReviewResult({
    schema: 'webmcp-ai-review-result/1', verdict: 'request-changes', summary: 'x',
    findings: [{ id: 'F1', severity: 'low', path: 'src/a.mjs', summary: 'legacy summary', recommendation: 'r' }],
  });
  assert.equal(aliased.findings[0].message, 'legacy summary');
  assert.equal(aliased.findings[0].file, 'src/a.mjs');
  // Canonical wins when both present (never silently discards canonical).
  const both = mod.validateReviewResult({
    schema: 'webmcp-ai-review-result/1', verdict: 'request-changes', summary: 'x',
    findings: [{ id: 'F1', severity: 'low', file: 'src/canonical.mjs', path: 'src/legacy.mjs', message: 'canonical', summary: 'legacy', recommendation: 'r' }],
  });
  assert.equal(both.findings[0].file, 'src/canonical.mjs');
  assert.equal(both.findings[0].message, 'canonical');
});

// ---- provider invocation mapping ----
test('RED: claude reviewer uses dontAsk plus read tools, denies edit/write/MCP/Chrome, no Plan mode', async () => {
  const invocation = getProvider('claude').buildInvocation({
    prompt: 'review this',
    timeoutMs: 1000,
    taskIntent: 'review',
    accessProfile: 'review-readonly',
  });
  const args = invocation.args;
  const joined = args.join(' ');
  assert.match(joined, /dontAsk/, 'must use dontAsk');
  assert.match(joined, /Read/, 'must allow read tools');
  assert.match(joined, /Glob/, 'must allow Glob');
  assert.match(joined, /Grep/, 'must allow Grep');
  // Explicit deny flags (defence-in-depth) + safe-mode.
  assert.ok(args.includes('--disallowedTools'), 'explicit deny flag');
  const denyVal = args[args.indexOf('--disallowedTools') + 1] || '';
  assert.match(denyVal, /Edit/, 'denies Edit');
  assert.match(denyVal, /Write/, 'denies Write');
  assert.match(denyVal, /NotebookEdit/, 'denies NotebookEdit');
  assert.ok(args.includes('--safe-mode'), 'preserves safe-mode');
  assert.equal(invocation.args.includes('--no-chrome'), true);
  assert.equal(invocation.args.includes('--no-session-persistence'), true);
  // Allowlist must not grant writes; denylist carries the Edit token.
  const toolsIdx = args.indexOf('--tools');
  assert.match(args[toolsIdx + 1] || '', /Read/);
  assert.equal((args[toolsIdx + 1] || '').includes('Edit'), false, 'allowlist must not grant Edit');
  assert.equal(joined.includes('MCP'), false);
  assert.equal(invocation.stdin, 'review this');
  // Native telemetry: events requested uses stream-json --verbose.
  const streamed = getProvider('claude').buildInvocation({
    prompt: 'review this', timeoutMs: 1000,
    taskIntent: 'review', accessProfile: 'review-readonly',
    eventsRequested: true,
  });
  assert.ok(streamed.args.includes('stream-json'), 'events use native stream-json');
  assert.ok(streamed.args.includes('--verbose'), 'events use --verbose');
  const plain = getProvider('claude').buildInvocation({
    prompt: 'review this', timeoutMs: 1000,
    taskIntent: 'review', accessProfile: 'review-readonly',
    eventsRequested: false,
  });
  assert.ok(plain.args.includes('json'));
  assert.equal(plain.args.includes('stream-json'), false);
  // Plan is uniformly rejected; implement requires full; compose allows only compose-only.
  assert.throws(
    () => getProvider('claude').buildInvocation({ prompt: 'x', timeoutMs: 1000, taskIntent: 'plan', accessProfile: 'review-readonly' }),
    (e) => e.code === 'UNSUPPORTED_CAPABILITY',
  );
  assert.throws(
    () => getProvider('claude').buildInvocation({ prompt: 'x', timeoutMs: 1000, taskIntent: 'implement', accessProfile: 'review-readonly' }),
    (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
  );
  assert.throws(
    () => getProvider('claude').buildInvocation({ prompt: 'x', timeoutMs: 1000, taskIntent: 'nonsense' }),
    (e) => e.code === 'TASK_INTENT_INVALID',
  );
});

test('RED: codex reviewer exposes read-only ephemeral sandbox, preserves full/resume', async () => {
  const ro = getProvider('codex').buildInvocation({
    prompt: 'x', timeoutMs: 1000, taskIntent: 'review', accessProfile: 'review-readonly',
  });
  assert.ok(ro.args.includes('--ephemeral'));
  assert.ok(ro.args.includes('--ignore-user-config'));
  assert.ok(ro.args.includes('read-only'));
  ro.cleanup?.();
  const full = getProvider('codex').buildInvocation({
    prompt: 'x', timeoutMs: 1000, taskIntent: 'implement', accessProfile: 'full',
  });
  assert.ok(full.args.includes('workspace-write'));
  full.cleanup?.();
  const resume = getProvider('codex').buildInvocation({
    prompt: 'x', timeoutMs: 1000, taskIntent: 'review', accessProfile: 'review-readonly', sessionId: 'sess-1',
  });
  assert.deepEqual(resume.args.slice(0, 2), ['exec', 'resume']);
  resume.cleanup?.();
  // F4: plan is uniformly rejected, never silently executed.
  assert.throws(
    () => getProvider('codex').buildInvocation({ prompt: 'x', timeoutMs: 1000, taskIntent: 'plan', accessProfile: 'review-readonly' }),
    (e) => e.code === 'UNSUPPORTED_CAPABILITY',
  );
  // Implement without full is a typed conflict; bounded-edit has no Codex primitive.
  assert.throws(
    () => getProvider('codex').buildInvocation({ prompt: 'x', timeoutMs: 1000, taskIntent: 'implement', accessProfile: 'review-readonly' }),
    (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT' || e.code === 'UNSUPPORTED_CAPABILITY',
  );
});

test('RED: opencode vNext review does not default to native plan; preserves isolation and DB', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'red-opencode-review-'));
  try {
    const invocation = getProvider('opencode').buildInvocation({
      prompt: 'review this',
      timeoutMs: 1000,
      workspace: ws,
      taskIntent: 'review',
      accessProfile: 'review-readonly',
      allowedReadRoots: [ws],
      allowedWriteRoots: [],
      protectedPaths: [],
      env: {},
    });
    const agent = invocation.args[invocation.args.indexOf('--agent') + 1];
    assert.equal(agent, 'build', 'vNext review uses known built-in build agent, never native plan');
    const cfg = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT);
    assert.ok(Array.isArray(cfg.permissions));
    assert.equal(cfg.permission, undefined);
    assert.ok(cfg.permissions.some((r) => r.action === 'read' && r.effect === 'allow'));
    assert.ok(!cfg.permissions.some((r) => r.action === 'edit' && r.effect === 'allow'));
    assert.ok(invocation.env.OPENCODE_DB.endsWith('opencode.db'));
    invocation.cleanup?.();
    // legacy v1 plan/build compatibility
    const legacyPlan = getProvider('opencode').buildInvocation({
      prompt: 'x', timeoutMs: 1000, workspace: ws, agentMode: 'plan', env: {},
    });
    assert.equal(legacyPlan.args[legacyPlan.args.indexOf('--agent') + 1], 'plan');
    legacyPlan.cleanup?.();
    const legacyBuild = getProvider('opencode').buildInvocation({
      prompt: 'x', timeoutMs: 1000, workspace: ws, agentMode: 'accept-edits', env: {},
    });
    assert.equal(legacyBuild.args[legacyBuild.args.indexOf('--agent') + 1], 'build');
    legacyBuild.cleanup?.();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('RED: agy reviewer is typed UNSUPPORTED_CAPABILITY', async () => {
  for (const intent of ['review', 'plan', 'compose', 'implement']) {
    assert.throws(
      () => getProvider('agy').buildInvocation({
        prompt: 'x', timeoutMs: 1000, taskIntent: intent, accessProfile: 'review-readonly', workspace: '/tmp',
      }),
      (e) => e.code === 'UNSUPPORTED_CAPABILITY',
      `agy ${intent} must be unsupported`,
    );
  }
  assert.throws(
    () => getProvider('agy').buildInvocation({ prompt: 'x', timeoutMs: 1000, taskIntent: 'nonsense' }),
    (e) => e.code === 'TASK_INTENT_INVALID',
  );
});

test('F4: no vNext intent implicitly selects native Plan mode', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'f4-noplan-'));
  try {
    // OpenCode compose uses build + deny-all, never native plan.
    const compose = getProvider('opencode').buildInvocation({
      prompt: 'compose this', timeoutMs: 1000, workspace: ws,
      taskIntent: 'compose', accessProfile: 'compose-only',
      allowedReadRoots: [], allowedWriteRoots: [], protectedPaths: [], env: {},
    });
    assert.equal(compose.args[compose.args.indexOf('--agent') + 1], 'build');
    assert.equal(compose.args.includes('--auto'), false);
    const cfg = JSON.parse(compose.env.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(cfg.permissions, [{ action: '*', resource: '*', effect: 'deny' }]);
    assert.equal(cfg.permission, undefined);
    assert.ok(compose.env.OPENCODE_DB.endsWith('opencode.db'));
    compose.cleanup?.();
    // OpenCode plan uniformly rejected.
    assert.throws(
      () => getProvider('opencode').buildInvocation({
        prompt: 'x', timeoutMs: 1000, workspace: ws,
        taskIntent: 'plan', accessProfile: 'review-readonly',
        allowedReadRoots: [ws], allowedWriteRoots: [], protectedPaths: [], env: {},
      }),
      (e) => e.code === 'UNSUPPORTED_CAPABILITY',
    );
    // Unknown intents are typed invalid on every adapter.
    for (const id of ['claude', 'codex', 'opencode', 'agy']) {
      assert.throws(
        () => getProvider(id).buildInvocation({ prompt: 'x', timeoutMs: 1000, workspace: ws, taskIntent: 'teleport', env: {} }),
        (e) => e.code === 'TASK_INTENT_INVALID',
        `${id} unknown intent`,
      );
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---- legacy compatibility ----
test('RED: legacy generate, tool-call, agentMode and full stay compatible', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'red-legacy-'));
  try {
    const env = { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' };
    const gen = await generate({ provider: 'opencode', prompt: 'hi', workspace: ws, accessProfile: 'full', env });
    assert.equal(gen.ok, true);
    const tool = await handleToolCall({
      protocol: TOOL_PROTOCOL, requestId: 'legacy-1', tool: 'ai.generate',
      input: { provider: 'opencode', prompt: 'hi', workspace: ws, accessProfile: 'full' },
    }, { env });
    assert.equal(tool.ok, true);
    // agentMode legacy still accepted for opencode/agy generate
    const agyEnv = { ...process.env, AGY_BIN: fakeBin, FAKE_PROVIDER: 'agy' };
    const agy = await generate({ provider: 'agy', prompt: 'hi', agentMode: 'plan', env: agyEnv });
    assert.equal(agy.ok, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
