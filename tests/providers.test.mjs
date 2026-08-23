import assert from 'node:assert/strict';
import test from 'node:test';

import { getProvider, listProviders } from '../src/providers/index.mjs';

test('provider registry exposes agy, claude, codex, and opencode', () => {
  assert.deepEqual(listProviders().map((provider) => provider.id), ['agy', 'claude', 'codex', 'opencode']);
  assert.deepEqual(listProviders().find((provider) => provider.id === 'agy').capabilities.toolPolicies, ['provider-default', 'compose-only']);
  assert.deepEqual(listProviders().find((provider) => provider.id === 'codex').capabilities.toolPolicies, ['provider-default', 'compose-only']);
  assert.deepEqual(listProviders().find((provider) => provider.id === 'claude').capabilities.toolPolicies, ['provider-default']);
  assert.deepEqual(listProviders().find((provider) => provider.id === 'opencode').capabilities.toolPolicies, ['provider-default', 'compose-only']);
  assert.throws(() => getProvider('missing'), /Unknown provider/);
});

test('Claude uses stdin, disables tools, and requests JSON output', () => {
  const invocation = getProvider('claude').buildInvocation({
    prompt: 'private prompt',
    model: 'sonnet',
    timeoutMs: 1234,
  });

  assert.equal(invocation.stdin, 'private prompt');
  assert.equal(invocation.args.includes('private prompt'), false);
  assert.deepEqual(invocation.args.slice(0, 4), ['-p', '--tools', '', '--safe-mode']);
  assert.ok(invocation.args.includes('--output-format'));
  assert.ok(invocation.args.includes('--no-session-persistence'));
});

test('Codex uses stdin, an ephemeral read-only sandbox, and an output file', () => {
  const invocation = getProvider('codex').buildInvocation({
    prompt: 'private prompt',
    model: 'gpt-test',
    timeoutMs: 1234,
  });

  assert.equal(invocation.stdin, 'private prompt');
  assert.equal(invocation.args.at(-1), '-');
  assert.ok(invocation.args.includes('--ephemeral'));
  assert.ok(invocation.args.includes('--ignore-user-config'));
  assert.ok(invocation.args.includes('--output-last-message'));
  assert.equal(typeof invocation.cleanup, 'function');
  invocation.cleanup();
});

test('AGY isolates its argument-only prompt limitation and stays sandboxed', () => {
  const invocation = getProvider('agy').buildInvocation({
    prompt: 'agy prompt',
    timeoutMs: 12500,
  });

  assert.equal(invocation.stdin, null);
  assert.deepEqual(invocation.args.slice(0, 2), ['-p', 'agy prompt']);
  assert.ok(invocation.args.includes('--sandbox'));
  assert.ok(invocation.args.includes('plan'));
  assert.ok(invocation.args.includes('13s'));
  assert.equal(invocation.args.includes('--dangerously-skip-permissions'), false);
});

test('AGY permits only an explicit supervised accept-edits mode', () => {
  const invocation = getProvider('agy').buildInvocation({
    prompt: 'agy prompt',
    timeoutMs: 12_500,
    agentMode: 'accept-edits',
    agent: 'webmcp-node-executor',
  });
  assert.equal(invocation.args[invocation.args.indexOf('--mode') + 1], 'accept-edits');
  assert.equal(invocation.args[invocation.args.indexOf('--agent') + 1], 'webmcp-node-executor');
  assert.ok(invocation.args.includes('--sandbox'));
  assert.equal(invocation.args.includes('--dangerously-skip-permissions'), false);
  assert.throws(
    () => getProvider('agy').buildInvocation({
      prompt: 'x', timeoutMs: 1_000, agentMode: 'unsafe',
    }),
    (error) => error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => getProvider('agy').buildInvocation({
      prompt: 'x', timeoutMs: 1_000, agent: '../unsafe',
    }),
    (error) => error.code === 'INVALID_INPUT',
  );
});

test('opencode uses stdin, JSON NDJSON output, and a read-only plan agent by default', () => {
  const invocation = getProvider('opencode').buildInvocation({
    prompt: 'opencode prompt',
    timeoutMs: 1234,
    workspace: '/ws',
  });

  assert.equal(invocation.stdin, 'opencode prompt');
  assert.equal(invocation.args.includes('opencode prompt'), false);
  assert.equal(invocation.args[invocation.args.indexOf('--format') + 1], 'json');
  assert.equal(invocation.args[invocation.args.indexOf('--agent') + 1], 'plan');
  assert.equal(invocation.args.includes('--auto'), false);
  // The injected sandbox must never carry an "ask" value or headless runs hang.
  assert.equal(invocation.env.OPENCODE_CONFIG_CONTENT.includes('"ask"'), false);
  assert.equal(JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT).permission.read, 'allow');
  // CLI invocations use an isolated DB to avoid SQLite lock contention.
  assert.ok(invocation.env.OPENCODE_DB, 'OPENCODE_DB must be set');
  assert.ok(invocation.env.OPENCODE_DB.endsWith('opencode-cli.db'), 'must use opencode-cli.db');
  assert.ok(invocation.env.OPENCODE_DB.includes('/opencode/'), 'must stay in the opencode data directory');
});

test('opencode accept-edits opts into supervised writes with --auto and the build agent', () => {
  const invocation = getProvider('opencode').buildInvocation({
    prompt: 'x',
    timeoutMs: 1234,
    agentMode: 'accept-edits',
    workspace: '/ws',
  });
  assert.ok(invocation.args.includes('--auto'));
  assert.equal(invocation.args[invocation.args.indexOf('--agent') + 1], 'build');
  const permission = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT).permission;
  assert.equal(permission.edit, 'allow');
  assert.equal(permission.bash['rm -rf *'], 'deny');
});

test('opencode fails closed on schema, a bad agent name, and an unknown agentMode', () => {
  assert.throws(
    () => getProvider('opencode').buildInvocation({
      prompt: 'x', schema: {}, timeoutMs: 1000, workspace: '/ws',
    }),
    (error) => error.code === 'UNSUPPORTED_CAPABILITY',
  );
  assert.throws(
    () => getProvider('opencode').buildInvocation({
      prompt: 'x', agent: '../unsafe', timeoutMs: 1000, workspace: '/ws',
    }),
    (error) => error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => getProvider('opencode').buildInvocation({
      prompt: 'x', agentMode: 'unsafe', timeoutMs: 1000, workspace: '/ws',
    }),
    (error) => error.code === 'INVALID_INPUT',
  );
});

test('opencode compose-only denies every tool and never auto-approves', () => {
  const invocation = getProvider('opencode').buildInvocation({
    prompt: 'x',
    timeoutMs: 1000,
    toolPolicy: 'compose-only',
    workspace: '/ws',
  });
  assert.equal(invocation.args.includes('--auto'), false);
  assert.deepEqual(JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT).permission, { '*': 'deny' });
});

test('opencode parses NDJSON events and falls back to raw stdout', () => {
  const ndjson = [
    '{"type":"step_start","timestamp":1786493625120,"sessionID":"ses_TEST","part":{"id":"prt_a","messageID":"msg_a","sessionID":"ses_TEST","type":"step-start"}}',
    '{"type":"text","timestamp":1786493625631,"sessionID":"ses_TEST","part":{"id":"prt_b","messageID":"msg_a","sessionID":"ses_TEST","type":"text","text":"hi","time":{"start":1,"end":2}}}',
    '{"type":"step_finish","timestamp":1786493625631,"sessionID":"ses_TEST","part":{"id":"prt_c","reason":"stop","messageID":"msg_a","sessionID":"ses_TEST","type":"step-finish","tokens":{"total":3580,"input":3578,"output":2,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0.00025074}}',
  ].join('\n');
  assert.deepEqual(getProvider('opencode').parseOutput({ stdout: ndjson }), {
    text: 'hi', structured: null, sessionId: 'ses_TEST',
  });
  assert.deepEqual(getProvider('opencode').parseOutput({ stdout: 'plain fallback' }), {
    text: 'plain fallback', structured: null, sessionId: null,
  });
});

test('non-AGY providers reject Agy agent options instead of silently ignoring them', () => {
  assert.throws(
    () => getProvider('claude').buildInvocation({
      prompt: 'x', timeoutMs: 1_000, agentMode: 'accept-edits',
    }),
    (error) => error.code === 'UNSUPPORTED_CAPABILITY',
  );
  assert.throws(
    () => getProvider('codex').buildInvocation({
      prompt: 'x', timeoutMs: 1_000, agentMode: 'accept-edits',
    }),
    (error) => error.code === 'UNSUPPORTED_CAPABILITY',
  );
  assert.throws(
    () => getProvider('claude').buildInvocation({
      prompt: 'x', timeoutMs: 1_000, agent: 'webmcp-node-executor',
    }),
    (error) => error.code === 'UNSUPPORTED_CAPABILITY',
  );
  assert.throws(
    () => getProvider('codex').buildInvocation({
      prompt: 'x', timeoutMs: 1_000, agent: 'webmcp-node-executor',
    }),
    (error) => error.code === 'UNSUPPORTED_CAPABILITY',
  );
});

test('provider parsers normalize native output', () => {
  assert.deepEqual(getProvider('agy').parseOutput({ stdout: 'hello' }), {
    text: 'hello', structured: null, sessionId: null,
  });
  assert.deepEqual(getProvider('claude').parseOutput({ stdout: '{"result":"hello","session_id":"s1"}' }), {
    text: 'hello', structured: null, sessionId: 's1',
  });
  assert.deepEqual(getProvider('claude').parseOutput({ stdout: 'plain fallback' }), {
    text: 'plain fallback', structured: null, sessionId: null,
  });
  assert.deepEqual(getProvider('claude').parseOutput({ stdout: '{"structured_output":{"answer":42}}' }), {
    text: '{"answer":42}', structured: { answer: 42 }, sessionId: null,
  });
});

test('provider-specific capabilities fail closed', () => {
  assert.throws(
    () => getProvider('agy').buildInvocation({ prompt: 'x', schema: {}, timeoutMs: 1000 }),
    (error) => error.code === 'UNSUPPORTED_CAPABILITY',
  );
  assert.throws(
    () => getProvider('agy').buildInvocation({ prompt: 'x'.repeat(129 * 1024), timeoutMs: 1000 }),
    (error) => error.code === 'PROMPT_TOO_LARGE',
  );
});

test('Claude and Codex include optional structured-output and resume flags', () => {
  const claude = getProvider('claude').buildInvocation({
    prompt: 'x', timeoutMs: 1000, sessionId: 'session-1', effort: 'high', schema: { type: 'object' },
  });
  assert.ok(claude.args.includes('--resume'));
  assert.ok(claude.args.includes('--effort'));
  assert.ok(claude.args.includes('--json-schema'));

  const codex = getProvider('codex').buildInvocation({
    prompt: 'x', timeoutMs: 1000, sessionId: 'session-2', effort: 'high', schema: { type: 'object' },
  });
  assert.deepEqual(codex.args.slice(0, 2), ['exec', 'resume']);
  assert.ok(codex.args.includes('--output-schema'));
  assert.ok(codex.args.includes('model_reasoning_effort="high"'));
  codex.cleanup();
});
