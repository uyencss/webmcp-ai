import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  computeAdapterMaturity,
  createAdapterRegistry,
  validateAdapter,
} from '../src/orchestration/adapters/index.mjs';
import { createOwnedProcessAdapter } from '../src/orchestration/adapters/owned-process.mjs';
import { buildWorkerPacket, createWorkerCallbackHandlers } from '../src/orchestration/worker-callback.mjs';
import { sanitizeValue } from '../src/orchestration/redaction.mjs';
import { modeRequiresTierSatisfied } from '../src/orchestration/contracts.mjs';

const fakeWorker = fileURLToPath(new URL('./fixtures/orchestration/fake-worker.mjs', import.meta.url));

function tempDir(t, name = 'op') {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-t5-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function minimalAdapter(overrides = {}) {
  const noop = async () => ({ ok: true });
  return {
    id: 'fake',
    maturity: 'fixture-only',
    capabilities: {
      liveEvents: true,
      explicitResume: false,
      externalAttach: false,
      questionChannel: false,
      permissionControl: false,
      sameTurnSteer: false,
      gracefulInterrupt: true,
      preToolGate: false,
      processOwnership: true,
      fileEvents: false,
      testEvents: false,
    },
    probe: noop,
    spawn: noop,
    attach: noop,
    subscribe: noop,
    readSession: noop,
    sendReply: noop,
    sendGuidance: noop,
    resolvePermission: noop,
    interrupt: noop,
    close: noop,
    sanitize: (event) => event,
    ...overrides,
  };
}

test('adapter validation enforces the exact surface before registry exposure', () => {
  assert.equal(validateAdapter(minimalAdapter()).id, 'fake');

  const { spawn, ...missingSpawn } = minimalAdapter();
  assert.throws(() => validateAdapter(missingSpawn), (error) => error.code === 'ORCHESTRATION_INVALID_INPUT');

  const badCapability = minimalAdapter({
    capabilities: { liveEvents: true },
  });
  assert.throws(() => validateAdapter(badCapability), (error) => error.code === 'ORCHESTRATION_INVALID_INPUT');

  const unknownFlag = minimalAdapter();
  unknownFlag.capabilities.extraFlag = true;
  assert.throws(() => validateAdapter(unknownFlag), (error) => error.code === 'ORCHESTRATION_INVALID_INPUT');

  assert.throws(
    () => validateAdapter(minimalAdapter({ maturity: 'supported' })),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
    'alpha code never declares supported',
  );
  assert.throws(
    () => validateAdapter(minimalAdapter({ maturity: 'legendary' })),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  const registry = createAdapterRegistry([minimalAdapter(), minimalAdapter({ id: 'second' })]);
  assert.deepEqual([...registry.ids()].sort(), ['fake', 'second']);
  assert.throws(() => createAdapterRegistry([minimalAdapter(), minimalAdapter()]), (error) => error.code === 'ORCHESTRATION_INVALID_INPUT');
});

test('mode and tier seams reject observer-only supervision and unsupported dispatch', () => {
  for (const tier of ['native-controlled', 'owned-process']) {
    assert.equal(modeRequiresTierSatisfied('supervised-orchestration', tier), true);
  }
  assert.equal(modeRequiresTierSatisfied('supervised-orchestration', 'attached-observer'), false);
  assert.equal(modeRequiresTierSatisfied('supervised-orchestration', 'unsupported'), false);
  assert.equal(modeRequiresTierSatisfied('delegated-result-return', 'unsupported'), false);
  assert.equal(modeRequiresTierSatisfied('full-handoff', 'owned-process'), false);
});

test('maturity is evidence-derived and never self-promotes to supported', () => {
  const adapter = minimalAdapter();
  assert.equal(computeAdapterMaturity(adapter, {}), 'fixture-only');
  assert.equal(computeAdapterMaturity(adapter, null), 'fixture-only');

  // A matching machine-local canary receipt promotes exactly one level.
  const receipt = {
    adapterId: 'fake',
    adapterDigest: 'digest-match',
    executablePathDigest: 'exe-match',
    executableVersion: '1.0.0',
    runtimeVersion: process.version,
  };
  assert.equal(
    computeAdapterMaturity(adapter, { canaryReceipts: [receipt], adapterDigest: 'digest-match' }),
    'fixture-only',
    'without executable/version context the receipt cannot apply',
  );
  assert.equal(
    computeAdapterMaturity(adapter, {
      canaryReceipts: [receipt],
      adapterDigest: 'digest-match',
      executablePathDigest: 'exe-match',
      installedVersion: '1.0.0',
      runtimeVersion: process.version,
    }),
    'canary-proven',
  );
  // Version drift keeps the honest label.
  assert.equal(
    computeAdapterMaturity(adapter, {
      canaryReceipts: [receipt],
      adapterDigest: 'digest-match',
      executablePathDigest: 'exe-match',
      installedVersion: '9.9.9',
      runtimeVersion: process.version,
    }),
    'fixture-only',
  );
});

test('recursive redaction drops secrets and reasoning entirely', () => {
  const sanitized = sanitizeValue({
    Authorization: 'Bearer sk-secret',
    cookie: 'session=abc',
    OPENCODE_SERVER_PASSWORD: 'pw',
    nested: { apiKey: 'key123', keep: 'visible' },
    reasoning: 'private chain of thought',
    text: 'Bearer abc.def token in prose',
    authStorePath: '/home/u/.claude/.credentials.json',
  }, {});

  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes('sk-secret'), false);
  assert.equal(serialized.includes('session=abc'), false);
  assert.equal(serialized.includes('pw'), false);
  assert.equal(serialized.includes('key123'), false);
  assert.equal(serialized.includes('keep'), true);
  assert.equal(serialized.includes('chain of thought'), false);
  assert.match(sanitized.Authorization, /\[REDACTED\]/);
  assert.match(sanitized.text, /\[REDACTED\]/);
  assert.equal(sanitized.reasoning, undefined);
  assert.match(sanitized.authStorePath, /\[REDACTED\]/);
});

test('worker packets carry bounded digests and never the prompt or callback secret', () => {
  const packet = buildWorkerPacket(
    {
      taskId: 'task_x',
      objective: 'Implement one bounded change',
      workspace: '/tmp/ws',
      allowedReadRoots: ['/tmp/ws'],
      allowedWriteRoots: ['/tmp/ws/src'],
      protectedPaths: ['/tmp/ws/package.json'],
      acceptanceCommands: [['node', '--test', 'tests/x.test.mjs']],
    },
    { dispatchId: 'disp_x', bindingId: 'worker_x', coordinationId: 'coord_x', fenceEpoch: 3, mode: 'supervised-orchestration', guaranteeTier: 'owned-process' },
  );
  assert.equal(packet.schema, 'webmcp.ai-worker-packet/v0');
  assert.match(packet.objectiveDigest, /^sha256:/);
  assert.equal(packet.objectiveDigest.includes('Implement'), false);
  assert.equal(JSON.stringify(packet).includes('Implement one bounded change'), false, 'objective travels as a digest only');
  assert.equal(JSON.stringify(packet).includes('WEBMCP_AI_CALLBACK_CAPABILITY'), false);
  assert.deepEqual(packet.acceptanceCommands, [['node', '--test', 'tests/x.test.mjs']]);
  assert.equal(packet.cleanupOwner, 'coordination');
});

test('worker callbacks authorize only their own dispatch and dedupe terminals', async (t) => {
  const stateDir = tempDir(t, 'cb');
  const events = [];
  let seq = 0;
  const append = (type, payload, meta = {}) => {
    seq += 1;
    const envelope = {
      schema: 'webmcp.ai-orchestration-delivery/v0',
      deliveryId: `del_${seq}`,
      sequence: seq,
      coordinationId: 'coord_cb',
      type,
      time: new Date().toISOString(),
      payload,
      ...meta,
    };
    events.push(envelope);
    return envelope;
  };

  const handlers = createWorkerCallbackHandlers({
    coordinationId: 'coord_cb',
    fenceEpoch: () => 2,
    bindings: new Map([
      ['worker_ok', { dispatchId: 'disp_ok', taskId: 'task_ok', capabilityToken: 'cap-ok-token' }],
      ['worker_other', { dispatchId: 'disp_other', taskId: 'task_other', capabilityToken: 'cap-other' }],
    ]),
    activeDispatches: new Set(['disp_ok']),
    appendDelivery: append,
  });

  const baseCallback = {
    schema: 'webmcp.ai-worker-callback/v0',
    callbackId: 'cbk_one',
    coordinationId: 'coord_cb',
    taskId: 'task_ok',
    dispatchId: 'disp_ok',
    bindingId: 'worker_ok',
    fenceEpoch: 2,
    operation: 'worker.progress',
    input: { summary: 'working' },
  };
  const ok = await handlers['worker.progress']({
    callback: baseCallback,
    presentedCapability: 'cap-ok-token',
  });
  assert.equal(ok.ok, true);

  // Wrong capability for the binding is rejected without appending anything.
  const unauthorized = await handlers['worker.progress']({
    callback: { ...baseCallback, callbackId: 'cbk_two' },
    presentedCapability: 'wrong-token',
  });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.error.code, 'WORKER_CALLBACK_UNAUTHORIZED');

  // A callback aimed at another binding using our capability is rejected.
  const crossBinding = await handlers['worker.heartbeat']({
    callback: { ...baseCallback, callbackId: 'cbk_three', bindingId: 'worker_other', dispatchId: 'disp_other', taskId: 'task_other' },
    presentedCapability: 'cap-other',
    presentingBindingId: 'worker_ok',
  });
  assert.equal(crossBinding.ok, false);

  // Coordinator operations are not callable through the worker table.
  assert.equal(handlers['task.create'], undefined);

  // Identical duplicate terminals dedupe; conflicting ones escalate.
  const terminal = {
    schema: 'webmcp.ai-worker-callback/v0',
    callbackId: 'cbk_term',
    coordinationId: 'coord_cb',
    taskId: 'task_ok',
    dispatchId: 'disp_ok',
    bindingId: 'worker_ok',
    fenceEpoch: 2,
    operation: 'worker.terminal',
    input: { outcome: 'done' },
  };
  const firstTerminal = await handlers['worker.terminal']({ callback: terminal, presentedCapability: 'cap-ok-token' });
  assert.equal(firstTerminal.ok, true);
  const dupTerminal = await handlers['worker.terminal']({ callback: terminal, presentedCapability: 'cap-ok-token' });
  assert.equal(dupTerminal.ok, true);
  assert.equal(dupTerminal.duplicate, true);

  const conflictTerminal = {
    ...terminal,
    callbackId: 'cbk_term_conflict',
    input: { outcome: 'failed' },
  };
  const conflicted = await handlers['worker.terminal']({ callback: conflictTerminal, presentedCapability: 'cap-ok-token' });
  assert.equal(conflicted.ok, true);
  assert.equal(events.some((entry) => entry.type === 'escalation'), true, 'conflicting terminal appends escalation');

  // Worker terminals may only propose done|failed|cancelled — never acceptance.
  const illegalOutcome = await handlers['worker.terminal']({
    callback: { ...conflictTerminal, callbackId: 'cbk_bad', input: { outcome: 'accepted' } },
    presentedCapability: 'cap-ok-token',
  });
  assert.equal(illegalOutcome.ok, false);
  assert.equal(events.some((entry) => entry.type === 'acceptance_recorded'), false);
});

function workerEnv(mode, extra = {}) {
  return {
    ...process.env,
    FAKE_WORKER_MODE: mode,
    ...extra,
  };
}

function spawnRequest(mode, overrides = {}) {
  return {
    command: process.execPath,
    args: [fakeWorker],
    env: workerEnv(mode),
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    taskId: 'task_spawn',
    objective: 'Run the fake worker',
    workspace: '/tmp',
    allowedReadRoots: ['/tmp'],
    allowedWriteRoots: ['/tmp'],
    protectedPaths: [],
    acceptanceCommands: [],
    dependencies: [],
    delegationDepth: 1,
    commandPolicy: { allowedExecutables: [process.execPath] },
    initialRevision: null,
    initialStatusDigest: 'clean',
    ...overrides,
  };
}

function makeDispatch(overrides = {}) {
  return {
    dispatchId: 'disp_spawn',
    taskId: 'task_spawn',
    bindingId: 'worker_spawn',
    fenceEpoch: 1,
    mode: 'delegated-result-return',
    guaranteeTier: 'owned-process',
    ...overrides,
  };
}

test('owned process streams bounded output and synthesizes terminal evidence', async (t) => {
  const stateDir = tempDir(t, 'spawn');
  const events = [];
  const adapter = createOwnedProcessAdapter({ stateDir });

  const result = await adapter.spawn({
    task: makeTask(),
    dispatch: makeDispatch(),
    ...spawnRequest('ordered'),
    emit: (type, payload) => events.push({ type, payload }),
    signal: undefined,
  });
  assert.equal(result.ok, true);
  assert.match(result.binding.processIdentity.startIdentity, /^darwin:|^linux:/);

  await result.done;
  const types = events.map((event) => event.type);
  assert.equal(types.includes('worker_started'), true);
  assert.equal(types.filter((type) => type === 'progress').length >= 2, true, 'stdout and stderr observed');
  assert.equal(types.includes('worker_done'), true);
  const terminal = events.find((event) => event.type === 'worker_done');
  assert.equal(terminal.payload.exitCode, 0);
  assert.match(JSON.stringify(events), /hello-from-stdout/);
});

test('outputs beyond the inline bound spill into sanitized refs', async (t) => {
  const stateDir = tempDir(t, 'bigout');
  const events = [];
  const adapter = createOwnedProcessAdapter({ stateDir });
  const { done } = await adapter.spawn({
    task: makeTask(),
    dispatch: makeDispatch(),
    ...spawnRequest('big'),
    emit: (type, payload) => events.push({ type, payload }),
  });
  await done;

  const progressWithRef = events.find(
    (event) => event.type === 'progress' && typeof event.payload.ref === 'string',
  );
  assert.ok(progressWithRef, 'large stdout became a ref');
  assert.match(progressWithRef.payload.ref, /^refs\/ref_/);
  assert.match(progressWithRef.payload.sha256, /^[0-9a-f]{64}$/);
  const refPath = join(stateDir, progressWithRef.payload.ref.replace(/^refs\//, 'refs/'));
  assert.equal(existsSync(refPath), true);
  assert.equal(statSync(refPath).mode & 0o777, 0o600);
});

test('interrupt ladder records every attempted signal for an ignoring worker', async (t) => {
  const stateDir = tempDir(t, 'sigint');
  const events = [];
  const adapter = createOwnedProcessAdapter({ stateDir, signalGraceMs: 120 });
  const { done, binding } = await adapter.spawn({
    task: makeTask(),
    dispatch: makeDispatch(),
    ...spawnRequest('ignore-sigint'),
    emit: (type, payload) => events.push({ type, payload }),
  });

  await new Promise((resolveTick) => setTimeout(resolveTick, 250));
  const interrupt = await adapter.interrupt({ binding, reason: 'test-stop', epoch: 1, signal: {} });
  assert.equal(interrupt.ok, true);
  await done;

  const cleanup = events.find((event) => event.type === 'cleanup_recorded');
  assert.ok(cleanup, 'cleanup recorded');
  const signals = JSON.stringify(cleanup.payload);
  assert.match(signals, /SIGINT/);
  assert.match(signals, /SIGTERM/);
  assert.equal(events.some((event) => event.type === 'worker_cancelled'), true);
});

test('child processes of a worker die with its process group', async (t) => {
  const stateDir = tempDir(t, 'tree');
  const events = [];
  const adapter = createOwnedProcessAdapter({ stateDir });
  const { done, binding } = await adapter.spawn({
    task: makeTask(),
    dispatch: makeDispatch(),
    ...spawnRequest('child'),
    emit: (type, payload) => events.push({ type, payload }),
  });

  await new Promise((resolveTick) => setTimeout(resolveTick, 300));
  const { execFileSync } = await import('node:child_process');
  let childPid = null;
  try {
    childPid = Number.parseInt(
      execFileSync('pgrep', ['-P', String(binding.pid)], { encoding: 'utf8' }).trim().split('\n')[0],
      10,
    );
  } catch {
    childPid = null;
  }
  await adapter.interrupt({ binding, reason: 'tree-cleanup', epoch: 1, signal: {} });
  await done;
  await new Promise((resolveTick) => setTimeout(resolveTick, 200));

  if (childPid && Number.isFinite(childPid)) {
    let alive = false;
    try {
      process.kill(childPid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `worker child ${childPid} must not outlive its group`);
  }
});
