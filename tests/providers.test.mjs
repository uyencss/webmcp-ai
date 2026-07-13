import assert from 'node:assert/strict';
import test from 'node:test';

import { getProvider, listProviders } from '../src/providers/index.mjs';

test('provider registry exposes agy, claude, and codex', () => {
  assert.deepEqual(listProviders().map((provider) => provider.id), ['agy', 'claude', 'codex']);
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
