#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

// fs.readFileSync(0) can silently return a truncated read on a piped stdin
// larger than one OS pipe-buffer chunk (observed truncating at exactly 64
// KiB on this platform/Node combination) because a single synchronous read()
// call is not guaranteed to drain the whole stream. Read async instead so
// large NDJSON prompt payloads (the AGY stream-json lane) round-trip intact.
async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString('utf8');
}

const args = process.argv.slice(2);
const provider = process.env.FAKE_PROVIDER || basename(process.argv[1]).split('-')[0];
// Test-controlled CLI version. OpenCode defaults to a v2 profile;
// set FAKE_VERSION=1.x for legacy refusal tests.
const version = process.env.FAKE_VERSION || (provider === 'opencode' ? '2.0.3' : '9.9.9');

if (args.includes('--version') || args.includes('-V') || args.includes('-v')) {
  process.stdout.write(`${provider}-cli ${version}\n`);
  process.exit(0);
}

if (args.includes('--help')) {
  if (provider === 'codex') {
    process.stdout.write('codex exec --sandbox read-only --ephemeral --ignore-user-config --ignore-rules --output-last-message resume -c sandbox_mode model_reasoning_effort\n');
  } else if (provider === 'opencode') {
    const help = String(version).startsWith('2.')
      ? 'opencode run --standalone --format json --agent build --model sonnet#effort'
      : 'opencode run --format json --agent build --dir /ws --model sonnet --variant effort';
    process.stdout.write(`${help}\n`);
  } else if (provider === 'agy') {
    process.stdout.write('--sandbox --mode --print-timeout --agent --model --effort --conversation --disable-slash-commands\n');
  } else {
    process.stdout.write('--permission-mode --tools --disallowedTools --safe-mode --no-chrome --no-session-persistence --disable-slash-commands --permission-prompts none\n');
  }
  process.exit(0);
}

if (args[0] === 'models') {
  process.stdout.write('model-one\nmodel-two\n');
  process.exit(0);
}

if (args[0] === 'agents' || args[0] === 'agent') {
  process.stdout.write('Available agents:\n  webmcp-node-executor\n  code-reviewer\n');
  process.exit(0);
}

// AGY malformed --json-schema canary: fixed exit 1 + exact stderr text,
// checked before any other simulated behavior below.
if (provider === 'agy' && process.env.FAKE_AGY_SCHEMA_INVALID === '1') {
  process.stderr.write('Error: invalid --json-schema: schema is not valid JSON: unexpected end of JSON input\n');
  process.exit(1);
}

if (process.env.FAKE_DELAY_MS) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_DELAY_MS)));
}

if (process.env.FAKE_EXIT_CODE) {
  process.stderr.write('simulated provider failure with secret=redact-me\n');
  process.exit(Number(process.env.FAKE_EXIT_CODE));
}

if (process.env.FAKE_EMPTY === '1') {
  process.exit(0);
}

if (process.env.FAKE_EXPECT_HOOKS === '1') {
  const hooks = readFileSync(`${process.cwd()}/.agents/hooks.json`, 'utf8');
  if (!hooks.includes('webmcp-ai-compose-only')) process.exit(11);
}

// AGY structured-output / stream-json lanes: respond with the real AGY
// envelope/NDJSON shapes (canary 2026-09-29 on AGY 1.2.13) instead of the
// generic plain-text reply below, so tests can exercise parseOutput's
// envelope and stream-result handling end to end.
let agyHandled = false;
if (provider === 'agy') {
  const inputFormatIndex = args.indexOf('--input-format');
  const isStreamLane = inputFormatIndex >= 0 && args[inputFormatIndex + 1] === 'stream-json';
  const outputFormatIndex = args.indexOf('--output-format');
  const outputFormat = outputFormatIndex >= 0 ? args[outputFormatIndex + 1] : null;
  const hasSchema = args.includes('--json-schema');

  if (isStreamLane) {
    agyHandled = true;
    const stdinRaw = await readAllStdin();
    let promptText = '';
    try {
      promptText = JSON.parse(stdinRaw.trim().split('\n')[0])?.message?.content ?? '';
    } catch {
      // Malformed stdin: leave promptText empty; the result event below still emits.
    }
    // Note: no process.exit() after these writes. A large write to a piped
    // stdout is asynchronous; calling process.exit() immediately after can
    // truncate it before the pipe drains (observed truncating at ~64 KiB).
    // Setting process.exitCode and letting the module finish naturally waits
    // for the writes to flush.
    process.stdout.write(`${JSON.stringify({ event: 'init', conversation_id: 'agy-stream-conv' })}\n`);
    process.stdout.write(`${JSON.stringify({ event: 'step_update', step: 1 })}\n`);
    if (process.env.FAKE_AGY_STREAM_NO_RESULT !== '1') {
      const result = {
        conversation_id: 'agy-stream-conv',
        status: process.env.FAKE_AGY_STREAM_STATUS || 'SUCCESS',
        response: `reply:agy:${promptText}\n`,
        duration_seconds: 1.2,
        num_turns: 1,
        usage: {},
      };
      if (hasSchema && process.env.FAKE_AGY_OMIT_STRUCTURED !== '1') {
        result.structured_output = { ok: true };
      }
      process.stdout.write(`${JSON.stringify({ event: 'result', result })}\n`);
    }
    process.exitCode = 0;
  } else if (outputFormat === 'json') {
    agyHandled = true;
    const promptIndexLocal = args.indexOf('-p');
    const promptText = promptIndexLocal >= 0 ? args[promptIndexLocal + 1] : '';
    const envelope = {
      conversation_id: 'agy-json-conv',
      status: 'SUCCESS',
      response: `reply:agy:${promptText}`,
      duration_seconds: 1.1,
      num_turns: 1,
      usage: {},
    };
    if (hasSchema && process.env.FAKE_AGY_OMIT_STRUCTURED !== '1') {
      envelope.structured_output = { ok: true };
    }
    process.stdout.write(JSON.stringify(envelope));
    process.exitCode = 0;
  }
}

if (!agyHandled) {
  const stdin = await readAllStdin();
  const promptIndex = args.indexOf('-p');
  const prompt = stdin || (promptIndex >= 0 ? args[promptIndex + 1] : '');
  let reply = process.env.FAKE_REPLY_CWD === '1'
    ? `reply:${provider}:${prompt}:cwd=${process.cwd()}`
    : `reply:${provider}:${prompt}`;
  // Test-only env observability: FAKE_ECHO_ENV="A,B" appends |env:A=<val>;B=<val>
  if (process.env.FAKE_ECHO_ENV) {
    const shown = String(process.env.FAKE_ECHO_ENV).split(',')
      .map((s) => s.trim()).filter(Boolean)
      .map((k) => `${k}=${process.env[k] ?? ''}`).join(';');
    reply += `|env:${shown}`;
  }
  // Test-only argv observability: FAKE_ECHO_ARGS=1 appends |args:<argv joined>
  if (process.env.FAKE_ECHO_ARGS === '1') {
    reply += `|args:${args.join(' ')}`;
  }
  const outputIndex = args.indexOf('--output-last-message');

  if (outputIndex >= 0) {
    writeFileSync(args[outputIndex + 1], reply);
    process.stdout.write('{"type":"completed"}\n');
  } else if (provider === 'claude') {
    process.stdout.write(JSON.stringify({ result: reply, session_id: 'claude-session' }));
  } else {
    process.stdout.write(reply);
  }
}
