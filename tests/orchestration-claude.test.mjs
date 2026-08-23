import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildClaudeInvocation,
  createClaudeStreamAdapter,
  normalizeClaudeEvent,
} from '../src/orchestration/adapters/claude-stream.mjs';

const fakeClaude = fileURLToPath(new URL('./fixtures/orchestration/fake-claude.mjs', import.meta.url));
const streamFixture = fileURLToPath(new URL('./fixtures/orchestration/streams/claude.ndjson', import.meta.url));
const hookScript = fileURLToPath(new URL('../scripts/orchestration-hook.mjs', import.meta.url));

function tempDir(t, name = 'cl') {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-t7-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('claude stream parsing captures identity and boundaries without raw payloads', () => {
  const lines = readFileSync(streamFixture, 'utf8').split('\n').filter(Boolean);
  const binding = { sessionId: null };
  const mapped = lines
    .map((line) => normalizeClaudeEvent(JSON.parse(line), binding)).flat()
    .filter(Boolean);

  const serialized = JSON.stringify(mapped);
  assert.equal(serialized.includes('private reasoning'), false, 'thinking blocks are dropped');
  assert.equal(serialized.includes('RAW_TOOL_OUTPUT_SHOULD_NOT_PERSIST_VERBATIM'), false, 'tool output is bounded away');
  assert.equal(serialized.includes('ses_claude_fixture'), true, 'explicit session id captured');

  const init = mapped.find((entry) => entry.kind === 'session_init');
  assert.ok(init);
  assert.equal(init.payload.sessionId, 'ses_claude_fixture');

  const toolUse = mapped.find((entry) => entry.kind === 'tool_use');
  assert.ok(toolUse);
  assert.equal(toolUse.payload.tool, 'Edit');

  const toolResult = mapped.find((entry) => entry.kind === 'tool_result');
  assert.ok(toolResult);
  assert.equal(toolResult.payload.outputOmitted, true);

  const finalResult = mapped.find((entry) => entry.kind === 'result_success');
  assert.ok(finalResult);
  assert.equal(finalResult.payload.tokensTotal, 30);
  assert.match(finalResult.summary, /final summary text/);

  const errorResult = mapped.find((entry) => entry.kind === 'result_error');
  assert.ok(errorResult);
});

test('new sessions use a runtime-generated UUID; resume reuses the exact id', (t) => {
  const invocation = buildClaudeInvocation({ sessionId: null, promptFileMode: 'stdin' });
  const sessionIdIndex = invocation.args.indexOf('--session-id');
  assert.notEqual(sessionIdIndex, -1);
  const generated = invocation.args[sessionIdIndex + 1];
  assert.match(generated, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  for (const flag of ['-p', '--output-format', '--verbose', '--no-chrome', '--safe-mode']) {
    assert.equal(invocation.args.includes(flag), true, `missing ${flag}`);
  }
  assert.equal(invocation.args.includes('--continue'), false);

  const resumed = buildClaudeInvocation({ sessionId: generated });
  assert.deepEqual(
    resumed.args.slice(resumed.args.indexOf('--resume'), resumed.args.indexOf('--resume') + 2),
    ['--resume', generated],
    'resume passes the exact runtime-created session id',
  );
  assert.equal(resumed.args.includes('--continue'), false);
});

test('the fake CLI enforces the argument contract for baseline and hook modes', (t) => {
  // Baseline run passes.
  const baseline = spawnFake(t, ['assert-args', '-p', '--output-format', 'stream-json',
    '--verbose', '--no-chrome', '--safe-mode', '--session-id', randomUUID()], { FAKE_CLAUDE_MODE: 'assert-args' });
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.match(baseline.stdout, /args-ok:/);

  // A baseline run missing --safe-mode must be rejected by the provider side.
  const unsafe = spawnFake(t, ['assert-args', '-p', '--output-format', 'stream-json',
    '--verbose', '--no-chrome', '--session-id', randomUUID()], { FAKE_CLAUDE_MODE: 'assert-args' });
  assert.equal(unsafe.status, 3);
  assert.match(unsafe.stderr, /safe-mode/);
});

function spawnFake(t, args, env = {}) {
  void t;
  return spawnSync(process.execPath, [fakeClaude, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    input: '',
    env: { ...process.env, ...env },
  });
}

function basePolicyFile(t) {
  const dir = tempDir(t, 'hook');
  const policyPath = join(dir, 'policy.json');
  const capabilityPath = join(dir, 'capability.json');
  writeFileSync(policyPath, `${JSON.stringify({
    schema: 'webmcp.ai-claude-hook-policy/v0',
    workspace: '/ws',
    allowedReadRoots: ['/ws'],
    allowedWriteRoots: ['/ws/src'],
    protectedPaths: ['/ws/package.json'],
    allowedExecutables: [process.execPath],
    capabilityTokenHash: createHash('sha256').update('token-x').digest('hex'),
    coordinationId: 'coord_hook',
    dispatchId: 'disp_hook',
    fenceEpoch: 2,
  })}\n`, 'utf8');
  writeFileSync(capabilityPath, `${JSON.stringify({ token: 'token-x', expiresAt: new Date(Date.now() + 60_000).toISOString(), coordinationId: 'coord_hook', dispatchId: 'disp_hook' })}\n`, 'utf8');
  chmodSync(policyPath, 0o600);
  chmodSync(capabilityPath, 0o600);
  return { dir, policyPath, capabilityPath };
}

function runHook(input, policyPath, capabilityPath, extraEnv = {}) {
  return spawnSync(process.execPath, [hookScript], {
    encoding: 'utf8',
    timeout: 10_000,
    input: JSON.stringify(input),
    env: {
      ...process.env,
      WEBMCP_HOOK_POLICY: policyPath,
      WEBMCP_HOOK_CAPABILITY: capabilityPath,
      ...extraEnv,
    },
  });
}

test('hook gate allows reads and scoped edits, denies protected paths and foreign executables', (t) => {
  const { policyPath, capabilityPath } = basePolicyFile(t);

  const readInside = runHook({ tool_name: 'Read', tool_input: { file_path: '/ws/src/a.ts' } }, policyPath, capabilityPath);
  assert.equal(readInside.status, 0, readInside.stderr);
  assert.equal(JSON.parse(readInside.stdout).decision, 'allow');

  const editInside = runHook({ tool_name: 'Edit', tool_input: { file_path: '/ws/src/a.ts' } }, policyPath, capabilityPath);
  assert.equal(JSON.parse(editInside.stdout).decision, 'allow');
  assert.equal(JSON.parse(editInside.stdout).checkpoint, true);

  const editProtected = runHook({ tool_name: 'Edit', tool_input: { file_path: '/ws/package.json' } }, policyPath, capabilityPath);
  assert.equal(JSON.parse(editProtected.stdout).decision, 'deny');

  const bashForeign = runHook({ tool_name: 'Bash', tool_input: { command: '/usr/bin/curl http://evil' } }, policyPath, capabilityPath);
  assert.equal(JSON.parse(bashForeign.stdout).decision, 'deny');

  const bashAllowed = runHook({ tool_name: 'Bash', tool_input: { command: `${process.execPath} script.js` } }, policyPath, capabilityPath);
  assert.equal(JSON.parse(bashAllowed.stdout).decision, 'allow');
});

test('hook gate denies on missing or expired capability and never leaks secrets', (t) => {
  const { dir, policyPath, capabilityPath } = basePolicyFile(t);

  const missingCap = runHook({ tool_name: 'Edit', tool_input: { file_path: '/ws/src/a.ts' } }, policyPath, join(dir, 'absent-cap.json'));
  assert.equal(JSON.parse(missingCap.stdout).decision, 'deny');

  const expiredPath = join(dir, 'expired-cap.json');
  writeFileSync(expiredPath, `${JSON.stringify({ token: 'token-x', expiresAt: new Date(Date.now() - 1000).toISOString(), coordinationId: 'coord_hook', dispatchId: 'disp_hook' })}\n`, 'utf8');
  const expired = runHook({ tool_name: 'Edit', tool_input: { file_path: '/ws/src/a.ts' } }, policyPath, expiredPath);
  assert.equal(JSON.parse(expired.stdout).decision, 'deny');

  // No capability material ever reaches stdout/stderr.
  const allOutput = missingCap.stdout + missingCap.stderr + expired.stdout;
  assert.equal(allOutput.includes('token-x'), false);
});

test('an unreachable supervisor denies mutable tools while allowing pure reads', (t) => {
  const { policyPath, capabilityPath, dir } = basePolicyFile(t);
  const unreachablePolicy = join(dir, 'unreachable-policy.json');
  const parsed = JSON.parse(readFileSync(policyPath, 'utf8'));
  parsed.supervisorUnreachableForTest = true;
  writeFileSync(unreachablePolicy, `${JSON.stringify(parsed)}\n`, 'utf8');

  const mutableDenied = runHook({ tool_name: 'Edit', tool_input: { file_path: '/ws/src/a.ts' } }, unreachablePolicy, capabilityPath);
  assert.equal(JSON.parse(mutableDenied.stdout).decision, 'deny');

  const readOnlyOk = runHook({ tool_name: 'Read', tool_input: { file_path: '/ws/src/a.ts' } }, unreachablePolicy, capabilityPath);
  assert.equal(JSON.parse(readOnlyOk.stdout).decision, 'allow');
});

test('claude adapter capabilities stay honest before any hook canary', (t) => {
  const adapter = createClaudeStreamAdapter({ stateDir: tempDir(t, 'caps') });
  assert.equal(adapter.capabilities.sameTurnSteer, false);
  assert.equal(adapter.capabilities.preToolGate, false, 'preToolGate stays false until a live isolation canary proves it');
  assert.equal(adapter.capabilities.explicitResume, true);
  assert.equal(adapter.maturity, 'fixture-only');
});

test('follow-up turns are queued, never same-turn steering', async (t) => {
  const stateDir = tempDir(t, 'followup');
  const adapter = createClaudeStreamAdapter({
    stateDir,
    claudeBin: process.execPath,
    claudeArgs: [fakeClaude],
    fakeModeEnv: { FAKE_CLAUDE_MODE: 'busy-followup' },
  });

  const events = [];
  const { done, sendFollowUp } = await adapter.spawn({
    task: { taskId: 'task_c', workspace: '/tmp' },
    dispatch: { dispatchId: 'disp_c', bindingId: 'worker_c', taskId: 'task_c', fenceEpoch: 1 },
    emit: (type, payload) => events.push({ type, payload }),
  });

  const queued = await sendFollowUp('additional guidance');
  assert.equal(queued.classification, 'queued-followup');

  await done;
  const guidance = events.find((event) => event.type === 'guidance');
  assert.ok(guidance);
  assert.equal(guidance.payload.sameTurn, false);
});
