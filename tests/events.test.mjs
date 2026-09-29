import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { generate } from '../src/client.mjs';
import {
  classifyCodexEvent,
  classifyProviderLine,
  createLineSplitter,
  EVENT_STATES,
  terminalStateForError,
} from '../src/events.mjs';
import { AiCliError } from '../src/errors.mjs';
import { withV2Db } from './fixtures/opencode-v2-db.mjs';

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
      env: withV2Db({ ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' }),
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
        env: withV2Db({ ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode', FAKE_EXIT_CODE: '3' }),
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
      env: withV2Db({ ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' }),
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

test('classifier reads part.data.text and tolerates empty text parts', () => {
  const nested = classifyProviderLine('opencode', JSON.stringify({
    type: 'message.part.updated', part: { type: 'text', data: { text: 'nested hello' } },
  }));
  assert.deepEqual(nested, { state: 'researching', summary: 'nested hello' });
  const direct = classifyProviderLine('opencode', JSON.stringify({
    type: 'message.part.updated', part: { type: 'text', text: 'direct hello' },
  }));
  assert.deepEqual(direct, { state: 'researching', summary: 'direct hello' });
  // Object part with no text or data.text falls back to an empty advisory summary.
  const emptyPart = classifyProviderLine('opencode', JSON.stringify({ type: 'text', part: { type: 'text' } }));
  assert.deepEqual(emptyPart, { state: 'researching', summary: '' });
  const bareType = classifyProviderLine('opencode', JSON.stringify({ type: 'text' }));
  assert.deepEqual(bareType, { state: 'researching', summary: '' });
  const nonObjectPart = classifyProviderLine('opencode', JSON.stringify({ type: 'reasoning', part: 'oops' }));
  assert.equal(nonObjectPart.state, 'researching');
});

test('classifier handles missing tool identity without crashing', () => {
  const missing = classifyProviderLine('opencode', JSON.stringify({ type: 'my-tool-event', part: { type: 'tool' } }));
  assert.equal(missing.state, 'editing');
  assert.match(missing.summary, /tool:/);
  // Whitespace-only tool falls through to the next identity key.
  const fallback = classifyProviderLine('opencode', JSON.stringify({
    type: 'message.part.updated', part: { type: 'tool', tool: '   ', name: 'picked-name' },
  }));
  assert.equal(fallback.state, 'editing');
  assert.match(fallback.summary, /picked-name/);
  const byCommand = classifyProviderLine('opencode', JSON.stringify({
    type: 'message.part.updated', part: { type: 'tool', command: 'run-lint' },
  }));
  assert.equal(byCommand.state, 'editing');
  assert.match(byCommand.summary, /run-lint/);
  const byTitle = classifyProviderLine('opencode', JSON.stringify({
    type: 'message.part.updated', part: { type: 'tool', title: 'Apply patch' },
  }));
  assert.equal(byTitle.state, 'editing');
  // Tool event that only matches via the stringified payload still maps to testing.
  const viaPayload = classifyProviderLine('opencode', JSON.stringify({
    type: 'message.part.updated', part: { type: 'tool', tool: 'bash' }, note: 'run npm test now',
  }));
  assert.equal(viaPayload.state, 'testing');
});

test('classifier covers permission asked identity and replied resumption', () => {
  const viaPermission = classifyProviderLine('opencode', JSON.stringify({
    type: 'permission.asked', permission: { tool: 'edit' }, part: { type: 'tool', tool: 'fallback' },
  }));
  assert.deepEqual(viaPermission, { state: 'question', summary: 'permission asked: edit' });
  const viaPart = classifyProviderLine('opencode', JSON.stringify({
    type: 'permission.v2.asked', part: { type: 'tool', tool: 'write' },
  }));
  assert.equal(viaPart.state, 'question');
  assert.match(viaPart.summary, /write/);
  assert.deepEqual(
    classifyProviderLine('opencode', JSON.stringify({ type: 'permission.replied' })),
    { state: 'researching', summary: 'permission replied, resuming' },
  );
  assert.deepEqual(
    classifyProviderLine('opencode', JSON.stringify({ type: 'permission.v2.replied' })),
    { state: 'researching', summary: 'permission replied, resuming' },
  );
});

test('classifier covers unknown JSON objects and session prefix edge', () => {
  assert.deepEqual(classifyProviderLine('opencode', '{}'), { state: 'working', summary: '{}' });
  const unknown = classifyProviderLine('opencode', JSON.stringify({ foo: 'bar' }));
  assert.equal(unknown.state, 'working');
  assert.match(unknown.summary, /bar/);
  // sessionID with a message.* type must not take the session-created fast path.
  const messageWithSession = classifyProviderLine('opencode', JSON.stringify({
    type: 'message.part.updated', sessionID: 'ses_2', part: { type: 'text', text: 'hi' },
  }));
  assert.deepEqual(messageWithSession, { state: 'researching', summary: 'hi' });
  assert.deepEqual(
    classifyProviderLine('opencode', JSON.stringify({ type: 'session.created' })),
    { state: 'researching', summary: 'session.created' },
  );
  assert.equal(classifyProviderLine('opencode', JSON.stringify({ type: 'session.idle' })).state, 'researching');
  assert.equal(classifyProviderLine('opencode', JSON.stringify({ type: 'file.edited' })).state, 'editing');
  assert.deepEqual(
    classifyProviderLine('opencode', JSON.stringify({ type: 'session.diff' })),
    { state: 'editing', summary: 'session.diff' },
  );
  assert.deepEqual(
    classifyProviderLine('opencode', JSON.stringify({ type: 'session.error' })),
    { state: 'blocked', summary: 'session.error' },
  );
  const reasoning = classifyProviderLine('opencode', JSON.stringify({
    type: 'message.part.updated', part: { type: 'reasoning', text: 'thinking' },
  }));
  assert.deepEqual(reasoning, { state: 'researching', summary: 'thinking' });
});

test('event summaries stay bounded for long JSON payloads', () => {
  const longText = `x${'y'.repeat(500)}`;
  const textEvent = classifyProviderLine('opencode', JSON.stringify({ type: 'text', part: { type: 'text', text: longText } }));
  assert.ok(textEvent.summary.length <= 201);
  const toolEvent = classifyProviderLine('opencode', JSON.stringify({
    type: 'message.part.updated', part: { type: 'tool', tool: `edit-${'z'.repeat(500)}` },
  }));
  assert.ok(toolEvent.summary.length <= 201);
  const unknownLong = classifyProviderLine('opencode', JSON.stringify({ note: longText }));
  assert.ok(unknownLong.summary.length <= 201);
});

test('splitter and classifier tolerate nullish input', () => {
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push(null);
  splitter.push(undefined);
  splitter.push('');
  splitter.flush();
  assert.deepEqual(lines, []);
  assert.equal(classifyProviderLine('agy', null), null);
  assert.equal(classifyProviderLine('agy', undefined), null);
  assert.equal(classifyProviderLine('opencode', '{not-json').state, 'working');
});

test('generate tolerates a throwing onEvent observer', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'events-throw-'));
  try {
    let calls = 0;
    const result = await generate({
      provider: 'opencode',
      prompt: 'observer check',
      workspace: ws,
      accessProfile: 'full',
      env: withV2Db({ ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' }),
      onEvent: () => {
        calls += 1;
        throw new Error('observer blew up');
      },
    });
    assert.equal(result.ok, true);
    assert.ok(calls >= 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('classifyCodexEvent maps representative codex event shapes', () => {
  assert.deepEqual(
    classifyCodexEvent({ type: 'thread.started', thread_id: 'th_123' }),
    { state: 'researching', summary: 'thread th_123' },
  );
  assert.deepEqual(
    classifyCodexEvent({ type: 'thread.started' }),
    { state: 'researching', summary: 'thread started' },
  );
  assert.deepEqual(
    classifyCodexEvent({ type: 'turn.started' }),
    { state: 'working', summary: 'turn started' },
  );
  assert.deepEqual(
    classifyCodexEvent({ type: 'turn.completed', usage: {} }),
    { state: 'verifying', summary: 'turn completed' },
  );
  assert.deepEqual(
    classifyCodexEvent({ type: 'turn.failed', error: 'context overflow' }),
    { state: 'blocked', summary: 'context overflow' },
  );
  assert.deepEqual(
    classifyCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'HELLO WORLD' } }),
    { state: 'researching', summary: 'HELLO WORLD' },
  );
  assert.deepEqual(
    classifyCodexEvent({ type: 'item.started', item: { type: 'reasoning', text: 'thinking step' } }),
    { state: 'researching', summary: 'thinking step' },
  );
  assert.deepEqual(
    classifyCodexEvent({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test -- --bail' } }),
    { state: 'testing', summary: 'command: npm test -- --bail' },
  );
  assert.deepEqual(
    classifyCodexEvent({ type: 'item.completed', item: { type: 'command_execution', command: 'git status' } }),
    { state: 'editing', summary: 'command: git status' },
  );
  assert.deepEqual(
    classifyCodexEvent({ type: 'item.completed', item: { type: 'file_change', path: 'src/events.mjs' } }),
    { state: 'editing', summary: 'src/events.mjs' },
  );
  assert.deepEqual(
    classifyCodexEvent({ type: 'item.completed', item: { type: 'todo_list' } }),
    { state: 'working', summary: 'todo list' },
  );
  assert.deepEqual(
    classifyCodexEvent({ type: 'item.completed', item: { type: 'error', message: 'disk full' } }),
    { state: 'blocked', summary: 'disk full' },
  );
  assert.deepEqual(
    classifyCodexEvent({ type: 'item.completed', item: { type: 'command_execution', command: 'foo', status: 'failed' } }),
    { state: 'blocked', summary: 'item failed' },
  );
});

test('classifyProviderLine routes codex JSON lines to codex classifier and text to text classifier', () => {
  const line = JSON.stringify({ type: 'thread.started', thread_id: '01a0ebfe-ed37-7780-a546-d6e7fa9a95b1' });
  assert.deepEqual(
    classifyProviderLine('codex', line),
    { state: 'researching', summary: 'thread 01a0ebfe-ed37-7780-a546-d6e7fa9a95b1' },
  );
  const textLine = classifyProviderLine('codex', 'All tests passed');
  assert.equal(textLine.state, 'verifying');
});

test('codex fixture generate.jsonl lines classify to valid states', () => {
  const fixturePath = fileURLToPath(new URL('./fixtures/codex-jsonl/generate.jsonl', import.meta.url));
  const raw = readFileSync(fixturePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 4);
  const states = [];
  for (const line of lines) {
    const classified = classifyProviderLine('codex', line);
    assert.ok(classified, `Line failed to classify: ${line}`);
    assert.ok(EVENT_STATES.has(classified.state), `State not in EVENT_STATES: ${classified.state}`);
    states.push(classified.state);
  }
  assert.deepEqual(states, ['researching', 'working', 'researching', 'verifying']);
});

test('codex synthetic defensive shapes classify to valid states', () => {
  const fixturePath = fileURLToPath(new URL('./fixtures/codex-jsonl/generate.synthetic.jsonl', import.meta.url));
  const raw = readFileSync(fixturePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0 && !l.trim().startsWith('#') && !l.trim().startsWith('//'));
  assert.equal(lines.length, 5);
  const states = [];
  for (const line of lines) {
    const classified = classifyProviderLine('codex', line);
    assert.ok(classified, `Line failed to classify: ${line}`);
    assert.ok(EVENT_STATES.has(classified.state), `State not in EVENT_STATES: ${classified.state}`);
    states.push(classified.state);
  }
  assert.deepEqual(states, ['researching', 'testing', 'editing', 'editing', 'working']);
  assert.ok(states.includes('researching'));
  assert.ok(states.includes('testing'));
  assert.ok(states.includes('editing'));
  assert.ok(states.includes('working'));
});
