import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { generate } from '../src/client.mjs';
import {
  classifyProviderLine,
  createLineSplitter,
  EVENT_STATES,
  terminalStateForError,
} from '../src/events.mjs';
import { AiCliError } from '../src/errors.mjs';

const bin = fileURLToPath(new URL('../bin/webmcp-ai.mjs', import.meta.url));
const fakeBin = fileURLToPath(new URL('./fixtures/fake-ai-cli.mjs', import.meta.url));

test('splitter reassembles lines cut across chunks and drops empties', () => {
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push('hel');
  splitter.push('lo\nworld\r\n\ntail');
  assert.deepEqual(lines, ['hello', 'world']);
  splitter.flush();
  assert.deepEqual(lines, ['hello', 'world', 'tail']);
  splitter.flush();
  assert.deepEqual(lines, ['hello', 'world', 'tail']);
});

test('classifier maps grounded opencode event shapes', () => {
  assert.deepEqual(
    classifyProviderLine('opencode', JSON.stringify({ sessionID: 'ses_1' })),
    { state: 'researching', summary: 'session ses_1' },
  );
  assert.deepEqual(
    classifyProviderLine('opencode', JSON.stringify({ type: 'text', part: { text: 'thinking out loud' } })),
    { state: 'researching', summary: 'thinking out loud' },
  );
  const tool = classifyProviderLine('opencode', JSON.stringify({ type: 'message.part.updated', part: { type: 'tool', tool: 'edit' } }));
  assert.equal(tool.state, 'editing');
  assert.match(tool.summary, /edit/);
  const testTool = classifyProviderLine('opencode', JSON.stringify({ type: 'message.part.updated', part: { type: 'tool', tool: 'bash', command: 'npm test' } }));
  assert.equal(testTool.state, 'testing');
  assert.deepEqual(
    classifyProviderLine('opencode', JSON.stringify({ type: 'permission.asked' })),
    { state: 'question', summary: 'permission asked: permission.asked' },
  );
  assert.equal(classifyProviderLine('opencode', JSON.stringify({ type: 'file.edited', file: 'src/a.mjs' })).state, 'editing');
  assert.equal(classifyProviderLine('opencode', JSON.stringify({ type: 'session.error', error: 'boom' })).state, 'blocked');
  assert.equal(classifyProviderLine('opencode', JSON.stringify({ type: 'something.new' })).state, 'working');
});

test('classifier falls back to conservative text heuristics', () => {
  assert.equal(classifyProviderLine('agy', 'running npm test now').state, 'testing');
  assert.equal(classifyProviderLine('agy', '12 passed, 0 failed').state, 'verifying');
  assert.equal(classifyProviderLine('agy', 'Need approval to proceed?').state, 'question');
  assert.equal(classifyProviderLine('agy', 'I will update the file to fix it').state, 'editing');
  const plain = classifyProviderLine('agy', 'just some prose');
  assert.deepEqual(plain, { state: 'working', summary: 'just some prose' });
  assert.equal(classifyProviderLine('agy', '   '), null);
  const long = classifyProviderLine('agy', `x${'y'.repeat(500)}`);
  assert.ok(long.summary.length <= 201);
});

test('terminal mapper covers abort/timeout/output-limit/unknown', () => {
  assert.equal(terminalStateForError(new AiCliError('PROVIDER_ABORTED', 'x', {})), 'cancelled');
  assert.equal(terminalStateForError(new AiCliError('PROVIDER_TIMEOUT', 'x', {})), 'blocked');
  assert.equal(terminalStateForError(new AiCliError('PROVIDER_OUTPUT_LIMIT', 'x', {})), 'blocked');
  assert.equal(terminalStateForError(new AiCliError('PROVIDER_EXIT_ERROR', 'x', {})), 'failed');
  assert.equal(terminalStateForError(new Error('plain')), 'failed');
});

test('EVENT_STATES matches the documented vocabulary', () => {
  for (const state of ['queued', 'researching', 'editing', 'testing', 'verifying', 'working', 'question', 'escalation', 'blocked', 'completed', 'failed', 'cancelled']) {
    assert.ok(EVENT_STATES.has(state), `missing state ${state}`);
  }
});

test('generate emits queued, activity, and completed terminal events', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'events-gen-'));
  try {
    const events = [];
    const result = await generate({
      provider: 'opencode',
      prompt: 'event check',
      workspace: ws,
      accessProfile: 'full',
      env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' },
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.ok, true);
    assert.equal(events[0].state, 'queued');
    assert.equal(events.at(-1).state, 'completed');
    assert.ok(events.some((e) => e.state === 'working'));
    assert.ok(events.every((e, i) => e.seq === i + 1 && e.provider === 'opencode'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('generate emits a failed terminal event before rethrowing', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'events-fail-'));
  try {
    const events = [];
    await assert.rejects(
      generate({
        provider: 'opencode',
        prompt: 'event check',
        workspace: ws,
        accessProfile: 'full',
        env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode', FAKE_EXIT_CODE: '3' },
        onEvent: (event) => events.push(event),
      }),
      (e) => e.code === 'PROVIDER_EXIT_ERROR',
    );
    assert.equal(events[0].state, 'queued');
    assert.equal(events.at(-1).state, 'failed');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('CLI --events emits marker JSONL on stderr and keeps stdout JSON', () => {
  const ws = mkdtempSync(join(tmpdir(), 'events-cli-'));
  try {
    const result = spawnSync(process.execPath, [bin, 'generate', '--provider', 'opencode', '--prompt', 'live events', '--workspace', ws, '--full', '--events', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' },
    });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).ok, true);
    const eventLines = result.stderr.split('\n').filter((line) => line.includes('webmcp-ai-event'));
    assert.ok(eventLines.length >= 2);
    const parsed = eventLines.map((line) => JSON.parse(line));
    assert.equal(parsed[0].state, 'queued');
    assert.equal(parsed.at(-1).state, 'completed');
    assert.ok(parsed.every((e) => e.event === 'webmcp-ai-event' && typeof e.seq === 'number'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
