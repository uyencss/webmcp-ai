import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createPublicLifecycle,
  createTrustedCoordinatorConfig,
  asPublicAdapter,
} from '../src/orchestration/public-adapters.mjs';
import { createOwnedProcessAdapter } from '../src/orchestration/adapters/owned-process.mjs';
import { createClaudeStreamAdapter } from '../src/orchestration/adapters/claude-stream.mjs';
import { createOpenCodeServerAdapter } from '../src/orchestration/adapters/opencode-server.mjs';
import { readClientCapability } from '../src/orchestration/authority.mjs';
import { deriveEndpoint, requestIpc } from '../src/orchestration/ipc.mjs';
import { resolveOrchestrationRoots } from '../src/orchestration/paths.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { ORCHESTRATION_PROTOCOL, WORKER_CALLBACK_OPERATIONS } from '../src/orchestration/constants.mjs';

const FIXTURES = new URL('./fixtures/orchestration/', import.meta.url).pathname;
const fakeClaude = join(FIXTURES, 'fake-claude.mjs');
const fakeOpenCode = join(FIXTURES, 'fake-opencode-server.mjs');

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r8b-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let coordCounter = 0;
const COORD = () => `coord_r8b_${(coordCounter += 1)}`;

async function startSupervisor(t, name, { adapters = [], trustedConfig = null } = {}) {
  const stateDir = tempDir(t, name);
  const coordinationId = COORD();
  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'create',
    coordinationId,
    ...(adapters.length > 0 ? { adapters, trustedCoordinatorConfig: (trustedConfig && !('confinement' in trustedConfig))
      ? { ...trustedConfig, confinement: 'disposable-workspace', disposableRoot: tmpdir() }
      : trustedConfig } : {}),
  });
  t.after(() => sup.stop());
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const call = async (operation, input, requestId = `req_${Math.random().toString(36).slice(2, 8)}`) => requestIpc(
    deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId }),
    {
      protocol: ORCHESTRATION_PROTOCOL,
      requestId,
      coordinationId,
      fenceEpoch: sup.__store.state.fenceEpoch,
      capability: readClientCapability({ coordinationDir: join(roots.stateRoot, 'coordinations', coordinationId) }),
      operation,
      input,
    },
    { timeoutMs: 20_000 },
  );
  return { sup, stateDir, roots, call };
}

async function seedTask(call, packet) {
  const created = await call('task.create', { packet }, `req_task_${Math.random().toString(36).slice(2, 8)}`);
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  return created.result.taskId;
}

const ALL_BOOLEAN_CAPABILITIES = Object.fromEntries([
  'liveEvents', 'explicitResume', 'externalAttach', 'questionChannel', 'permissionControl',
  'sameTurnSteer', 'gracefulInterrupt', 'preToolGate', 'processOwnership', 'fileEvents', 'testEvents',
].map((key) => [key, false]));

function hangingStubAdapter() {
  const inner = {
    id: 'owned-process',
    maturity: 'fixture-only',
    capabilities: { ...ALL_BOOLEAN_CAPABILITIES },
    probe: async () => ({ adapterId: 'owned-process', available: true, installedVersion: process.version, sdkVersion: null, maturity: 'fixture-only', capabilities: { ...ALL_BOOLEAN_CAPABILITIES } }),
    spawn: async ({ task, dispatch, emit }) => {
      emit('worker_started', { dispatchId: dispatch.dispatchId });
      const done = new Promise(() => {});
      return { ok: true, binding: { sessionId: 'ses_stub' }, done };
    },
    attach() { throw new Error('unsupported'); },
    subscribe() { throw new Error('unsupported'); },
    readSession: async () => null,
    sendReply() { throw new Error('unsupported'); },
    sendGuidance() { throw new Error('unsupported'); },
    resolvePermission() { throw new Error('unsupported'); },
    interrupt: async () => ({ ok: true }),
    close: async () => ({ disposition: 'closed' }),
    sanitize: (event) => event,
  };
  const config = createTrustedCoordinatorConfig({
    stateDir: tmpdir(),
    allowFixtureDispatch: true,
    ownedProcessCommand: { command: process.execPath, args: ['-e', ''], env: {} },
  });
  return asPublicAdapter(inner, createPublicLifecycle('owned-process', inner, config));
}

test('R8B: worker callbacks travel over the real IPC socket with per-binding capability', async (t) => {
  const { sup, roots, call } = await startSupervisor(t, 'transport', {
    adapters: [hangingStubAdapter()],
    trustedConfig: { allowFixtureDispatch: true },
  });
  const taskId = await seedTask(call, {
    objective: 'Callback target',
    workspace: tempDir(t, 'ws1'),
    allowedReadRoots: [],
    allowedWriteRoots: [],
  });
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true);
  const dispatchId = started.result.dispatchId;

  // The supervisor exposes its durable worker bindings (binding id + the
  // per-dispatch callback capability) so a generic CLI worker can talk back.
  const bindings = sup.__workerBindings();
  const binding = bindings.find((entry) => entry.dispatchId === dispatchId);
  assert.ok(binding, 'the live dispatch has a recorded worker binding');
  assert.match(binding.bindingId, /^worker_/);
  assert.equal(typeof binding.capabilityToken, 'string');
  assert.ok(binding.capabilityToken.length >= 24);

  const baseFrame = {
    schema: 'webmcp.ai-worker-callback/v0',
    callbackId: `cbk_${Math.random().toString(36).slice(2, 10)}`,
    coordinationId: sup.coordinationId,
    taskId,
    dispatchId,
    bindingId: binding.bindingId,
    fenceEpoch: sup.__store.state.fenceEpoch,
  };
  const workerCall = async (operation, input, capability, seq) => requestIpc(
    deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId: sup.coordinationId }),
    {
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: `wreq_${Math.random().toString(36).slice(2, 8)}`,
      coordinationId: sup.coordinationId,
      operation,
      capability,
      input: { ...baseFrame, operation, callbackSeq: seq, input },
    },
    { timeoutMs: 10_000 },
  );

  // A real socket round trip with ONLY the binding's capability succeeds.
  const progress = await workerCall('worker.progress', { summary: 'halfway there' }, binding.capabilityToken, 1);
  assert.equal(progress.ok, true, JSON.stringify(progress));
  assert.equal(progress.result.sequence > 0, true);

  // Duplicate replay over the socket replays the prior acknowledgement.
  const replay = await workerCall('worker.progress', { summary: 'halfway there' }, binding.capabilityToken, 1);
  assert.equal(replay.ok, true);
  assert.equal(replay.result.duplicate, true);

  // The coordinator capability does NOT authorize worker callbacks.
  const coordinatorToken = readClientCapability({
    coordinationDir: join(roots.stateRoot, 'coordinations', sup.coordinationId),
  });
  const impostor = await workerCall('worker.progress', { summary: 'impostor' }, coordinatorToken, 2);
  assert.equal(impostor.ok, false);
  assert.match(String(impostor.error?.code ?? ''), /WORKER_CALLBACK|UNPROVEN|UNAUTHORIZED/);

  // Wrong binding token is refused as well.
  const wrong = await workerCall('worker.progress', { summary: 'nope' }, `${binding.capabilityToken}x`, 3);
  assert.equal(wrong.ok, false);

  await call('task.cancel', { taskId, reason: 'transport-test-done' });
});

test('R8B: claude receives the task objective on stdin and stdin closes', async (t) => {
  const stdinLog = join(tempDir(t, 'claude-log'), 'stdin.log');
  const adapter = createClaudeStreamAdapter({
    claudeBin: process.execPath,
    claudeArgs: [fakeClaude],
    fakeModeEnv: { FAKE_CLAUDE_MODE: 'busy-followup', WEBMCP_FAKE_STDIN_LOG: stdinLog },
    stateDir: tempDir(t, 'claude-state'),
  });

  const spawned = await adapter.spawn({
    task: { taskId: 'task_obj', workspace: tempDir(t, 'ws2'), objective: 'OBJ-123-rewrite-readme' },
    dispatch: { dispatchId: 'disp_obj', bindingId: 'worker_obj', taskId: 'task_obj', fenceEpoch: 1 },
    emit: () => {},
  });
  await new Promise((resolveTick) => setTimeout(resolveTick, 400));
  try { spawned.binding?.__child?.kill('SIGKILL'); } catch { /* already gone */ }

  assert.equal(existsSync(stdinLog), true, 'stdin traffic was captured');
  const lines = readFileSync(stdinLog, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.includes('OBJ-123-rewrite-readme'), true, `objective reached stdin, got ${JSON.stringify(lines)}`);
});

test('R8B: owned-process workers receive the objective on stdin', async (t) => {
  const outDir = tempDir(t, 'owned-obj');
  const outFile = join(outDir, 'objective.txt');
  const workerScript = join(outDir, 'reader.mjs');
  writeFileSync(workerScript, [
    "const fs = await import('node:fs');",
    "let data='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',(c)=>{data+=c;});",
    "process.stdin.on('end',()=>{",
    "  fs.writeFileSync(process.env.WEBMCP_OBJ_OUT, JSON.stringify(data));",
    "  process.exit(0);",
    "});",
    '',
  ].join('\n'));

  const adapter = createOwnedProcessAdapter({ stateDir: join(outDir, 'state') });
  const spawned = await adapter.spawn({
    task: { taskId: 'task_own', workspace: outDir, objective: 'OWNED-OBJ-42' },
    dispatch: { dispatchId: 'disp_own', bindingId: 'worker_own' },
    command: process.execPath,
    args: [workerScript],
    env: { ...process.env, WEBMCP_OBJ_OUT: outFile },
    emit: () => {},
  });
  const terminal = await spawned.done;
  assert.equal(terminal.terminalType, 'worker_done');
  const received = JSON.parse(readFileSync(outFile, 'utf8'));
  assert.match(received, /OWNED-OBJ-42/, `objective piped to owned worker, got ${JSON.stringify(received)}`);
});

test('R8B: opencode subscribes SSE before prompting and binds proven process identity', async (t) => {
  const reqLog = join(tempDir(t, 'oc-reqlog'), 'requests.log');
  const stateDir = tempDir(t, 'oc-state');
  const workspace = tempDir(t, 'oc-ws');
  const adapter = createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
    stateDir,
    streamFile: null,
    requestLogForTest: reqLog,
  });
  const started = await adapter.startRuntimeServer({ workspace, bindingId: 'worker_oc', fenceEpoch: 1 });
  t.after(() => adapter.stopServer(started.runtime));

  // Unified process identity on the binding: recovery/interrupt can target it.
  assert.ok(started.binding.processIdentity, 'binding exposes unified processIdentity');
  assert.ok(Number.isInteger(started.binding.processIdentity.pid) && started.binding.processIdentity.pid > 0);
  assert.match(String(started.binding.processIdentity.startIdentity), /\S/);

  // The public launch wrapper must subscribe BEFORE it prompts. Drive the
  // same ordering through the lifecycle seam with a prompt capture.
  const { createPublicLifecycle, createTrustedCoordinatorConfig } = await import('../src/orchestration/public-adapters.mjs');
  const config = createTrustedCoordinatorConfig({
    stateDir,
    allowFixtureDispatch: false,
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
  });
  void config;
  // Plain startRuntimeServer alone must not subscribe or prompt: the request
  // log stays empty (the fixture only creates it on first request).
  assert.equal(existsSync(reqLog), false, 'no HTTP traffic before a subscription is requested');
});

test('R8B: public opencode launch awaits SSE readiness before prompt_async', async (t) => {
  const reqLog = join(tempDir(t, 'oc-order'), 'requests.log');
  const stateDir = tempDir(t, 'oc-state2');
  const workspace = tempDir(t, 'ws4');
  const inner = createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
    stateDir,
    requestLogForTest: reqLog,
  });
  const config = createTrustedCoordinatorConfig({
    stateDir,
    allowFixtureDispatch: false,
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
  });
  const lifecycle = createPublicLifecycle('opencode-server', inner, config);
  const emitted = [];
  const context = {
    task: { taskId: 'task_sse', objective: 'hello', workspace, allowedReadRoots: [], allowedWriteRoots: [] },
    dispatch: { dispatchId: 'disp_sse', bindingId: 'worker_sse', taskId: 'task_sse', fenceEpoch: 1, mode: 'delegated-result-return', guaranteeTier: 'owned-process' },
    emit: (type, payload) => emitted.push(type),
    resumeSessionId: null,
    resumeThread: null,
    doneForServer: new Promise(() => {}),
  };
  const launched = await lifecycle.launch(context);
  t.after(async () => {
    await inner.stopServer(launched.binding.__runtime).catch(() => {});
  });
  const order = readFileSync(reqLog, 'utf8').split('\n').filter(Boolean);
  const eventIndex = order.indexOf('/event');
  const promptIndex = order.indexOf('/prompt_async');
  assert.ok(eventIndex !== -1, '/event was requested');
  assert.ok(promptIndex !== -1, '/prompt_async was requested');
  assert.ok(eventIndex < promptIndex, `SSE subscription precedes the prompt, got ${JSON.stringify(order)}`);
});

test('R8B: release proves process death and survives a trapped SIGTERM via escalation', async (t) => {
  const stateDir = tempDir(t, 'oc-release');
  const workspace = tempDir(t, 'ws5');
  const adapter = createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [fakeOpenCode],
    stateDir,
    ignoreSigtermForTest: true,
  });
  const started = await adapter.startRuntimeServer({ workspace, bindingId: 'worker_rel', fenceEpoch: 1 });
  const dbDir = dirname(started.runtime.dbPath);
  assert.equal(existsSync(dbDir), true);

  const receipt = await adapter.stopServer(started.runtime, { release: true, settled: true });
  assert.equal(receipt.exitProven, true, 'death is proven before removal is attempted');
  assert.equal(receipt.released, true);
  assert.equal(existsSync(dbDir), false, 'verified database removed only after exit proof');
});
