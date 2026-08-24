import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sanitizeValue } from '../src/orchestration/redaction.mjs';
import {
  prepareRuntimeDatabase,
} from '../src/orchestration/adapters/opencode-server.mjs';
import { createOpenCodeServerAdapter } from '../src/orchestration/adapters/opencode-server.mjs';
import { evaluateRetention, pruneCoordination } from '../src/orchestration/retention.mjs';
import { createOrchestrationClient, getOrchestrationCapabilities } from '../src/orchestration/client.mjs';
import { createWorkerCallbackHandlers } from '../src/orchestration/worker-callback.mjs';
import { commitDelivery, openCoordinationStore } from '../src/orchestration/store.mjs';
import { replayJournal } from '../src/orchestration/journal.mjs';

function fixture(t, name = 'sec') {
  const override = join(tmpdir(), `webmcp-ai-t10-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  t.after(() => rmSync(override, { recursive: true, force: true }));
  const layout = {
    coordinationDir: override,
    manifestPath: join(override, 'manifest.json'),
    journalPath: join(override, 'events.jsonl'),
    snapshotPath: join(override, 'snapshot.json'),
    refsDir: join(override, 'refs'),
    lockPath: join(override, 'supervisor.lock'),
  };
  mkdirSync(layout.refsDir, { recursive: true, mode: 0o700 });
  writeFileSync(layout.manifestPath, `${JSON.stringify({
    schema: 'webmcp.ai-orchestration-manifest/v0',
    coordinationId: 'coord_t10',
    fenceEpoch: 1,
    processGeneration: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
  })}\n`);
  return layout;
}

function seedStore(t, name) {
  const layout = fixture(t, name);
  const store = openCoordinationStore(layout);
  return { layout, store };
}

test('crash between journal append and snapshot write recovers to the journal truth', (t) => {
  const { layout, store } = seedStore(t, 'jahead');
  commitDelivery(store, { type: 'task_created', taskId: 'task_a', payload: { taskId: 'task_a' }, time: 't1' });

  // Simulate a crash after fsync but before the atomic snapshot rename by
  // appending one more durable line without touching the snapshot.
  const extraLine = `${JSON.stringify({
    schema: 'webmcp.ai-orchestration-delivery/v0',
    deliveryId: 'del_manual_2',
    sequence: 2,
    coordinationId: 'coord_t10',
    type: 'heartbeat',
    time: 't2',
    payload: {},
  })}\n`;
  writeFileSync(layout.journalPath, `${readFileSync(layout.journalPath, 'utf8')}${extraLine}`);

  const recovered = openCoordinationStore(layout);
  assert.equal(recovered.state.lastSequence, 2, 'new complete journal state wins');
  assert.equal(JSON.parse(readFileSync(layout.snapshotPath, 'utf8')).lastSequence, 2, 'snapshot rebuilt atomically');
});

test('a fabricated midpoint never appears: journal is canonical over stale snapshots', (t) => {
  const { layout, store } = seedStore(t, 'midpoint');
  commitDelivery(store, { type: 'task_created', taskId: 'task_b', payload: { taskId: 'task_b' }, time: 't1' });
  // Corrupt ONLY the snapshot to claim a future that never happened.
  const snap = JSON.parse(readFileSync(layout.snapshotPath, 'utf8'));
  snap.tasks.task_b.state = 'accepted';
  writeFileSync(layout.snapshotPath, `${JSON.stringify(snap)}\n`);

  const recovered = openCoordinationStore(layout);
  assert.equal(recovered.state.tasks.task_b.state, 'created', 'journal beats the snapshot');
});

test('ack watermarks are monotonic and gaps are typed errors', async (t) => {
  const mod = await import('../src/orchestration/state-machine.mjs');
  let state = mod.createInitialState({ coordinationId: 'coord_gap', fenceEpoch: 1, processGeneration: 1, createdAt: 'x' });
  for (let index = 0; index < 10; index += 1) {
    state = mod.applyDelivery(state, { schema: 'webmcp.ai-orchestration-delivery/v0', type: 'heartbeat' });
  }
  state = mod.acknowledgeThrough(state, 10);
  assert.equal(mod.acknowledgeThrough(state, 9).acknowledgedThrough === 10, true, 'ack 10 then ack 9 keeps 10');
  assert.throws(() => mod.acknowledgeThrough(state, 11), (error) => error.code === 'ORCHESTRATION_INVALID_INPUT');
  assert.throws(
    () => mod.applyDelivery(state, { schema: 'webmcp.ai-orchestration-delivery/v0', type: 'heartbeat', sequence: 12 }),
    (error) => error.code === 'ORCHESTRATION_EVENT_GAP',
  );
});

test('newline injection in a payload cannot split journal records', (t) => {
  const { layout, store } = seedStore(t, 'newline');
  commitDelivery(store, {
    type: 'progress',
    payload: { text: 'line1\n{"deliveryId":"evil","sequence":99}\nline3', secretToken: 'tok_abc' },
    time: 'tn',
  });
  const replayed = replayJournal(layout);
  assert.equal(replayed.deliveries.length, 1, 'still one JSONL record');
  assert.equal(replayed.deliveries[0].sequence, 1);
  const firstRawLine = readFileSync(layout.journalPath, 'utf8').split('\n')[0];
  assert.match(firstRawLine, /line1\\n/, 'raw JSONL keeps the escaped newline');
  const roundTrip = JSON.parse(firstRawLine);
  assert.match(roundTrip.payload.text, /line3$/);
});

test('adversarial outputs are sanitized: tokens, auth headers, env keys, reasoning', () => {
  const hostile = sanitizeValue({
    nested: {
      OPENCODE_SERVER_PASSWORD: 'pw-value',
      cookie: 'session=steal-me',
      apiKey: 'AKIA-example',
      note: 'Authorization: Basic dXNlcjpwYXNz in prose',
    },
    reasoning: 'chain of thought stays out',
    safeNumber: 42,
    toolOutput: { refreshToken: 'rt-value', keep: 'yes' },
  }, {});
  const serialized = JSON.stringify(hostile);
  for (const forbidden of ['pw-value', 'session=steal-me', 'AKIA-example', 'dXNlcjpwYXNz', 'chain of thought', 'rt-value']) {
    assert.equal(serialized.includes(forbidden), false, `leak: ${forbidden}`);
  }
  assert.equal(hostile.safeNumber, 42);
  assert.equal(hostile.toolOutput.keep, 'yes');
  assert.equal(hostile.reasoning, undefined);
});

test('worker callbacks cannot inject acceptance commands or acceptance deliveries', async (t) => {
  const { layout, store } = seedStore(t, 'cbinject');
  commitDelivery(store, { type: 'task_created', payload: { taskId: 'task_w' } });
  commitDelivery(store, { type: 'dispatch_created', payload: { dispatchId: 'disp_w', taskId: 'task_w' } });
  commitDelivery(store, { type: 'dispatch_state_changed', payload: { dispatchId: 'disp_w', taskId: 'task_w', state: 'active' } });
  const handlers = createWorkerCallbackHandlers({
    coordinationId: 'coord_cb',
    fenceEpoch: () => store.state.fenceEpoch,
    bindings: new Map([['worker_w', { dispatchId: 'disp_w', taskId: 'task_w', capabilityToken: 'cap' }]]),
    activeDispatches: () => new Set(['disp_w']),
    knownDispatchIds: () => new Set(Object.keys(store.state.dispatches)),
    dispatchOutcomeOf: (dispatchId) => store.state.dispatches[dispatchId]?.terminalOutcome ?? null,
    appendDelivery: (type, payload, callbackRef) => {
      const result = commitDelivery(store, { type, payload, ...(callbackRef ? { callbackRef } : {}) });
      if (result.duplicate) return { duplicate: true, acknowledgedSequence: result.acknowledgedSequence };
      return { sequence: result.delivery.sequence };
    },
  });
  await handlers['worker.terminal']({
    callback: {
      schema: 'webmcp.ai-worker-callback/v0',
      callbackId: 'cbk_x',
      coordinationId: 'coord_cb',
      taskId: 'task_w',
      dispatchId: 'disp_w',
      bindingId: 'worker_w',
      fenceEpoch: 1,
      callbackSeq: 1,
      operation: 'worker.terminal',
      input: { outcome: 'done', acceptanceCommands: [['curl', 'evil']], verdict: 'GREEN' },
    },
    presentedCapability: 'cap',
  });
  const serialized = readFileSync(layout.journalPath, 'utf8');
  assert.equal(serialized.includes('acceptance_recorded'), false);
  assert.equal(serialized.includes('curl'), false, 'provider-supplied commands never persist');
});

test('observer bindings cannot abort or delete external sessions', (t) => {
  const adapter = createOpenCodeServerAdapter({ stateDir: tempDirOf(t) });
  const { binding } = adapter.attachExternal({ sessionId: 'ses_ext' });
  assert.rejects(() => Promise.resolve(adapter.abortSession(binding)), (error) => error.code === 'WORKER_IDENTITY_UNPROVEN');
  assert.rejects(() => Promise.resolve(adapter.deleteSession(binding)), (error) => error.code === 'WORKER_IDENTITY_UNPROVEN');
});

function tempDirOf(t) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-t10-obs-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('prune never abandons when owned-worker liveness is indeterminate', () => {
  const state = {
    coordinationState: 'open',
    updatedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
    acknowledgedThrough: 5,
    lastSequence: 5,
  };
  const indeterminate = evaluateRetention(state, Date.now(), { ownedWorkerLive: null });
  assert.equal(indeterminate.eligible, false, 'unknown liveness blocks abandonment');
  const dead = evaluateRetention(state, Date.now(), { ownedWorkerLive: false });
  assert.equal(dead.eligible, true);
});

test('runtime database preparation refuses symlink swaps between validation and use', (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), `webmcp-ai-t10-swap-`));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'webmcp-ai-runtime'), { recursive: true });
  prepareRuntimeDatabase({ dataRoot, bindingId: 'worker_swap' });
  const outside = tmpdir();
  rmSync(join(dataRoot, 'webmcp-ai-runtime', 'worker_swap2'), { force: true });
  symlinkSync(outside, join(dataRoot, 'webmcp-ai-runtime', 'worker_swap2'), 'dir');
  assert.throws(
    () => prepareRuntimeDatabase({ dataRoot, bindingId: 'worker_swap2' }),
    (error) => error.code === 'POLICY_DENIED',
  );
});

test('the kill switch restores the stable one-shot path end to end', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), `webmcp-ai-t10-kill-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const env = { ...process.env, WEBMCP_AI_ORCHESTRATION_DISABLED: '1', WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir };
  const client = createOrchestrationClient({ env });

  await assert.rejects(
    () => client.create({ protocol: 'webmcp.ai-orchestration/v0', requestId: 'req_k1' }),
    (error) => error.code === 'ORCHESTRATION_DISABLED',
  );
  await assert.rejects(() => client.prune(), (error) => error.code === 'ORCHESTRATION_DISABLED');

  const caps = getOrchestrationCapabilities({ env });
  assert.equal(caps.enabled, false);
  assert.equal(typeof client.guide({ format: 'markdown' }), 'string');
  assert.equal(existsSync(join(stateDir, 'coordinations')), false, 'no state directory is created');
});

// ---------------------------------------------------------------------------
// Task 10 supplementary branch coverage across adapters, IPC and supervisor.
// ---------------------------------------------------------------------------

import { createIpcServer, deriveEndpoint } from '../src/orchestration/ipc.mjs';

test('opencode event normalization covers every documented provider shape', async () => {
  const { normalizeOpenCodeEvent, createEventDeduper } = await require_events();
  const deduper = createEventDeduper();
  const binding = { sessionId: 'ses_a', bindingId: 'worker_a' };

  const mapped = (event) => normalizeOpenCodeEvent(event, binding, deduper);
  assert.equal(mapped({ type: 'session.status', sessionID: 'ses_b', properties: { status: { type: 'busy' } } }), null, 'foreign session filtered');
  assert.equal(mapped({ type: 'session.status', sessionID: 'ses_a', properties: { status: { type: 'busy' } } }).kind, 'session_status_busy');
  assert.equal(mapped({ type: 'session.status', sessionID: 'ses_a', properties: { status: { type: 'retry' } } }).kind, 'retry');
  assert.equal(mapped({ type: 'message.part.updated', sessionID: 'ses_a', properties: { part: { id: 'p1', type: 'step-start', sessionID: 'ses_a' } } }).kind, 'part_step-start');
  assert.equal(mapped({ type: 'totally.unknown', sessionID: 'ses_a' }), null, 'unknown types dropped');
  assert.equal(mapped(null), null);

  const first = mapped({ type: 'server.connected', sessionID: 'ses_a' });
  const second = mapped({ type: 'server.connected', sessionID: 'ses_a' });
  assert.ok(first);
  assert.equal(second, null);
});

async function require_events() {
  return await import('../src/orchestration/adapters/opencode-events.mjs');
}

test('claude hook-mode argv is isolated; unsafe surfaces throw typed errors', async (t) => {
  const claude = await import('../src/orchestration/adapters/claude-stream.mjs');
  const invocation = claude.buildClaudeInvocation({
    sessionId: null,
    hookMode: true,
    settingsPath: '/private/settings.json',
    mcpConfigPath: '/private/mcp.json',
  });
  for (const flag of ['--bare', '--settings', '--strict-mcp-config', '--mcp-config', '--include-hook-events']) {
    assert.equal(invocation.args.includes(flag), true, `missing ${flag}`);
  }
  assert.equal(invocation.args.includes('--safe-mode'), false);

  const adapter = claude.createClaudeStreamAdapter({ stateDir: covTemp(t, 'claude') });
  const probe = await adapter.probe({ env: {} });
  assert.equal(probe.available, false);
  for (const method of ['attach', 'sendReply', 'sendGuidance', 'resolvePermission']) {
    assert.throws(() => adapter[method]({}), (error) => error.code === 'UNSUPPORTED_CAPABILITY');
  }
  assert.deepEqual(adapter.subscribe({}), { ok: true, deliveries: [], cursor: null });
  assert.equal(adapter.sanitize({ type: 'stream_event' }), null);
  assert.equal(adapter.sanitize({ type: 'system', subtype: 'other' }), null);
});

function covTemp(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-t10c-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('codex adapter negatives are typed and events map bounded evidence', async (t) => {
  const codex = await import('../src/orchestration/adapters/codex-exec.mjs');
  const adapter = codex.createCodexExecAdapter({ stateDir: covTemp(t, 'codex') });
  for (const method of ['attach', 'sendReply', 'sendGuidance', 'resolvePermission', 'interrupt']) {
    assert.throws(() => adapter[method]({}), (error) => error.code === 'UNSUPPORTED_CAPABILITY');
  }
  assert.deepEqual(adapter.subscribe({}), { ok: true, deliveries: [], cursor: null });

  const started = codex.normalizeCodexEvent({ type: 'item.started', item: { id: 'i1', type: 'file_change', changes: ['a'] } });
  assert.equal(started.kind, 'file_change');
  assert.equal(codex.normalizeCodexEvent({ type: 'item.completed', item: { id: 'i2', type: 'mystery' } }), null);
  assert.equal(codex.normalizeCodexEvent({ type: 'item.started', item: { id: 'i3', type: 'reasoning' } }), null);
  assert.equal(codex.normalizeCodexEvent(null), null);
});

test('ipc transport fails closed on bad endpoint configs', () => {
  assert.throws(() => createIpcServer(null), (error) => error.code === 'POLICY_DENIED');
  assert.throws(
    () => createIpcServer({ endpoint: '/tmp/not-a-socket.txt', capability: 'x', handler: () => ({}) }),
    (error) => error.code === 'POLICY_DENIED',
  );
  assert.throws(
    () => createIpcServer({ capability: 'x', handler: () => ({}) }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.match(deriveEndpoint({ ipcRoot: '/x', coordinationId: 'coord_1', platform: 'win32' }), /webmcp-ai-/);
});

test('supervisor envelopes reject wrong protocol and unknown operations', async (t) => {
  const client = createOrchestrationClient({
    env: { ...process.env, WEBMCP_AI_ORCHESTRATION_STATE_DIR: covTemp(t, 'sup2') },
  });
  t.after(() => client.dispose());
  const created = await client.create({ protocol: 'webmcp.ai-orchestration/v0', requestId: 'req_cov_c' });

  const wrongProtocol = await client.__callRawEnvelope(created.coordinationId, {
    protocol: 'webmcp.ai-orchestration/v9',
    requestId: 'req_cov_proto',
  });
  assert.equal(wrongProtocol.ok, false);
  assert.equal(wrongProtocol.error.code, 'ORCHESTRATION_UNSUPPORTED_VERSION');

  const unknownOp = await client.__callRawEnvelope(created.coordinationId, {
    requestId: 'req_cov_op',
    operation: 'teleport.worker',
  });
  assert.equal(unknownOp.ok, false);
  assert.equal(unknownOp.error.code, 'ORCHESTRATION_INVALID_INPUT');
});

test('retention prune receipts cover refs pruning and absent directories', async (t) => {
  const { pruneCoordination } = await import('../src/orchestration/retention.mjs');
  const refsDir = covTemp(t, 'refs');
  mkdirSync(join(refsDir, 'refs'), { recursive: true });
  const layout = {
    coordinationDir: refsDir,
    manifestPath: join(refsDir, 'manifest.json'),
    journalPath: join(refsDir, 'events.jsonl'),
    snapshotPath: join(refsDir, 'snapshot.json'),
    refsDir: join(refsDir, 'refs'),
    lockPath: join(refsDir, 'supervisor.lock'),
  };
  const prunedRefs = await pruneCoordination(layout, { action: 'delete-large-refs', maySignalWorkers: false, reason: 'x' });
  assert.equal(prunedRefs.action, 'delete-large-refs');
  // An already-absent coordination directory yields an empty receipt.
  const goneLayout = { ...layout, coordinationDir: join(refsDir, 'does-not-exist') };
  const absent = await pruneCoordination(goneLayout, { action: 'delete-closed-state', maySignalWorkers: false, reason: 'gone' });
  assert.deepEqual(absent.pruned, []);
});

test('delivery.wait rejects cursors behind the acknowledgement watermark', async (t) => {
  const client = createOrchestrationClient({
    env: { ...process.env, WEBMCP_AI_ORCHESTRATION_STATE_DIR: covTemp(t, 'cursor') },
  });
  t.after(() => client.dispose());
  const created = await client.create({ protocol: 'webmcp.ai-orchestration/v0', requestId: 'req_cur_c' });
  await client.call(created.coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_cur_t',
    operation: 'task.create',
    input: { packet: { objective: 'Cursor work', workspace: '/tmp/ws' } },
  });
  const waited = await client.call(created.coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_cur_w',
    operation: 'delivery.wait',
    input: { afterSequence: 0, timeoutMs: 1000 },
  });
  assert.equal(waited.ok, true);
  await client.call(created.coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_cur_a',
    operation: 'delivery.ack',
    input: { throughSequence: waited.result.lastSequence },
  });
  const expired = await client.call(created.coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_cur_e',
    operation: 'delivery.wait',
    input: { afterSequence: 1, timeoutMs: 500 },
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, 'ORCHESTRATION_CURSOR_EXPIRED');
});

test('provider event mappers cover remaining documented shapes and negatives', async () => {
  const oc = await import('../src/orchestration/adapters/opencode-events.mjs');
  const d = oc.createEventDeduper();
  const b = { sessionId: 'ses_x', bindingId: 'worker_x' };
  const text = oc.normalizeOpenCodeEvent({ type: 'message.part.updated', sessionID: 'ses_x', properties: { part: { id: 'pt', messageID: 'm', type: 'text', text: 'hi', sessionID: 'ses_x' } } }, b, d);
  assert.equal(text.kind, 'assistant_text');
  const toolUse = oc.normalizeOpenCodeEvent({ type: 'message.part.updated', sessionID: 'ses_x', properties: { part: { id: 'pt2', type: 'tool', tool: 'bash', state: { status: 'running', output: 'x' }, sessionID: 'ses_x' } } }, b, d);
  assert.equal(toolUse.payload.outputOmitted, true);
  const stepFinish = oc.normalizeOpenCodeEvent({ type: 'message.part.updated', sessionID: 'ses_x', properties: { part: { id: 'pt3', type: 'step-finish', tokens: { total: 9 }, sessionID: 'ses_x' } } }, b, d);
  assert.equal(stepFinish.payload.tokensTotal, 9);
  const permReq = oc.normalizeOpenCodeEvent({ type: 'permission.updated', sessionID: 'ses_x', properties: { permission: { id: 'pm1', title: 'Allow?' } } }, b, d);
  assert.equal(permReq.deliveryType, 'permission_requested');
  const permRep = oc.normalizeOpenCodeEvent({ type: 'permission.replied', sessionID: 'ses_x', properties: { permissionID: 'pm1', response: 'allow' } }, b, d);
  assert.equal(permRep.deliveryType, 'permission_resolved');
  const diff = oc.normalizeOpenCodeEvent({ type: 'session.diff', sessionID: 'ses_x', properties: { diff: { files: [{ path: 'a', additions: 1 }] } } }, b, d);
  assert.match(diff.summary, /1 files/);
  const todo = oc.normalizeOpenCodeEvent({ type: 'todo.updated', sessionID: 'ses_x', properties: { todos: [{ id: '1', status: 'completed' }, { id: '2', status: 'pending' }] } }, b, d);
  assert.equal(todo.kind, 'todo_updated');
  assert.equal(oc.normalizeOpenCodeEvent({ type: 'message.part.updated', sessionID: 'ses_other', properties: { part: { id: 'zz', type: 'text', sessionID: 'ses_other' } } }, b, d), null);

  const cx = await import('../src/orchestration/adapters/codex-exec.mjs');
  assert.equal(cx.normalizeCodexEvent({ type: 'thread.started', thread_id: 'thr_z' }).kind, 'thread_started');
  assert.equal(cx.normalizeCodexEvent({ type: 'turn.started' }).kind, 'turn_started');
  const cmdDone = cx.normalizeCodexEvent({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', exit_code: 3, aggregated_output: 'out' } });
  assert.equal(cmdDone.payload.exitCode, 3);

  const cl = await import('../src/orchestration/adapters/claude-stream.mjs');
  const userToolResult = cl.normalizeClaudeEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu9', content: 'raw' }] } });
  assert.equal(userToolResult[0].payload.outputOmitted, true);
  assert.deepEqual(cl.normalizeClaudeEvent({ type: 'user', message: { content: [{ type: 'other' }] } }), []);
});

test('asAiCliError wraps foreign errors and guide supports json format', async () => {
  const errorsMod = await import('../src/errors.mjs');
  const wrapped = errorsMod.asAiCliError(new Error('boom'));
  assert.equal(wrapped.code, 'INTERNAL_ERROR');

  const orchClientMod = await import('../src/orchestration/client.mjs');
  const caps = orchClientMod.getOrchestrationCapabilities({});
  assert.equal(caps.ok, true);
});

test('platform identity probes resolve on darwin and fail safe elsewhere', async () => {
  const identity = await import('../src/orchestration/process-identity.mjs');
  const darwinDeps = identity.createPlatformIdentityDeps('darwin');
  const start = await darwinDeps.getStartIdentity(process.pid);
  assert.match(start ?? '', /^darwin:/);
  const pgid = await darwinDeps.getStartIdentity(process.pid);
  assert.ok(pgid !== undefined);

  const winDeps = identity.createPlatformIdentityDeps('win32');
  assert.equal(await winDeps.getStartIdentity(process.pid), null, 'win32 probe is fixture-only off-platform');
});

test('ipc handler failures and malformed frames produce typed error envelopes', async (t) => {
  const socketPath = join(covTemp(t, 'sock'), 'cov.sock');
  mkdirSync(join(socketPath, '..'), { recursive: true, mode: 0o700 });
  const server = await createIpcServer({
    endpoint: socketPath,
    capability: 'cap-cov',
    protocol: 'webmcp.ai-orchestration/v0',
    handler: () => {
      throw new Error('handler exploded');
    },
  });
  t.after(() => server.close());

  const { requestIpc } = await import('../src/orchestration/ipc.mjs');
  const boom = await requestIpc(socketPath, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_boom',
    capability: 'cap-cov',
    operation: 'coordination.inspect',
    input: {},
  }, { timeoutMs: 3000 });
  assert.equal(boom.ok, false);
  assert.equal(boom.error.code, 'ORCHESTRATION_INDETERMINATE');

  // Malformed non-JSON frames get a typed rejection instead of a crash.
  const net = await require_net();
  await new Promise((resolveFrame) => {
    const socket = net.connect(socketPath);
    socket.on('connect', () => {
      socket.write('not-json-at-all\n');
    });
    socket.on('data', (chunk) => {
      const parsed = JSON.parse(chunk.toString().split('\n')[0]);
      assert.equal(parsed.error.code, 'ORCHESTRATION_INVALID_INPUT');
      socket.destroy();
      resolveFrame();
    });
    setTimeout(resolveFrame, 2000).unref();
  });
});

async function require_net() {
  return await import('node:net');
}

test('owned workers are interrupted and closed deterministically through adapters', async (t) => {
  const claude = await import('../src/orchestration/adapters/claude-stream.mjs');
  const { fileURLToPath } = await import('node:url');
  const fakeClaudeBin = fileURLToPath(new URL('./fixtures/orchestration/fake-claude.mjs', import.meta.url));
  const adapter = claude.createClaudeStreamAdapter({
    stateDir: covTemp(t, 'cl-life'),
    claudeBin: process.execPath,
    claudeArgs: [fakeClaudeBin],
    fakeModeEnv: { FAKE_CLAUDE_MODE: 'busy-followup' },
  });

  const events = [];
  const spawned = await adapter.spawn({
    task: { taskId: 'task_life', workspace: '/tmp' },
    dispatch: { dispatchId: 'disp_life', bindingId: 'worker_life', taskId: 'task_life', fenceEpoch: 1 },
    emit: (type, payload) => events.push({ type, payload }),
  });

  const noProof = await adapter.interrupt({});
  assert.equal(noProof.ok, false);

  const interrupted = await adapter.interrupt({ binding: spawned.binding, reason: 'lifecycle-test' });
  assert.equal(interrupted.ok, true);
  await spawned.done;

  const cleanup = events.find((entry) => entry.type === 'cleanup_recorded');
  assert.equal(
    ['interrupted', 'exited'].includes(cleanup.payload.disposition) || cleanup.payload.unfinishedTurn === true,
    true,
  );
  assert.equal(cleanup.payload.resumableSessionId, spawned.binding.sessionId, 'resume stays possible');
  assert.equal(typeof spawned.binding.sessionId, 'string');

  const closed = await adapter.close({ binding: spawned.binding });
  assert.equal(closed.ok, true);
});

test('adapter index guards: validation errors, digests and mode/tier policy', async (t) => {
  const index = await import('../src/orchestration/adapters/index.mjs');
  const noop = async () => ({});
  const caps = { liveEvents: false, explicitResume: false, externalAttach: false, questionChannel: false,
    permissionControl: false, sameTurnSteer: false, gracefulInterrupt: false, preToolGate: false,
    processOwnership: false, fileEvents: false, testEvents: false };
  const valid = { id: 'ok-adapter', maturity: 'fixture-only', capabilities: caps,
    probe: noop, spawn: noop, attach: noop, subscribe: noop, readSession: noop, sendReply: noop,
    sendGuidance: noop, resolvePermission: noop, interrupt: noop, close: noop, sanitize: (x) => x };

  assert.equal(index.validateAdapter(valid).id, 'ok-adapter');
  assert.throws(() => index.validateAdapter('nope'), (e) => e.code === 'ORCHESTRATION_INVALID_INPUT');
  assert.throws(() => index.validateAdapter({ ...valid, id: 'Bad_ID' }), (e) => e.code === 'ORCHESTRATION_INVALID_INPUT');
  assert.throws(() => index.validateAdapter({ ...valid, probe: 'x' }), (e) => e.code === 'ORCHESTRATION_INVALID_INPUT');

  const registry = index.createDefaultOrchestrationAdapters({ ownedProcess: valid });
  assert.deepEqual(registry.ids(), ['ok-adapter']);
  assert.equal(registry.get('missing'), null);
  assert.throws(() => registry.require('missing'), (e) => e.code === 'UNSUPPORTED_CAPABILITY');
  assert.equal(index.maxAcceptanceCommands(), 16);
  assert.match(index.computeAdapterDigest(valid), /^[0-9a-f]{64}$/);

  assert.throws(
    () => index.assertModeTierCompatible('supervised-orchestration', 'mystery-tier'),
    (e) => e.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => index.assertModeTierCompatible('supervised-orchestration', 'unsupported'),
    (e) => e.code === 'POLICY_DENIED',
  );
  // Read-only observation is permitted for observer tiers.
  assert.equal(index.assertModeTierCompatible('delegated-result-return', 'attached-observer', { mutable: true }), true);
});

test('owned-process adapter guards reject string argv and expose typed negatives', async (t) => {
  const op = await import('../src/orchestration/adapters/owned-process.mjs');
  const stateDir = covTemp(t, 'op-guards');
  const adapter = op.createOwnedProcessAdapter({ stateDir });

  await assert.rejects(
    () => adapter.spawn({ task: { workspace: '/tmp' }, dispatch: {}, emit: () => {}, args: 'not-an-array' }),
    (e) => e.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(() => op.createOwnedProcessAdapter({}), (e) => e.code === 'ORCHESTRATION_INVALID_INPUT');
  await assert.rejects(() => adapter.attach({}), (e) => e.code === 'WORKER_IDENTITY_UNPROVEN');
  assert.throws(() => adapter.sendReply({}), (e) => e.code === 'UNSUPPORTED_CAPABILITY');
  assert.throws(() => adapter.sendGuidance({}), (e) => e.code === 'UNSUPPORTED_CAPABILITY');
  assert.throws(() => adapter.resolvePermission({}), (e) => e.code === 'UNSUPPORTED_CAPABILITY');
  assert.deepEqual(await adapter.subscribe({}), { ok: true, deliveries: [], cursor: null });
  assert.equal(await adapter.readSession({}), null);

  const closed = await adapter.close({ binding: { processIdentity: { pid: 1, processGroupId: 1 } } });
  assert.equal(closed.ok, true);
  assert.equal(closed.disposition, 'no-op', 'degenerate system groups are never signalled');
});

test('opencode-server guards cover bad bindings and control-target mismatches', async (t) => {
  const server = await require_ocserver();
  const guardStateDir = mkdtempSync(join(tmpdir(), 'oc-guard-'));
  t.after(() => rmSync(guardStateDir, { recursive: true, force: true }));
  const adapter = server.createOpenCodeServerAdapter({ stateDir: guardStateDir });

  assert.throws(() => server.prepareRuntimeDatabase({ dataRoot: '/tmp/x', bindingId: 'bad' }), (e) => e.code === 'ORCHESTRATION_INVALID_INPUT');
  assert.throws(
    () => server.prepareRuntimeDatabase({ dataRoot: 'relative/path', bindingId: 'worker_ok' }),
    (e) => e.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(() => server.buildIsolatedEnv({ dbPath: 'rel.db', dispatchPrivateDir: '/d', password: 'p' }), (e) => e.code === 'ORCHESTRATION_INVALID_INPUT');
  assert.throws(() => adapter.sendReply({}), (e) => e.code === 'UNSUPPORTED_CAPABILITY');
  assert.throws(() => adapter.sendGuidance({}), (e) => e.code === 'UNSUPPORTED_CAPABILITY');
  assert.throws(() => adapter.spawn({}), (e) => e.code === 'UNSUPPORTED_CAPABILITY', 'server adapter owns servers, not raw processes');
});

async function require_ocserver() {
  return await import('../src/orchestration/adapters/opencode-server.mjs');
}

test('worker callback dedupe rejects id reuse with different content', async (t) => {
  const wc = await import('../src/orchestration/worker-callback.mjs');
  const { layout, store } = seedStore(t, 'cbdedupe');
  commitDelivery(store, { type: 'task_created', payload: { taskId: 'task_d' } });
  commitDelivery(store, { type: 'dispatch_created', payload: { dispatchId: 'disp_d', taskId: 'task_d' } });
  commitDelivery(store, { type: 'dispatch_state_changed', payload: { dispatchId: 'disp_d', taskId: 'task_d', state: 'active' } });
  const handlers = wc.createWorkerCallbackHandlers({
    coordinationId: 'coord_d',
    fenceEpoch: () => store.state.fenceEpoch,
    bindings: new Map([['worker_d', { dispatchId: 'disp_d', taskId: 'task_d', capabilityToken: 'cap-d' }]]),
    activeDispatches: () => new Set(['disp_d']),
    knownDispatchIds: () => new Set(Object.keys(store.state.dispatches)),
    dispatchOutcomeOf: (dispatchId) => store.state.dispatches[dispatchId]?.terminalOutcome ?? null,
    appendDelivery: (type, payload, callbackRef) => {
      const result = commitDelivery(store, { type, payload, ...(callbackRef ? { callbackRef } : {}) });
      if (result.duplicate) return { duplicate: true, acknowledgedSequence: result.acknowledgedSequence };
      return { sequence: result.delivery.sequence };
    },
  });
  const base = {
    schema: 'webmcp.ai-worker-callback/v0', callbackId: 'cbk_dup', coordinationId: 'coord_d',
    taskId: 'task_d', dispatchId: 'disp_d', bindingId: 'worker_d', fenceEpoch: 1,
    operation: 'worker.progress', callbackSeq: 1, input: { summary: 'first' },
  };
  assert.equal((await handlers['worker.progress']({ callback: base, presentedCapability: 'cap-d' })).ok, true);
  const reused = await handlers['worker.progress']({ callback: { ...base, input: { summary: 'different' } }, presentedCapability: 'cap-d' });
  assert.equal(reused.ok, false);
  assert.equal(reused.error.code, 'WORKER_CALLBACK_UNAUTHORIZED');

  await handlers['worker.question']({ callback: { ...base, callbackId: 'cbk_q', operation: 'worker.question', callbackSeq: 2, input: { question: 'why' } }, presentedCapability: 'cap-d' });
  assert.equal(readFileSync(layout.journalPath, 'utf8').includes('"type":"question"'), true);
});

test('linux identity probes fail safe to null off-platform', async () => {
  const identity = await import('../src/orchestration/process-identity.mjs');
  const linuxDeps = identity.createPlatformIdentityDeps('linux');
  assert.equal(await linuxDeps.getStartIdentity(process.pid), null, '/proc absent on this platform');
});

async function assertPidDies(t, pidFile, label) {
  const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
  assert.equal(Number.isFinite(pid), true, `${label} recorded its pid`);
  const deadline = Date.now() + 3000;
  let alive = true;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
      break;
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));
  }
  assert.equal(alive, false, `${label} must be torn down, never orphaned`);
}

test('bootstrap ready-line failure kills the runtime server instead of orphaning it', { timeout: 20_000 }, async (t) => {
  const serverMod = await require_ocserver();
  const stateDir = covTemp(t, 'boot-badline');
  const workspace = covTemp(t, 'boot-ws1');
  const pidFile = join(stateDir, 'server.pid');
  const badLineFixture = join(stateDir, 'bad-line.mjs');
  writeFileSync(
    badLineFixture,
    `import { writeFileSync } from 'node:fs';\n` +
      `const mode = process.argv[2];\n` +
      `if (mode === 'debug') { console.log('{}'); process.exit(0); }\n` +
      `if (mode === 'db') { console.log(process.env.OPENCODE_DB ?? ''); process.exit(0); }\n` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      `process.stdout.write('definitely-not-json\\n');\n` +
      `setInterval(() => {}, 1000);\n`,
  );

  // Garbage output never matches either ready dialect, so the bounded
  // bootstrap gives up; the invariant under test is the teardown, not the
  // exact error text.
  const adapter = serverMod.createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [badLineFixture],
    stateDir,
    bootstrapTimeoutMs: 700,
  });

  await assert.rejects(
    () => adapter.startRuntimeServer({ workspace, bindingId: 'worker_boot1', fenceEpoch: 1 }),
    (error) => error.code === 'PROVIDER_PROTOCOL_ERROR' && /timed out/.test(error.message),
  );
  await assertPidDies(t, pidFile, 'bad-ready-line server');
});

test('bootstrap timeout kills the runtime server instead of orphaning it', { timeout: 10_000 }, async (t) => {
  const serverMod = await require_ocserver();
  const stateDir = covTemp(t, 'boot-timeout');
  const workspace = covTemp(t, 'boot-ws2');
  const pidFile = join(stateDir, 'server.pid');
  const silentFixture = join(stateDir, 'silent.mjs');
  writeFileSync(
    silentFixture,
    `import { writeFileSync } from 'node:fs';\n` +
      `const mode = process.argv[2];\n` +
      `if (mode === 'debug') { console.log('{}'); process.exit(0); }\n` +
      `if (mode === 'db') { console.log(process.env.OPENCODE_DB ?? ''); process.exit(0); }\n` +
      `if (mode === 'serve') {\n` +
      `  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      `  setInterval(() => {}, 1000);\n` +
      `}\n`,
  );

  const adapter = serverMod.createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [silentFixture],
    stateDir,
    bootstrapTimeoutMs: 250,
  });

  await assert.rejects(
    () => adapter.startRuntimeServer({ workspace, bindingId: 'worker_boot2', fenceEpoch: 1 }),
    (error) => error.code === 'PROVIDER_PROTOCOL_ERROR' && /timed out/.test(error.message),
  );
  await assertPidDies(t, pidFile, 'timed-out server');
});

test('stopServer sweeps the whole detached group including grandchildren', { timeout: 20_000 }, async (t) => {
  const serverMod = await require_ocserver();
  const stateDir = covTemp(t, 'group-sweep');
  const workspace = covTemp(t, 'group-ws');
  const kidFile = join(stateDir, 'kid.pid');
  const serveFixture = join(stateDir, 'serve-with-kid.mjs');
  writeFileSync(serveFixture, [
    `import { createServer } from 'node:http';`,
    `import { spawn } from 'node:child_process';`,
    `import { writeFileSync } from 'node:fs';`,
    `const mode = process.argv[2];`,
    `if (mode === '--version') { console.log('1.18.21'); process.exit(0); }`,
    `if (mode === 'debug') { console.log('{}'); process.exit(0); }`,
    `if (mode === 'db') { console.log(process.env.OPENCODE_DB ?? ''); process.exit(0); }`,
    `if (mode === 'serve') {`,
    `  const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
    `  writeFileSync(${JSON.stringify(kidFile)}, String(kid.pid));`,
    `  const pass = process.env.WEBMCP_FAKE_SERVER_PASSWORD ?? '';`,
    `  const http = createServer((req, res) => {`,
    `    if ((req.headers.authorization ?? '') !== ('Basic ' + Buffer.from('opencode:' + pass).toString('base64'))) {`,
    `      res.writeHead(401); res.end(); return;`,
    `    }`,
    `    res.writeHead(200, { 'content-type': 'application/json' });`,
    `    res.end(JSON.stringify({ status: 'ok' }));`,
    `  });`,
    `  http.listen(0, '127.0.0.1', () => {`,
    `    // Real-binary ready dialect; exercises the plaintext parser branch.`,
    `    process.stdout.write('opencode server listening on http://127.0.0.1:' + http.address().port + '\\n');`,
    `  });`,
    `}`,
    '',
  ].join('\n'));

  const adapter = serverMod.createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [serveFixture],
    stateDir,
  });

  const started = await adapter.startRuntimeServer({ workspace, bindingId: 'worker_grp', fenceEpoch: 1 });
  const receipt = await adapter.stopServer(started.runtime);
  assert.equal(receipt.disposition, 'stopped');

  // The grandchild joined the server's detached group; a pid-only kill would
  // leave it behind exactly like the orphaned-server incident class.
  await assertPidDies(t, kidFile, 'server grandchild');
});

test('owned-process close escalates SIGTERM to SIGKILL at group level', { timeout: 10_000 }, async (t) => {
  const op = await import('../src/orchestration/adapters/owned-process.mjs');
  const stateDir = covTemp(t, 'close-ladder');
  const ignoreTermFixture = join(stateDir, 'ignore-term.mjs');
  writeFileSync(
    ignoreTermFixture,
    "process.on('SIGTERM', () => {});\n" +
      "process.on('SIGINT', () => {});\n" +
      'setInterval(() => {}, 500);\n',
  );

  const adapter = op.createOwnedProcessAdapter({ stateDir, signalGraceMs: 150 });
  const spawned = await adapter.spawn({
    task: { taskId: 'task_close', workspace: '/tmp' },
    dispatch: { dispatchId: 'disp_close', bindingId: 'worker_close' },
    command: process.execPath,
    args: [ignoreTermFixture],
    env: {},
    emit: () => {},
  });
  await new Promise((resolveTick) => setTimeout(resolveTick, 200));

  const closed = await adapter.close({ binding: spawned.binding });
  assert.equal(closed.ok, true);
  assert.deepEqual(closed.signalsAttempted, ['SIGTERM', 'SIGKILL']);
  assert.equal(closed.disposition, 'group-stopped');

  await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  let alive = true;
  try {
    process.kill(spawned.binding.processIdentity.pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, 'closed worker must not survive its own close ladder');
});

/* ---- coverage hardening batch: authority / store / retention / identity ---- */

test('authority seams fail closed on missing, duplicate and malformed state', async (t) => {
  const authority = await import('../src/orchestration/authority.mjs');

  assert.throws(
    () => authority.readClientCapability(fixture(t, 'auth-missing')),
    (e) => e.code === 'COORDINATION_NOT_FOUND',
  );
  assert.throws(
    () => authority.readAuthorityRecord(fixture(t, 'auth-record')),
    (e) => e.code === 'COORDINATION_NOT_FOUND',
  );

  const { layout: provisioned } = seedStore(t, 'auth-provision');
  const first = authority.createAuthority(provisioned);
  assert.match(first.token, /^[0-9a-f]{64}$/);
  assert.throws(() => authority.createAuthority(provisioned), (e) => e.code === 'ORCHESTRATION_INVALID_INPUT');

  const { layout: brokenCap } = seedStore(t, 'auth-broken');
  writeFileSync(join(brokenCap.coordinationDir, 'client.cap'), '{broken', 'utf8');
  assert.throws(() => authority.readClientCapability(brokenCap), (e) => e.code === 'JOURNAL_CORRUPT');

  const { layout: transferLayout, store: transferStore } = seedStore(t, 'auth-transfer');
  authority.createAuthority(transferLayout);
  assert.throws(
    () => authority.transferAuthority(transferStore, 'not-an-object'),
    (e) => e.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  assert.throws(
    () => authority.transferAuthority(transferStore, { host: 'h', rogue: 'field' }),
    (e) => e.code === 'ORCHESTRATION_INVALID_INPUT',
  );
  const receipt = authority.transferAuthority(transferStore, { host: 'local', instanceId: 'i1' });
  assert.equal(receipt.fenceEpoch, 2, 'transfer advances the fence epoch');
});

test('store fails closed on missing, corrupt or foreign manifests and bad drafts', async (t) => {
  const missingManifest = fixture(t, 'mf-missing');
  rmSync(missingManifest.manifestPath, { force: true });
  assert.throws(() => openCoordinationStore(missingManifest), (e) => e.code === 'COORDINATION_NOT_FOUND');

  const corruptManifest = fixture(t, 'mf-corrupt');
  writeFileSync(corruptManifest.manifestPath, '{definitely not json');
  assert.throws(() => openCoordinationStore(corruptManifest), (e) => e.code === 'SNAPSHOT_CORRUPT');

  const foreignManifest = fixture(t, 'mf-foreign');
  writeFileSync(foreignManifest.manifestPath, `${JSON.stringify({ schema: 'someone.else/v9' })}\n`);
  assert.throws(() => openCoordinationStore(foreignManifest), (e) => e.code === 'ORCHESTRATION_UNSUPPORTED_VERSION');

  const { store } = seedStore(t, 'draft-guard');
  assert.throws(() => commitDelivery(store, {}), (e) => e.code === 'ORCHESTRATION_INVALID_INPUT');
  const waiters = [];
  const { delivery } = commitDelivery(store, { type: 'heartbeat', payload: {} }, { waiters });
  assert.equal(delivery.sequence > 0, true);
});

test('retention retains young active states and prunes absent targets without signalling', async (t) => {
  const young = evaluateRetention(
    { coordinationState: 'open', updatedAt: new Date(Date.now() - 1_000).toISOString() },
    Date.now(),
    { ownedWorkerLive: false },
  );
  assert.equal(young.action, 'retain');
  assert.equal(young.reason, 'not-abandon-eligible-yet');

  const absentRoot = covTemp(t, 'absent');
  const absentLayout = {
    coordinationDir: join(absentRoot, 'coord-gone'),
    refsDir: join(absentRoot, 'refs-gone'),
  };
  const closedPrune = await pruneCoordination(absentLayout, { action: 'delete-closed-state', maySignalWorkers: false });
  assert.equal(closedPrune.reason, 'already-absent');
  const refsPrune = await pruneCoordination(absentLayout, { action: 'delete-large-refs', maySignalWorkers: false });
  assert.equal(refsPrune.reason, 'already-absent');
  const skipped = await pruneCoordination(absentLayout, { action: 'retain', reason: 'window-open', maySignalWorkers: false });
  assert.equal(skipped.action, 'skipped');
  assert.deepEqual(skipped.pruned, []);
});

test('process group probes resolve for live pids and fail safe after exit', async (t) => {
  const { spawn } = await import('node:child_process');
  const identity = await import('../src/orchestration/process-identity.mjs');
  const deps = identity.createPlatformIdentityDeps();

  // The bounded ps probe can starve under full-suite load; retry before
  // concluding the resolver itself is broken.
  let livePgid = null;
  for (let attempt = 0; attempt < 5 && livePgid === null; attempt += 1) {
    livePgid = await deps.getProcessGroupId(process.pid);
    if (livePgid === null) await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
  assert.equal(Number.isFinite(livePgid), true, 'self probe resolves a numeric pgid');

  const ephemeral = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((resolveExit) => ephemeral.once('exit', resolveExit));
  await new Promise((resolveTick) => setTimeout(resolveTick, 120));
  const deadPgid = await deps.getProcessGroupId(ephemeral.pid);
  assert.equal(deadPgid, null, 'exited pid probes fail safe to null');
});

/* ---- coverage hardening batch: raw IPC transport contracts ---- */

function rawConversation(endpoint, frames, { waitMs = 400 } = {}) {
  return new Promise((resolveRaw) => {
    const socket = net.connect(endpoint);
    let text = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolveRaw(text);
    }, waitMs);
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    socket.on('connect', () => {
      for (const frame of frames) socket.write(frame);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolveRaw(text);
    });
    socket.on('error', () => {});
  });
}

test('ipc transport enforces one request per connection and bounded invalid frames', { timeout: 10_000 }, async (t) => {
  const ipc = await import('../src/orchestration/ipc.mjs');
  const dir = covTemp(t, 'ipc-raw');
  const endpoint = join(dir, 'raw.sock');
  const server = await ipc.createIpcServer({
    endpoint,
    capability: 'cap-token',
    handler: async () => ({ ok: true, result: { echoed: true } }),
  });
  t.after(() => server.close());

  // A second frame on an already-answered connection is destroyed silently.
  const validFrame = `${JSON.stringify({ protocol: 'webmcp.ai-orchestration/v0', requestId: 'r1', operation: 'noop', capability: 'cap-token' })}\n`;
  const twoFrames = await rawConversation(endpoint, [validFrame, validFrame]);
  assert.equal((twoFrames.match(/"ok":true/g) ?? []).length, 1, 'exactly the first frame is answered');

  // An oversized frame with non-JSON content still yields a typed error.
  const oversized = await rawConversation(endpoint, [`"${'x'.repeat(1024 * 1024 + 32)}`], { waitMs: 600 });
  assert.match(oversized, /exceeds/);
});

async function startPlainServerHelper(t, onConnection) {
  const dir = covTemp(t, 'plain');
  const endpoint = join(dir, `plain-${Math.random().toString(36).slice(2, 8)}.sock`);
  // Discard inbound frames: an unread unix socket never observes the peer's
  // destroy as a close event, which would wedge server.close() forever.
  const server = net.createServer((socket) => {
    socket.resume();
    onConnection(socket);
  });
  await new Promise((resolveListen) => server.listen(endpoint, resolveListen));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolveClose) => server.close(() => resolveClose()));
  });
  return endpoint;
}

test('ipc client guards time out, bound responses and reject non-JSON frames', { timeout: 10_000 }, async (t) => {
  const ipc = await import('../src/orchestration/ipc.mjs');

  const silentEndpoint = await startPlainServerHelper(t, () => {});
  await assert.rejects(
    () => ipc.requestIpc(silentEndpoint, { ping: 1 }, { timeoutMs: 80 }),
    (e) => e.code === 'ORCHESTRATION_INDETERMINATE' && /timed out/.test(e.message),
  );

  const hugeEndpoint = await startPlainServerHelper(t, (socket) => {
    socket.end(`${'y'.repeat(1024 * 1024 + 64)}\n`);
  });
  await assert.rejects(
    () => ipc.requestIpc(hugeEndpoint, { ping: 1 }),
    (e) => e.code === 'PROVIDER_PROTOCOL_ERROR' && /frame exceeded/.test(e.message),
  );

  const garbageEndpoint = await startPlainServerHelper(t, (socket) => {
    socket.end('definitely-not-json\n');
  });
  await assert.rejects(
    () => ipc.requestIpc(garbageEndpoint, { ping: 1 }),
    (e) => e.code === 'PROVIDER_PROTOCOL_ERROR' && /not valid JSON/.test(e.message),
  );
});

/* ---- coverage hardening batch: supervisor authority boundaries ---- */

function layoutFor(stateDir, coordinationId) {
  const coordinationDir = join(stateDir, 'coordinations', coordinationId);
  return {
    coordinationDir,
    manifestPath: join(coordinationDir, 'manifest.json'),
    journalPath: join(coordinationDir, 'events.jsonl'),
    snapshotPath: join(coordinationDir, 'snapshot.json'),
    refsDir: join(coordinationDir, 'refs'),
    lockPath: join(coordinationDir, 'supervisor.lock'),
  };
}

test('the kill switch blocks supervisor mutations while read-only verbs survive', { timeout: 20_000 }, async (t) => {
  const supMod = await import('../src/orchestration/supervisor.mjs');
  const ipcMod = await import('../src/orchestration/ipc.mjs');
  const authMod = await import('../src/orchestration/authority.mjs');
  const stateDir = covTemp(t, 'killswitch');

  const supervisor = await supMod.createSupervisor({
    env: { ...process.env, WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir, WEBMCP_AI_ORCHESTRATION_DISABLED: '1' },
  });
  t.after(() => supervisor.stop());

  const capability = authMod.readClientCapability(layoutFor(stateDir, supervisor.coordinationId));
  const envelope = (operation, input = {}) => ({
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: `req_ks_${operation}`,
    operation,
    input,
    fenceEpoch: supervisor.fenceEpoch,
    capability,
  });

  const blocked = await ipcMod.requestIpc(supervisor.endpoint, envelope('decision-gate.create'));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'ORCHESTRATION_DISABLED');

  const readOnly = await ipcMod.requestIpc(supervisor.endpoint, envelope('coordination.inspect'));
  assert.equal(readOnly.ok, true, 'read-only inspection survives the kill switch');
});

test('recover-mode supervision tolerates corrupt sidecars, stale sockets and unreadable locks', { timeout: 20_000 }, async (t) => {
  const supMod = await import('../src/orchestration/supervisor.mjs');
  const authMod = await import('../src/orchestration/authority.mjs');
  const stateDir = covTemp(t, 'recsup');

  await assert.rejects(
    () => supMod.createSupervisor({ mode: 'recover', coordinationId: 'coord_absent_cov', env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } }),
    (e) => e.code === 'COORDINATION_NOT_FOUND',
  );

  const coordinationId = 'coord_recover_cov';
  const layout = layoutFor(stateDir, coordinationId);
  mkdirSync(layout.coordinationDir, { recursive: true, mode: 0o700 });
  mkdirSync(layout.refsDir, { recursive: true, mode: 0o700 });
  writeFileSync(layout.manifestPath, `${JSON.stringify({
    schema: 'webmcp.ai-orchestration-manifest/v0',
    coordinationId,
    fenceEpoch: 1,
    processGeneration: 1,
    createdAt: new Date().toISOString(),
    owner: null,
  })}\n`);
  authMod.createAuthority(layout);

  mkdirSync(join(layout.coordinationDir, 'tasks'), { recursive: true, mode: 0o700 });
  writeFileSync(join(layout.coordinationDir, 'tasks', 'broken.json'), '{corrupt sidecar');
  writeFileSync(join(layout.coordinationDir, 'tasks', 'notes.txt'), 'never parsed');
  writeFileSync(layout.lockPath, '{{unreadable lock json');

  const ipcRoot = join(stateDir, 'ipc');
  mkdirSync(ipcRoot, { recursive: true, mode: 0o700 });
  const endpoint = deriveEndpoint({ ipcRoot, coordinationId });
  writeFileSync(endpoint, 'stale socket inode');

  const supervisor = await supMod.createSupervisor({
    mode: 'recover',
    coordinationId,
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
  });
  t.after(() => supervisor.stop());
  // Listening on the same path proves the stale inode was removed first.
  const ipcProbe = await import('../src/orchestration/ipc.mjs');
  const inspected = await ipcProbe.requestIpc(supervisor.endpoint, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_recover_inspect',
    operation: 'coordination.inspect',
    input: {},
    fenceEpoch: supervisor.fenceEpoch,
    capability: authMod.readClientCapability(layout),
  });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.result.coordinationState, 'open');
  assert.equal(supervisor.processGeneration, 2, 'generation advances past an unreadable prior lock');
});

test('supervisor operation table enforces lifecycle transitions and closure semantics', { timeout: 40_000 }, async (t) => {
  const client = createOrchestrationClient({
    env: { ...process.env, WEBMCP_AI_ORCHESTRATION_STATE_DIR: covTemp(t, 'opstable') },
  });
  t.after(() => client.dispose());
  const created = await client.create({ protocol: 'webmcp.ai-orchestration/v0', requestId: 'req_ops_c' });
  const coordinationId = created.coordinationId;
  const call = (operation, input = {}, requestId = `req_ops_${operation}_${Math.random().toString(36).slice(2, 6)}`) =>
    client.call(coordinationId, { protocol: 'webmcp.ai-orchestration/v0', requestId, operation, input });

  const task = await call('task.create', { packet: { objective: 'Ops table work', workspace: '/tmp/ws' } });
  assert.match(task.result.taskId, /^task_/);
  const taskId = task.result.taskId;

  const gate = await call('decision-gate.create', { taskId });
  assert.match(gate.result.gateId, /^gate_/);
  const gateId = gate.result.gateId;

  // An open decision gate blocks dispatch even for an otherwise ready task.
  const blocked = await call('dispatch.start', { taskId });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'DECISION_GATE_BLOCKING');

  const receipt = { verdict: 'allow' };
  const resolved = await call('decision-gate.resolve', { gateId, receipt });
  assert.equal(resolved.ok, true);
  const replay = await call('decision-gate.resolve', { gateId, receipt });
  assert.equal(replay.result.idempotent, true, 'identical receipts replay idempotently');
  const conflict = await call('decision-gate.resolve', { gateId, receipt: { verdict: 'deny' } });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'ORCHESTRATION_INVALID_INPUT');
  const unknownGate = await call('decision-gate.resolve', { gateId: 'gate_missing', receipt });
  assert.equal(unknownGate.error.code, 'DECISION_GATE_NOT_FOUND');

  const dispatched = await call('dispatch.start', { taskId });
  assert.equal(dispatched.ok, false);
  assert.equal(dispatched.error.code, 'UNSUPPORTED_CAPABILITY', 'empty registry fails closed at the adapter boundary');

  const cancelMissing = await call('task.cancel', { taskId: 'task_missing' });
  assert.equal(cancelMissing.error.code, 'TASK_NOT_FOUND');
  const cancelled = await call('task.cancel', { taskId, reason: 'ops-table-test' });
  assert.equal(cancelled.result.cancelled, true);
  const redispatch = await call('dispatch.start', { taskId });
  assert.equal(redispatch.error.code, 'ORCHESTRATION_INVALID_INPUT', 'cancelled tasks are not dispatchable');

  // The client validates cursors locally; only the raw envelope seam reaches
  // the supervisor's own negative-afterSequence guard.
  const badCursor = await client.__callRawEnvelope(coordinationId, {
    requestId: 'req_ops_badcursor',
    operation: 'delivery.wait',
    input: { afterSequence: -1, timeoutMs: 10 },
  });
  assert.equal(badCursor.ok, false);
  assert.equal(badCursor.error.code, 'ORCHESTRATION_INVALID_INPUT');

  const closed = await call('coordination.close');
  assert.equal(closed.result.closed, true);
  const afterClose = await call('task.create', { packet: { objective: 'Late work', workspace: '/tmp/ws' } });
  assert.equal(afterClose.ok, false);
  assert.equal(afterClose.error.code, 'COORDINATION_CLOSED');
  const readOnlyAfterClose = await call('coordination.inspect');
  assert.equal(readOnlyAfterClose.ok, true, 'inspection remains available after closure');
});

/* ---- coverage hardening batch: opencode-server adapter negatives ---- */

test('opencode-server adapter surfaces typed negatives and honest probe reports', { timeout: 20_000 }, async (t) => {
  const serverMod = await require_ocserver();
  const stateDir = covTemp(t, 'oc-negatives');
  const adapter = serverMod.createOpenCodeServerAdapter({ stateDir });

  assert.throws(
    () => serverMod.resolveOpencodeDataRoot({ platform: 'sunos' }),
    (e) => e.code === 'ORCHESTRATION_UNSUPPORTED_VERSION',
  );

  await assert.rejects(() => adapter.close({ binding: {} }), (e) => e.code === 'WORKER_IDENTITY_UNPROVEN');
  assert.throws(() => adapter.respondPermission('mystery-target', 'perm_x', 'allow'), (e) => e.code === 'ORCHESTRATION_INVALID_INPUT');
  // A raw runtime handle unwraps to a runtime-owned binding; the HTTP call then
  // fails against the closed port, proving the unwrap path itself.
  await assert.rejects(() =>
    Promise.resolve().then(() => adapter.deleteSession({ endpoint: 'http://127.0.0.1:1', authToken: 'x', __sessionId: 'ses_raw' })));

  const runtimeDb = join(stateDir, 'webmcp-ai-runtime', 'worker_rel', 'opencode.db');
  const runtimeLike = { dbPath: runtimeDb, databaseIdentity: 'digest', __serverChild: null };
  await assert.rejects(
    () => adapter.stopServer(runtimeLike, { release: true }),
    (e) => e.code === 'POLICY_DENIED' && /settlement/.test(e.message),
  );
  const guarded = serverMod.createOpenCodeServerAdapter({ stateDir: covTemp(t, 'oc-guarded'), protectedPathsForTest: [runtimeDb] });
  await assert.rejects(
    () => guarded.stopServer(runtimeLike, { release: true, settled: true }),
    (e) => e.code === 'POLICY_DENIED' && /outside the runtime-owned tree/.test(e.message),
  );
  const released = await adapter.stopServer(runtimeLike, { release: true, settled: true });
  assert.equal(released.released, true);
  assert.equal(released.retained, false);
  assert.equal(released.disposition, 'already-exited');

  const versionFixture = join(covTemp(t, 'oc-version'), 'version.mjs');
  writeFileSync(versionFixture, "console.log('1.18.21');\n");
  const probing = serverMod.createOpenCodeServerAdapter({
    stateDir: covTemp(t, 'oc-probe'),
    openCodeBin: process.execPath,
    openCodeArgs: [versionFixture],
  });
  const report = await probing.probe({ env: { PATH: process.env.PATH, HOME: '/home/u' } });
  assert.equal(report.installedVersion, '1.18.21');
  assert.equal(report.available, true);
  assert.equal(report.sdkVersion, '1.18.21');
  assert.equal(report.maturity, 'fixture-only');
  assert.equal(Object.keys(report.capabilities).length, 11);
});

test('a missing opencode binary fails preflight without spawning any server', { timeout: 10_000 }, async (t) => {
  const serverMod = await require_ocserver();
  const adapter = serverMod.createOpenCodeServerAdapter({
    stateDir: covTemp(t, 'oc-enoent'),
    openCodeBin: '/nonexistent/webmcp-oc-binary',
  });
  await assert.rejects(
    () => adapter.startRuntimeServer({ workspace: '/tmp', bindingId: 'worker_enoent', fenceEpoch: 1 }),
    (error) => error?.code === 'ENOENT',
  );
});
