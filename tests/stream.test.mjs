import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { generate } from '../src/client.mjs';
import { runProcess } from '../src/process-runner.mjs';

const bin = fileURLToPath(new URL('../bin/webmcp-ai.mjs', import.meta.url));
const fakeBin = fileURLToPath(new URL('./fixtures/fake-ai-cli.mjs', import.meta.url));

test('runProcess forwards stdout/stderr chunks live and keeps the final result', async () => {
  const seen = [];
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('out-1');process.stderr.write('err-1');process.stdout.write('out-2');"], {
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
    onStdout: (chunk) => seen.push(['stdout', String(chunk)]),
    onStderr: (chunk) => seen.push(['stderr', String(chunk)]),
  });
  assert.equal(result.stdout, 'out-1out-2');
  assert.equal(result.stderr, 'err-1');
  // stdout/stderr are separate pipes so cross-stream order is not deterministic;
  // assert per-stream content and order instead.
  assert.deepEqual(seen.filter(([s]) => s === 'stdout').map(([, t]) => t), ['out-1', 'out-2']);
  assert.deepEqual(seen.filter(([s]) => s === 'stderr').map(([, t]) => t), ['err-1']);
});

test('a throwing stream callback never breaks the run', async () => {
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('still-here');"], {
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
    onStdout: () => { throw new Error('observer blew up'); },
  });
  assert.equal(result.stdout, 'still-here');
});

test('generate onStream receives provider bytes before the result resolves', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'stream-gen-'));
  try {
    const seen = [];
    let sawBeforeResolve = false;
    const result = await generate({
      provider: 'opencode',
      prompt: 'stream me',
      workspace: ws,
      accessProfile: 'full',
      env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' },
      onStream: ({ stream, chunk }) => {
        seen.push([stream, String(chunk)]);
        sawBeforeResolve = true;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(sawBeforeResolve, true);
    assert.ok(seen.some(([s, text]) => s === 'stdout' && text.includes('reply:opencode:stream me')));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('CLI --stream sends provider output to stderr and keeps stdout JSON', () => {
  const ws = mkdtempSync(join(tmpdir(), 'stream-cli-'));
  try {
    const result = spawnSync(process.execPath, [bin, 'generate', '--provider', 'opencode', '--prompt', 'live bytes', '--workspace', ws, '--full', '--stream', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' },
    });
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.match(result.stderr, /reply:opencode:live bytes/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('CLI without --stream keeps provider output out of stderr', () => {
  const ws = mkdtempSync(join(tmpdir(), 'stream-cli-off-'));
  try {
    const result = spawnSync(process.execPath, [bin, 'generate', '--provider', 'opencode', '--prompt', 'quiet bytes', '--workspace', ws, '--full', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' },
    });
    assert.equal(result.status, 0);
    JSON.parse(result.stdout);
    assert.equal(result.stderr.includes('reply:opencode:quiet bytes'), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('CLI --stream --events keeps one JSON envelope on stdout and telemetry only on stderr', () => {
  const ws = mkdtempSync(join(tmpdir(), 'stream-events-combined-'));
  try {
    const result = spawnSync(process.execPath, [bin, 'generate', '--provider', 'opencode', '--prompt', 'combined check', '--workspace', ws, '--full', '--stream', '--events', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' },
    });
    assert.equal(result.status, 0, result.stderr);
    // Stdout keeps exactly one machine-readable JSON envelope.
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.response.text, 'reply:opencode:combined check');
    assert.equal(result.stdout.includes('webmcp-ai-event'), false);
    // Stderr carries both the raw provider stream and marker event JSONL.
    assert.match(result.stderr, /reply:opencode:combined check/);
    const eventLines = result.stderr.split('\n').filter((line) => line.includes('webmcp-ai-event'));
    assert.ok(eventLines.length >= 2);
    // Raw --stream bytes share the diagnostics channel without framing, so a
    // raw chunk can prefix an event line; parse from the marker object.
    const parsed = eventLines.map((line) => JSON.parse(line.slice(line.indexOf('{"event"'))));
    assert.equal(parsed[0].state, 'queued');
    assert.equal(parsed.at(-1).state, 'completed');
    assert.ok(parsed.every((e) => e.event === 'webmcp-ai-event' && typeof e.seq === 'number' && typeof e.state === 'string'));
    // Advisory lanes never leak the final envelope shape onto stderr.
    assert.equal(result.stderr.includes('"response"'), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('generate supports combined onStream and onEvent observers', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'stream-events-gen-'));
  try {
    const streamed = [];
    const events = [];
    const result = await generate({
      provider: 'opencode',
      prompt: 'combined observers',
      workspace: ws,
      accessProfile: 'full',
      env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' },
      onStream: ({ stream, chunk }) => streamed.push([stream, String(chunk)]),
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.ok, true);
    assert.ok(streamed.some(([, text]) => text.includes('reply:opencode:combined observers')));
    assert.equal(events[0].state, 'queued');
    assert.equal(events.at(-1).state, 'completed');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
