import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createCodexExecAdapter,
  normalizeCodexEvent,
} from '../src/orchestration/adapters/codex-exec.mjs';

const fakeCodex = fileURLToPath(new URL('./fixtures/orchestration/fake-codex.mjs', import.meta.url));
const streamFixture = fileURLToPath(new URL('./fixtures/orchestration/streams/codex.ndjson', import.meta.url));

function tempDir(t, name = 'cx') {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-t9-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitWorkspace(t, name = 'ws') {
  const dir = tempDir(t, name);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@l');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'README.md'), '# s\n');
  git('add', '-A');
  git('commit', '-qm', 'seed');
  return dir;
}

test('codex events map to bounded evidence and drop reasoning content', () => {
  const lines = readFileSync(streamFixture, 'utf8').split('\n').filter(Boolean);
  const binding = { threadId: 'thr_fixture' };
  const mapped = lines
    .map((line) => normalizeCodexEvent(JSON.parse(line), binding))
    .flat()
    .filter(Boolean);

  const serialized = JSON.stringify(mapped);
  assert.equal(serialized.includes('private reasoning summary'), false, 'reasoning is dropped entirely');
  assert.equal(serialized.includes('thr_fixture'), false, 'thread ids stay in binding metadata');

  assert.equal(mapped.some((entry) => entry.kind === 'thread_started'), true);
  assert.equal(mapped.some((entry) => entry.kind === 'command_execution' && entry.payload.exitCode === 0), true);
  const fileChange = mapped.find((entry) => entry.kind === 'file_change');
  assert.ok(fileChange);
  assert.deepEqual(fileChange.payload.changes, ['src/a.ts', 'src/b.ts']);
  assert.equal(mapped.some((entry) => entry.deliveryType === 'escalation'), true, 'provider errors escalate');
  assert.equal(mapped.some((entry) => entry.kind === 'turn_completed'), true);
});

test('codex agent messages preserve a bounded response text for public canary validation', () => {
  const mapped = normalizeCodexEvent({
    type: 'item.completed',
    item: { id: 'msg-1', type: 'agent_message', text: 'ok' },
  });

  assert.equal(mapped.kind, 'agent_message');
  assert.equal(mapped.deliveryType, 'progress');
  assert.equal(mapped.payload.responseText, 'ok');
});

function makeAdapter(t, extra = {}) {
  return createCodexExecAdapter({
    stateDir: tempDir(t, 'state'),
    codexBin: process.execPath,
    codexArgs: [fakeCodex],
    fakeModeEnv: { FAKE_CODEX_MODE: 'assert-args' },
    ...extra,
  });
}

const baseTask = (workspace, overrides = {}) => ({
  taskId: 'task_x',
  objective: 'Read-only codex work',
  workspace,
  allowedWriteRoots: [],
  protectedPaths: [],
  dependencies: [],
  acceptanceCommands: [],
  commandPolicy: { allowedExecutables: [] },
  delegationDepth: 1,
  initialRevision: null,
  modelPolicy: null,
  effortPolicy: null,
  ...overrides,
});

test('new codex invocations match the documented read-only argv contract', async (t) => {
  const workspace = gitWorkspace(t);
  const adapter = makeAdapter(t);
  const events = [];
  const { done } = await adapter.spawn({
    task: baseTask(workspace),
    dispatch: { dispatchId: 'disp_x', bindingId: 'worker_x', taskId: 'task_x', fenceEpoch: 1 },
    emit: (type, payload) => events.push({ type, payload }),
  });

  const terminal = await done;
  assert.equal(terminal.terminalType, 'worker_done');

  // The adapter records its own thread receipt for later resume eligibility.
  assert.equal(typeof adapter.__receiptFor('disp_x')?.threadId, 'string');
  assert.equal(adapter.capabilities.processOwnership, true);
  assert.equal(adapter.capabilities.gracefulInterrupt, false);
});

test('resume requires a matching adapter-owned receipt or fails identity-unproven', async (t) => {
  const workspace = gitWorkspace(t);
  const adapter = makeAdapter(t);
  const events = [];
  const { done, sessionId } = await adapter.spawn({
    task: baseTask(workspace),
    dispatch: { dispatchId: 'disp_r1', bindingId: 'worker_r1', taskId: 'task_x', fenceEpoch: 1 },
    emit: (type, payload) => events.push({ type, payload }),
    resumeThread: null,
  });
  await done;
  void sessionId;

  // Missing receipt for another dispatch fails closed.
  const missing = await adapter.spawn({
    task: baseTask(workspace),
    dispatch: { dispatchId: 'disp_unknown', bindingId: 'worker_u', taskId: 'task_x', fenceEpoch: 1 },
    emit: () => {},
    resumeThread: 'thr_external',
  });
  await missing.done;
  assert.equal(missing.ok, false);
  assert.match(JSON.stringify(missing.error ?? {}), /WORKER_IDENTITY_UNPROVEN|identity/i);

  // A recorded receipt for the same task/workspace resumes explicitly.
  const resumed = await adapter.spawn({
    task: baseTask(workspace),
    dispatch: { dispatchId: 'disp_r1', bindingId: 'worker_r1b', taskId: 'task_x', fenceEpoch: 1 },
    emit: () => {},
    resumeThread: adapter.__receiptFor('disp_r1')?.threadId,
  });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.error ?? {}));
  await resumed.done;
});

test('codex requires a git workspace and never skips the repo check', async (t) => {
  const nonGit = tempDir(t, 'nogit');
  const adapter = makeAdapter(t);
  const attempt = await adapter.spawn({
    task: baseTask(nonGit),
    dispatch: { dispatchId: 'disp_ng', bindingId: 'worker_ng', taskId: 'task_ng', fenceEpoch: 1 },
    emit: () => {},
  });
  await attempt.done;
  assert.equal(attempt.ok, false);
});

test('hostile ambient codex config cannot alter the invocation', async (t) => {
  const home = tempDir(t, 'home');
  const sentinel = join(home, '.codex', 'config.toml');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(sentinel, 'model = "ambient-evil"\n');
  const before = readFileSync(sentinel, 'utf8');

  const workspace = gitWorkspace(t);
  const adapter = createCodexExecAdapter({
    stateDir: tempDir(t, 'state2'),
    codexBin: process.execPath,
    codexArgs: [fakeCodex],
    fakeModeEnv: { FAKE_CODEX_MODE: 'assert-args' },
    env: { HOME: home },
  });

  const { done } = await adapter.spawn({
    task: baseTask(workspace),
    dispatch: { dispatchId: 'disp_h', bindingId: 'worker_h', taskId: 'task_h', fenceEpoch: 1 },
    emit: () => {},
  });
  await done;
  assert.equal(readFileSync(sentinel, 'utf8'), before, 'ambient config untouched');
  assert.equal(existsSync(sentinel), true);
});

test('probe reports fixture-only maturity and experimental-unavailable app server', async (t) => {
  const adapter = createCodexExecAdapter({
    stateDir: tempDir(t, 'state3'),
    codexBin: process.execPath,
    codexArgs: [fakeCodex],
    probeModes: ['help', 'resume-help'],
  });
  const probe = await adapter.probe({});
  assert.equal(probe.available, true);
  assert.equal(probe.maturity, 'fixture-only');
  assert.deepEqual(
    probe.experimentalSurfaces?.map((entry) => entry.status),
    ['experimental-unavailable'],
    'app server stays an experimental-unavailable note after read-only probe',
  );
});

test('the codex live canary is fail-closed without dual authorization', () => {
  // Mirrors tests/live/orchestration-codex.test.mjs gate without spawning.
  const enabled = process.env.WEBMCP_AI_LIVE_CANARY === '1'
    && process.env.WEBMCP_AI_LIVE_CODEX === '1';
  assert.equal(enabled, false);
});
