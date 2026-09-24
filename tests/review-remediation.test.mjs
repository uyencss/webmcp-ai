import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const fakeBin = fileURLToPath(new URL('./fixtures/fake-ai-cli.mjs', import.meta.url));
const bin = fileURLToPath(new URL('../bin/webmcp-ai.mjs', import.meta.url));
chmodSync(fakeBin, 0o755);

// F1: compose preview must not touch caller .agents
test('F1 RED: sentinel .agents file survives review dry-run and invalid requests', async () => {
  const { describeReviewDryRun, resolveReviewRequest } = await import('../src/review.mjs');
  const ws = mkdtempSync(join(tmpdir(), 'f1-sentinel-'));
  const agentsDir = join(ws, '.agents');
  mkdirSync(agentsDir, { recursive: true });
  const sentinel = join(agentsDir, 'webmcp-coordination.md');
  writeFileSync(sentinel, 'sentinel-must-survive');
  try {
    // valid review dry-run must preserve sentinel
    const preview = describeReviewDryRun({
      provider: 'opencode', prompt: 'review me', taskIntent: 'review', workspace: ws,
      env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' },
    });
    assert.equal(preview.ok, true);
    assert.equal(existsSync(sentinel), true, 'valid dry-run must not delete sentinel');
    assert.equal(readFileSync(sentinel, 'utf8'), 'sentinel-must-survive');
    // invalid compose/implement must reject BEFORE any provider invocation (no-spawn + no mutation)
    for (const bad of [
      { provider: 'opencode', prompt: 'x', taskIntent: 'compose', workspace: ws },
      { provider: 'opencode', prompt: 'x', taskIntent: 'implement', accessProfile: 'full', workspace: ws },
      { provider: 'agy', prompt: 'x', taskIntent: 'compose', workspace: ws },
    ]) {
      await assert.rejects(
        (async () => resolveReviewRequest({ ...bad, env: { ...process.env, AGY_BIN: '/definitely/missing/agy', OPENCODE_BIN: '/definitely/missing/opencode' } }))(),
        (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT' || e.code === 'UNSUPPORTED_CAPABILITY' || e.code === 'INVALID_INPUT',
        JSON.stringify(bad),
      );
      assert.equal(existsSync(sentinel), true, `sentinel must survive rejected ${JSON.stringify(bad)}`);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// F2: ai.review read-only only
test('F2 RED: ai.review rejects every write-capable combination before spawn', async () => {
  const { handleToolCall, TOOL_PROTOCOL } = await import('../src/protocol.mjs');
  const ws = mkdtempSync(join(tmpdir(), 'f2-write-'));
  try {
    const missingEnv = {
      ...process.env,
      AGY_BIN: '/definitely/missing/agy',
      CLAUDE_BIN: '/definitely/missing/claude',
      CODEX_BIN: '/definitely/missing/codex',
      OPENCODE_BIN: '/definitely/missing/opencode',
    };
    const writeCombos = [
      { provider: 'opencode', prompt: 'x', workspace: ws, taskIntent: 'implement', accessProfile: 'bounded-edit', allowedWriteRoots: [ws] },
      { provider: 'opencode', prompt: 'x', workspace: ws, taskIntent: 'implement', accessProfile: 'full' },
      { provider: 'opencode', prompt: 'x', workspace: ws, taskIntent: 'review', accessProfile: 'bounded-edit' },
      { provider: 'opencode', prompt: 'x', workspace: ws, taskIntent: 'review', accessProfile: 'full' },
      { provider: 'opencode', prompt: 'x', workspace: ws, taskIntent: 'compose' },
      { provider: 'opencode', prompt: 'x', workspace: ws, accessProfile: 'bounded-edit', allowedWriteRoots: [ws] },
      { provider: 'opencode', prompt: 'x', workspace: ws, accessProfile: 'full' },
      { provider: 'codex', prompt: 'x', workspace: ws, taskIntent: 'implement', accessProfile: 'full' },
      { provider: 'opencode', prompt: 'x', workspace: ws, allowedWriteRoots: [ws] },
      { provider: 'opencode', prompt: 'x', workspace: ws, agentMode: 'plan' },
      { provider: 'opencode', prompt: 'x', workspace: ws, agent: 'plan' },
      { provider: 'opencode', prompt: 'x', workspace: ws, toolPolicy: 'compose-only' },
      { provider: 'opencode', prompt: 'x', workspace: ws, schema: { type: 'object' } },
      { provider: 'opencode', prompt: 'x', workspace: ws, gatewayCapabilityHandle: 'h' },
      { provider: 'opencode', prompt: 'x', workspace: ws, gatewayHandle: 'h' },
      { provider: 'opencode', prompt: 'x', workspace: ws, mcpConfig: {} },
    ];
    for (const input of writeCombos) {
      await assert.rejects(
        handleToolCall({ protocol: TOOL_PROTOCOL, requestId: 'f2', tool: 'ai.review', input }, { env: missingEnv }),
        (e) => e.code === 'INVALID_INPUT' || e.code === 'UNSUPPORTED_CAPABILITY' || e.code === 'TASK_INTENT_ACCESS_CONFLICT',
        JSON.stringify(input),
      );
    }
    // missing-binary no-spawn proof: contradiction must win over CLI_NOT_INSTALLED
    await assert.rejects(
      handleToolCall({
        protocol: TOOL_PROTOCOL, requestId: 'f2-noswpawn', tool: 'ai.review',
        input: { provider: 'codex', prompt: 'x', workspace: ws, taskIntent: 'review', accessProfile: 'full' },
      }, { env: missingEnv }),
      (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// F3: Claude deny flags
test('F3 RED: claude review has explicit deny flags and safe-mode, drift is typed', async () => {
  const { getProvider } = await import('../src/providers/index.mjs');
  const invocation = getProvider('claude').buildInvocation({
    prompt: 'review this', timeoutMs: 1000, taskIntent: 'review', accessProfile: 'review-readonly',
  });
  const args = invocation.args;
  assert.ok(args.includes('dontAsk'), 'keeps dontAsk');
  assert.ok(args.includes('Read,Glob,Grep') || args.join(' ').includes('Read'), 'keeps read tools');
  assert.ok(args.includes('--disallowedTools'), 'explicit deny flag');
  const denyIdx = args.indexOf('--disallowedTools');
  const denyVal = args[denyIdx + 1] || '';
  assert.match(denyVal, /Edit/, 'denies Edit');
  assert.match(denyVal, /Write/, 'denies Write');
  assert.match(denyVal, /NotebookEdit/, 'denies NotebookEdit');
  assert.ok(args.includes('--safe-mode'), 'preserves safe-mode');
  assert.ok(args.includes('--no-chrome'), 'keeps no-chrome');
  assert.ok(args.includes('--no-session-persistence'), 'keeps no-session-persistence');
  // drifted help must throw typed drift, never full fallback
  const { validateClaudeReviewSupport } = await import('../src/providers/claude.mjs');
  assert.throws(
    () => validateClaudeReviewSupport('claude 0.0 fake --help without flags'),
    (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT' || e.code === 'UNSUPPORTED_CAPABILITY',
  );
  assert.throws(
    () => validateClaudeReviewSupport('--permission-mode-old --tools-old --disallowedTools-old --safe-mode-old --no-chrome-old --no-session-persistence-old'),
    (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT',
    'Claude option names must be matched on token boundaries',
  );
  assert.ok(validateClaudeReviewSupport('... -p --permission-mode ... --tools ... --disallowedTools ... --safe-mode ... --no-chrome ... --output-format json stream-json --verbose --no-session-persistence --resume --model --effort ...'));
  // events contract: stream-json --verbose only when requested; review lane disallows events.
  const streamed = getProvider('claude').buildInvocation({
    prompt: 'review this', timeoutMs: 1000, taskIntent: 'review', accessProfile: 'review-readonly', eventsRequested: true,
  });
  assert.ok(streamed.args.includes('stream-json') && streamed.args.includes('--verbose'));
  const { review } = await import('../src/review.mjs');
  await assert.rejects(
    review({ provider: 'claude', prompt: 'x', workspace: mkdtempSync(join(tmpdir(), 'f3-events-')), onEvent: () => {}, env: process.env }),
    (e) => e.code === 'INVALID_INPUT',
  );
});

// F4: OpenCode known agent
test('F4 RED: opencode review uses known build agent with read-only config', async () => {
  const { getProvider } = await import('../src/providers/index.mjs');
  const ws = mkdtempSync(join(tmpdir(), 'f4-agent-'));
  try {
    const invocation = getProvider('opencode').buildInvocation({
      prompt: 'review this', timeoutMs: 1000, workspace: ws,
      taskIntent: 'review', accessProfile: 'review-readonly',
      allowedReadRoots: [ws], allowedWriteRoots: [], protectedPaths: [], env: {},
    });
    const agent = invocation.args[invocation.args.indexOf('--agent') + 1];
    assert.equal(agent, 'build', 'review uses known built-in build agent, not unproven review');
    const cfg = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT);
    assert.ok(Array.isArray(cfg.permissions));
    assert.equal(cfg.permission, undefined);
    assert.ok(cfg.permissions.some((r) => r.action === 'read' && r.effect === 'allow'));
    assert.ok(!cfg.permissions.some((r) => r.action === 'edit' && r.effect === 'allow'));
    assert.ok(invocation.env.OPENCODE_DB.endsWith('opencode.db'));
    invocation.cleanup?.();
    // explicit agent for review must fail typed
    assert.throws(
      () => getProvider('opencode').buildInvocation({
        prompt: 'x', timeoutMs: 1000, workspace: ws,
        taskIntent: 'review', accessProfile: 'review-readonly',
        allowedReadRoots: [ws], allowedWriteRoots: [], protectedPaths: [], agent: 'review', env: {},
      }),
      (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT' || e.code === 'UNSUPPORTED_CAPABILITY' || e.code === 'INVALID_INPUT',
    );
    // legacy without taskIntent still plan/build
    const legacyPlan = getProvider('opencode').buildInvocation({ prompt: 'x', timeoutMs: 1000, workspace: ws, agentMode: 'plan', env: {} });
    assert.equal(legacyPlan.args[legacyPlan.args.indexOf('--agent') + 1], 'plan');
    legacyPlan.cleanup?.();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// F5: dry-run redaction
test('F5 RED: dry-run never leaks prompt, paths, or temp output', async () => {
  const { describeReviewDryRun } = await import('../src/review.mjs');
  const ws = mkdtempSync(join(tmpdir(), 'f5-dry-'));
  try {
    // AGY must reject before preview
    await assert.rejects(
      (async () => describeReviewDryRun({ provider: 'agy', prompt: 'secret-prompt', workspace: ws, env: process.env }))(),
      (e) => e.code === 'UNSUPPORTED_CAPABILITY',
    );
    for (const provider of ['codex', 'opencode', 'claude']) {
      const preview = describeReviewDryRun({
        provider, prompt: 'super-secret-prompt-xyz', taskIntent: 'review', workspace: ws,
        env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: provider, GITHUB_TOKEN: 'leak' },
      });
      const str = JSON.stringify(preview);
      assert.equal(str.includes('super-secret-prompt-xyz'), false, `${provider} leaks prompt`);
      assert.equal(str.includes(ws), false, `${provider} leaks workspace`);
      assert.equal(str.includes('last-message.txt'), false, `${provider} leaks temp output path`);
      assert.equal(str.includes('/tmp/'), false, `${provider} leaks tmp path`);
      assert.equal(str.includes('GITHUB_TOKEN'), false);
      assert.equal(str.includes('leak'), false);
      assert.ok(preview.capability.workspaceDigest, 'digests only');
      assert.ok(preview.promptDigest, 'prompt digest only');
    }
    // compose/invalid dry-run must reject, not preview
    for (const bad of [
      { provider: 'opencode', prompt: 'x', workspace: ws, taskIntent: 'compose' },
      { provider: 'opencode', prompt: 'x', workspace: ws, taskIntent: 'implement', accessProfile: 'full' },
    ]) {
      await assert.rejects(
        (async () => describeReviewDryRun({ ...bad, env: process.env }))(),
        (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT' || e.code === 'UNSUPPORTED_CAPABILITY' || e.code === 'INVALID_INPUT',
      );
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// F6: schema contract
test('F6 RED: review result uses schema, blockedReason, findings, plan rejected', async () => {
  const mod = await import('../src/review-result.mjs');
  assert.equal(mod.REVIEW_RESULT_SCHEMA, 'webmcp-ai-review-result/1');
  assert.deepEqual([...mod.REVIEW_FINDING_SEVERITIES].sort(), ['critical', 'high', 'low', 'medium']);
  const ok = mod.validateReviewResult(JSON.stringify({
    schema: 'webmcp-ai-review-result/1', verdict: 'approve', summary: 'looks good',
  }));
  assert.equal(ok.verdict, 'approve');
  // blocked without blockedReason fails
  assert.throws(
    () => mod.validateReviewResult(JSON.stringify({ schema: 'webmcp-ai-review-result/1', verdict: 'blocked', summary: 'bad' })),
    (e) => e.code === 'REVIEW_RESULT_INCOMPLETE',
  );
  const blockedOk = mod.validateReviewResult(JSON.stringify({
    schema: 'webmcp-ai-review-result/1', verdict: 'blocked', summary: 'bad', blockedReason: 'tests fail',
  }));
  assert.equal(blockedOk.verdict, 'blocked');
  // findings shape/severity use frozen enum + canonical fields
  assert.throws(
    () => mod.validateReviewResult(JSON.stringify({
      schema: 'webmcp-ai-review-result/1', verdict: 'request-changes', summary: 'x',
      findings: [{ id: 'F1', severity: 'bogus', message: 'y', recommendation: 'r' }],
    })),
    (e) => e.code === 'REVIEW_RESULT_INCOMPLETE',
  );
  assert.throws(
    () => mod.validateReviewResult(JSON.stringify({
      schema: 'webmcp-ai-review-result/1', verdict: 'request-changes', summary: 'x',
      findings: [{ id: 'F1', severity: 'high', message: 'y' }],
    })),
    (e) => e.code === 'REVIEW_RESULT_INCOMPLETE',
  );
  // approve cannot carry actionable findings (critical/high/medium)
  assert.throws(
    () => mod.validateReviewResult(JSON.stringify({
      schema: 'webmcp-ai-review-result/1', verdict: 'approve', summary: 'ok',
      findings: [{ id: 'F1', severity: 'high', message: 'must fix', recommendation: 'fix it' }],
    })),
    (e) => e.code === 'REVIEW_RESULT_INCOMPLETE',
  );
  const approveLow = mod.validateReviewResult(JSON.stringify({
    schema: 'webmcp-ai-review-result/1', verdict: 'approve', summary: 'ok',
    findings: [{ id: 'F1', severity: 'low', message: 'nit', recommendation: 'polish' }],
  }));
  assert.equal(approveLow.verdict, 'approve');
  // plan must not validate as review
  const { resolveReviewRequest } = await import('../src/review.mjs');
  const ws = mkdtempSync(join(tmpdir(), 'f6-plan-'));
  try {
    assert.throws(
      () => resolveReviewRequest({ provider: 'opencode', prompt: 'x', workspace: ws, taskIntent: 'plan' }),
      (e) => e.code === 'TASK_INTENT_ACCESS_CONFLICT' || e.code === 'UNSUPPORTED_CAPABILITY' || e.code === 'INVALID_INPUT',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('F6 RED: providers inspect --task-intent review and generate --dry-run exist and are sanitized', async () => {
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /task-intent/i);
  assert.match(help.stdout, /dry-run/i);
  // providers inspect with review intent
  const ws = mkdtempSync(join(tmpdir(), 'f6-inspect-'));
  try {
    const inspect = spawnSync(process.execPath, [bin, 'providers', 'inspect', 'opencode', '--task-intent', 'review', '--json'], {
      encoding: 'utf8', env: { ...process.env, OPENCODE_BIN: fakeBin },
    });
    assert.equal(inspect.status, 0, inspect.stderr);
    const payload = JSON.parse(inspect.stdout);
    assert.equal(payload.ok, true);
    assert.equal(JSON.stringify(payload).includes(ws), false);
    const agyInspect = spawnSync(process.execPath, [bin, 'providers', 'inspect', 'agy', '--task-intent', 'review', '--json'], {
      encoding: 'utf8', env: process.env,
    });
    assert.equal(agyInspect.status, 0);
    assert.equal(JSON.parse(agyInspect.stdout).supported, false);
    // generate dry-run sanitized, no spawn (missing binary still succeeds)
    const dry = spawnSync(process.execPath, [bin, 'generate', '--provider', 'opencode', '--prompt', 'secret-xyz', '--workspace', ws, '--dry-run', '--json'], {
      encoding: 'utf8', env: { ...process.env, OPENCODE_BIN: '/definitely/missing/opencode' },
    });
    assert.equal(dry.status, 0, dry.stderr);
    const dryPayload = JSON.parse(dry.stdout);
    assert.equal(dryPayload.dryRun, true);
    assert.equal(JSON.stringify(dryPayload).includes('secret-xyz'), false);
    assert.equal(JSON.stringify(dryPayload).includes(ws), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
