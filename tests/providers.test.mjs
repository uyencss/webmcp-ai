import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { resolveOpencodeCliDb } from '../src/providers/opencode.mjs';
import { getProvider, listProviders } from '../src/providers/index.mjs';
import { MAX_PROMPT_ARG_BYTES, MAX_STREAM_PROMPT_BYTES } from '../src/providers/agy.mjs';

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

test('AGY structured output adds --output-format json --json-schema and cleans up its temp dir', () => {
  const invocation = getProvider('agy').buildInvocation({
    prompt: 'x', timeoutMs: 1000, schema: { type: 'object' },
  });
  const outputFormatAt = invocation.args.indexOf('--output-format');
  assert.equal(invocation.args[outputFormatAt + 1], 'json');
  const schemaAt = invocation.args.indexOf('--json-schema');
  assert.ok(schemaAt >= 0);
  const schemaFile = invocation.args[schemaAt + 1];
  assert.ok(existsSync(schemaFile));
  assert.deepEqual(JSON.parse(readFileSync(schemaFile, 'utf8')), { type: 'object' });
  const schemaDir = dirname(schemaFile);
  invocation.cleanup();
  assert.equal(existsSync(schemaDir), false);
});

test('AGY schema temp dir is cleaned up even when a later validation step throws', () => {
  // Use a plain file (not a directory) as the compose-only workspace so
  // installComposeOnlyGuard's mkdirSync throws AFTER the schema temp dir has
  // already been allocated (schema allocation runs before the compose-only
  // guard install in buildInvocation).
  const scratch = mkdtempSync(join(tmpdir(), 'webmcp-ai-scratch-ws-'));
  const notADir = join(scratch, 'not-a-dir');
  writeFileSync(notADir, '');
  try {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('webmcp-ai-agy-'));
    assert.throws(
      () => getProvider('agy').buildInvocation({
        prompt: 'x', timeoutMs: 1000, schema: { type: 'object' }, toolPolicy: 'compose-only', workspace: notADir,
      }),
    );
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('webmcp-ai-agy-'));
    assert.deepEqual(after, before);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('AGY schema serialization failure (circular) throws before any temp dir is allocated', () => {
  const circular = {};
  circular.self = circular;
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith('webmcp-ai-agy-'));
  assert.throws(
    () => getProvider('agy').buildInvocation({ prompt: 'x', timeoutMs: 1000, schema: circular }),
    /circular/i,
  );
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith('webmcp-ai-agy-'));
  assert.deepEqual(after, before);
});

test('AGY moves a prompt above the argv cap to the stream-json lane with no prompt in argv', () => {
  const bigPrompt = `héllo\nworld\n${'x'.repeat(MAX_PROMPT_ARG_BYTES + 1024)}`;
  const invocation = getProvider('agy').buildInvocation({
    prompt: bigPrompt, timeoutMs: 45_000,
  });
  assert.deepEqual(invocation.args.slice(0, 4), ['--input-format', 'stream-json', '--output-format', 'stream-json']);
  assert.equal(invocation.args.some((a) => typeof a === 'string' && a.includes(bigPrompt)), false);
  assert.equal(invocation.args.includes('-p'), false);
  const lines = invocation.stdin.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.deepEqual(event, { event: 'user', message: { role: 'user', content: bigPrompt } });
  assert.ok(invocation.stdin.endsWith('\n'));
});

test('AGY stream lane carries only --json-schema (output-format stays stream-json)', () => {
  const bigPrompt = 'x'.repeat(MAX_PROMPT_ARG_BYTES + 10);
  const invocation = getProvider('agy').buildInvocation({
    prompt: bigPrompt, timeoutMs: 45_000, schema: { type: 'object' },
  });
  assert.equal(invocation.args.filter((a) => a === '--output-format').length, 1);
  assert.equal(invocation.args[invocation.args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(invocation.args.includes('--json-schema'));
  invocation.cleanup();
});

test('AGY rejects a prompt above the stream-json cap with typed PROMPT_TOO_LARGE', () => {
  assert.throws(
    () => getProvider('agy').buildInvocation({
      prompt: 'x'.repeat(MAX_STREAM_PROMPT_BYTES + 1), timeoutMs: 1000,
    }),
    (error) => error.code === 'PROMPT_TOO_LARGE' && error.details.maxPromptBytes === MAX_STREAM_PROMPT_BYTES,
  );
});

test('AGY parseOutput reads the json envelope, requires structured_output when schema was requested, and reads the stream result', () => {
  const envelope = JSON.stringify({
    conversation_id: 'conv-1', status: 'SUCCESS', response: ' hi \n', structured_output: { ok: true },
  });
  assert.deepEqual(getProvider('agy').parseOutput({ stdout: envelope, request: { schema: { type: 'object' } } }), {
    text: 'hi', structured: { ok: true }, sessionId: 'conv-1',
  });

  const envelopeNoStructured = JSON.stringify({ conversation_id: 'conv-2', status: 'SUCCESS', response: 'hi' });
  assert.throws(
    () => getProvider('agy').parseOutput({ stdout: envelopeNoStructured, request: { schema: { type: 'object' } } }),
    (error) => error.code === 'PROVIDER_STRUCTURED_OUTPUT_MISSING'
      && error.details.provider === 'agy' && error.details.capability === 'structuredOutput',
  );
  // No schema requested: a missing structured_output is not an error.
  assert.deepEqual(getProvider('agy').parseOutput({ stdout: envelopeNoStructured, request: {} }), {
    text: 'hi', structured: null, sessionId: 'conv-2',
  });

  const streamOutput = [
    JSON.stringify({ event: 'init', conversation_id: 'conv-3' }),
    JSON.stringify({ event: 'step_update', step: 1 }),
    JSON.stringify({ event: 'result', result: { conversation_id: 'conv-3', status: 'SUCCESS', response: 'OK\n' } }),
  ].join('\n');
  assert.deepEqual(getProvider('agy').parseOutput({ stdout: streamOutput, request: {} }), {
    text: 'OK', structured: null, sessionId: 'conv-3',
  });

  const streamNoResult = [
    JSON.stringify({ event: 'init', conversation_id: 'conv-4' }),
    JSON.stringify({ event: 'step_update', step: 1 }),
  ].join('\n');
  assert.throws(
    () => getProvider('agy').parseOutput({ stdout: streamNoResult, request: {} }),
    (error) => error.code === 'PROVIDER_EXIT_ERROR' && error.details.provider === 'agy' && error.details.status === null,
  );

  const streamFailedStatus = [
    JSON.stringify({ event: 'init', conversation_id: 'conv-5' }),
    JSON.stringify({ event: 'result', result: { conversation_id: 'conv-5', status: 'FAILED', response: '' } }),
  ].join('\n');
  assert.throws(
    () => getProvider('agy').parseOutput({ stdout: streamFailedStatus, request: {} }),
    (error) => error.code === 'PROVIDER_EXIT_ERROR' && error.details.status === 'FAILED',
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
  assert.ok(invocation.args.includes('--standalone'));
  // The injected sandbox must never carry an "ask" value or headless runs hang.
  assert.equal(invocation.env.OPENCODE_CONFIG_CONTENT.includes('"ask"'), false);
  const cfg = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT);
  assert.ok(Array.isArray(cfg.permissions));
  assert.equal(cfg.permission, undefined);
  assert.ok(cfg.permissions.some((p) => p.action === 'read' && p.effect === 'allow'));
  // CLI invocations use an isolated DB to avoid SQLite lock contention.
  assert.ok(invocation.env.OPENCODE_DB, 'OPENCODE_DB must be set');
  assert.ok(invocation.env.OPENCODE_DB.endsWith('opencode.db'), 'must use opencode.db');
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
  assert.ok(invocation.args.includes('--standalone'));
  assert.equal(invocation.args[invocation.args.indexOf('--agent') + 1], 'build');
  const cfg = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT);
  assert.ok(Array.isArray(cfg.permissions));
  assert.equal(cfg.permission, undefined);
  assert.ok(cfg.permissions.some((p) => p.action === 'edit' && p.effect === 'allow'));
  assert.ok(cfg.permissions.some((p) => p.action === 'shell' && p.effect === 'deny'));
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
  assert.ok(invocation.args.includes('--standalone'));
  const cfg = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT);
  assert.ok(Array.isArray(cfg.permissions));
  assert.deepEqual(cfg.permissions, [{ action: '*', resource: '*', effect: 'deny' }]);
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
  // A prompt above the 128 KiB `-p` argv cap but at or below the 4 MiB
  // stream-json cap now succeeds via the stream lane (see the AGY
  // structured-output/stream-lane tests below); only a prompt above the
  // stream cap fails closed.
  assert.throws(
    () => getProvider('agy').buildInvocation({ prompt: 'x'.repeat(4 * 1024 * 1024 + 1), timeoutMs: 1000 }),
    (error) => error.code === 'PROMPT_TOO_LARGE' && error.details.maxPromptBytes === 4 * 1024 * 1024,
  );
});

test('opencode resolves the CLI database from the effective environment, never process.env', () => {
  // Explicit operator override wins verbatim, including platform-specific
  // separators such as Windows-style backslashes.
  assert.equal(
    resolveOpencodeCliDb({ OPENCODE_DB: 'C:\\custom\\operator.db' }),
    'C:\\custom\\operator.db',
  );
  assert.equal(
    resolveOpencodeCliDb({ OPENCODE_DB: '/custom/operator.db', XDG_DATA_HOME: '/xdg' }),
    '/custom/operator.db',
  );

  // Effective caller XDG_DATA_HOME wins over homedir; trailing separators of
  // both flavors are trimmed so the joined path stays canonical.
  assert.equal(
    resolveOpencodeCliDb({ XDG_DATA_HOME: '/state/data/' }, { homeDir: '/home/tester' }),
    '/state/data/opencode/opencode.db',
  );
  assert.equal(
    resolveOpencodeCliDb({ XDG_DATA_HOME: '\\state\\data\\' }, { homeDir: '/home/tester' }),
    '\\state\\data/opencode/opencode.db',
  );

  // Homedir fallback applies when neither value is present. An explicitly
  // provided environment object must be used instead of process.env.
  assert.equal(
    resolveOpencodeCliDb({}, { homeDir: '/home/tester' }),
    '/home/tester/.local/share/opencode/opencode.db',
  );
  assert.equal(
    resolveOpencodeCliDb({ OPENCODE_DB: '   ', XDG_DATA_HOME: '  ' }, { homeDir: '/home/tester' }),
    '/home/tester/.local/share/opencode/opencode.db',
  );

  // OpenCode v2 resolves to opencode.db and rejects legacy opencode-cli.db
  assert.equal(
    resolveOpencodeCliDb({ XDG_DATA_HOME: '/state/data/' }, { profile: 'v2', homeDir: '/home/tester' }),
    '/state/data/opencode/opencode.db',
  );
  assert.equal(
    resolveOpencodeCliDb({}, { profile: 'v2', homeDir: '/home/tester' }),
    '/home/tester/.local/share/opencode/opencode.db',
  );
  assert.equal(
    resolveOpencodeCliDb({ OPENCODE_DB: '/custom/valid.db' }, { profile: 'v2' }),
    '/custom/valid.db',
  );
  assert.throws(
    () => resolveOpencodeCliDb({ OPENCODE_DB: '/custom/opencode-cli.db' }, { profile: 'v2' }),
    (e) => e.code === 'PROVIDER_STATE_UNINITIALIZED' && e.details?.state === 'prohibited-db',
  );

  // Explicit v1 profile is refused with typed drift
  assert.throws(
    () => resolveOpencodeCliDb({}, { profile: 'v1' }),
    (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT' && e.details?.required === 'v2',
  );
});

test('opencode buildInvocation honors an explicit OPENCODE_DB operator override', () => {
  const overridden = getProvider('opencode').buildInvocation({
    prompt: 'x',
    timeoutMs: 1000,
    workspace: '/ws',
    env: { OPENCODE_DB: '/custom/operator.db', XDG_DATA_HOME: '/xdg' },
  });
  assert.equal(overridden.env.OPENCODE_DB, '/custom/operator.db');

  const defaulted = getProvider('opencode').buildInvocation({
    prompt: 'x',
    timeoutMs: 1000,
    workspace: '/ws',
    env: { XDG_DATA_HOME: '/state/data/' },
  });
  assert.ok(defaulted.env.OPENCODE_DB.endsWith('opencode.db'));
  assert.match(defaulted.env.OPENCODE_DB, /^\/state\/data\//);
  defaulted.cleanup?.();
  overridden.cleanup?.();
});

test('Codex resume requests workspace-write for --full via sandbox_mode and stays read-only otherwise', () => {
  const fullFresh = getProvider('codex').buildInvocation({
    prompt: 'x', timeoutMs: 1000, accessProfile: 'full',
  });
  assert.equal(fullFresh.args[fullFresh.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(fullFresh.args.includes('--ephemeral'));
  assert.ok(fullFresh.args.includes('--ignore-user-config'));
  assert.ok(fullFresh.args.includes('--ignore-rules'));
  fullFresh.cleanup();

  const fullResume = getProvider('codex').buildInvocation({
    prompt: 'x', timeoutMs: 1000, accessProfile: 'full', sessionId: 'session-full-1',
  });
  assert.deepEqual(fullResume.args.slice(0, 2), ['exec', 'resume']);
  // `exec resume` rejects --sandbox/--color, so the same sandbox travels via -c.
  assert.equal(fullResume.args.includes('--sandbox'), false);
  assert.equal(fullResume.args.includes('--color'), false);
  assert.equal(fullResume.args[fullResume.args.indexOf('-c')], '-c');
  assert.ok(fullResume.args.includes('sandbox_mode="workspace-write"'));
  assert.ok(fullResume.args.includes('--ephemeral'));
  assert.ok(fullResume.args.includes('--ignore-user-config'));
  assert.ok(fullResume.args.includes('--ignore-rules'));
  assert.equal(fullResume.args.includes('danger-full-access'), false);
  fullResume.cleanup();

  const boundedResume = getProvider('codex').buildInvocation({
    prompt: 'x', timeoutMs: 1000, sessionId: 'session-bounded-1',
  });
  assert.deepEqual(boundedResume.args.slice(0, 2), ['exec', 'resume']);
  assert.equal(boundedResume.args.includes('--sandbox'), false);
  assert.ok(boundedResume.args.includes('sandbox_mode="read-only"'));
  assert.ok(boundedResume.args.includes('--ephemeral'));
  boundedResume.cleanup();
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
