import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createIpcServer, deriveEndpoint, requestIpc } from '../src/orchestration/ipc.mjs';
import {
  createOrchestrationClient,
  getOrchestrationCapabilities,
} from '../src/orchestration/client.mjs';

function tempStateDir(t, name = 'sup') {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-t4-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeClient(t, name, existingStateDir) {
  const stateDir = existingStateDir ?? tempStateDir(t, name);
  const client = createOrchestrationClient({
    env: { ...process.env, WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
  });
  return { client, stateDir };
}

async function startedCoordination(t, name) {
  const { client, stateDir } = makeClient(t, name);
  const created = await client.create({
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_create',
    owner: { host: 'test-host', instanceId: 'inst-1' },
  });
  assert.equal(created.ok, true);
  t.after(() => client.dispose());
  return { client, stateDir, coordinationId: created.coordinationId };
}

test('IPC accepts one authenticated request and never echoes the capability', async (t) => {
  const { client, coordinationId } = await startedCoordination(t, 'auth');
  const response = await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_inspect',
    operation: 'coordination.inspect',
    input: {},
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.coordinationId, coordinationId);
  assert.equal(JSON.stringify(response).includes(client.__capabilityFor(coordinationId)), false);
});

test('wrong capability, oversized frames and multi-request connections fail closed', async (t) => {
  const { client, coordinationId } = await startedCoordination(t, 'failclosed');
  const goodToken = client.__capabilityFor(coordinationId);

  // A same-length wrong token is rejected by constant-time comparison.
  // Flip the final hex digit unconditionally: substituting a fixed character
  // collides with the real token one time in sixteen.
  const flippedToken = `${goodToken.slice(0, -1)}${goodToken.slice(-1) === '0' ? '1' : '0'}`;
  const wrong = await client.__callRawEnvelope(coordinationId, {
    requestId: 'req_wrong',
    operation: 'coordination.inspect',
    input: {},
    capability: flippedToken,
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, 'WORKER_IDENTITY_UNPROVEN');
  assert.equal(JSON.stringify(wrong).includes(goodToken), false);

  // A frame over the 1 MiB request bound is rejected without processing.
  const huge = 'x'.repeat(1024 * 1024 + 64);
  const oversized = await requestIpc(
    client.__endpointFor(coordinationId),
    { junk: huge },
    { timeoutMs: 2000 },
  );
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, 'ORCHESTRATION_INVALID_INPUT');
  assert.match(oversized.error.message, /frame exceeds/);

  // Two JSON requests on one connection: the second is never answered.
  const socket = await import('node:net');
  const twoResponses = await new Promise((resolvePromise) => {
    const conn = socket.connect(client.__endpointFor(coordinationId));
    const chunks = [];
    conn.on('connect', () => {
      conn.write(`${JSON.stringify({
        protocol: 'webmcp.ai-orchestration/v0',
        requestId: 'req_one',
        coordinationId,
        operation: 'coordination.inspect',
        input: {},
        capability: goodToken,
        fenceEpoch: 1,
      })}\n`);
      conn.write(`${JSON.stringify({
        protocol: 'webmcp.ai-orchestration/v0',
        requestId: 'req_two',
        coordinationId,
        operation: 'coordination.inspect',
        input: {},
        capability: goodToken,
        fenceEpoch: 1,
      })}\n`);
    });
    conn.on('data', (chunk) => chunks.push(chunk));
    conn.on('close', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    setTimeout(() => {
      conn.destroy();
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    }, 1500).unref();
  });
  const responses = twoResponses.trim().split('\n').filter(Boolean);
  assert.equal(responses.length, 1, `expected exactly one response, got ${responses.length}`);
  assert.match(responses[0], /req_one/);

  // External TCP bind configuration never reaches the transport layer.
  assert.throws(
    () => createIpcServer({ host: '127.0.0.1', port: 4567, capability: 'x', handler: () => ({ ok: true }) }),
    (error) => error.code === 'POLICY_DENIED',
  );
});

test('cold reattach replays the journal under a new process generation', async (t) => {
  const { client, stateDir, coordinationId } = await startedCoordination(t, 'reattach');

  await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_task1',
    operation: 'task.create',
    input: { packet: {
      objective: 'Bounded work item',
      workspace: '/tmp/ws',
      allowedWriteRoots: ['/tmp/ws/src'],
    } },
  });
  const beforeStop = await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_inspect_pre',
    operation: 'coordination.inspect',
    input: {},
  });
  const lastSequenceBefore = beforeStop.result.lastSequence;

  // Terminate generation 1 the way a crash would leave it.
  await client.killSupervisor(coordinationId);

  // A second coordinator host reattaches through the same machine-local state.
  const { client: clientB } = makeClient(t, 'reattach-b', stateDir);
  const reattached = await clientB.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_reattach',
    operation: 'coordination.inspect',
    input: {},
  });

  assert.equal(reattached.ok, true, JSON.stringify(reattached));
  assert.equal(reattached.result.processGeneration, 2);
  assert.equal(reattached.result.lastSequence, lastSequenceBefore);
  assert.equal(Object.keys(reattached.result.tasks).length >= 1, true);
  await clientB.dispose();
});

test('gates block dispatch.start; resolving reaches the not-yet-built adapter boundary', async (t) => {
  const { client, coordinationId } = await startedCoordination(t, 'gate');

  const task = await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_gate_task',
    operation: 'task.create',
    input: { packet: { objective: 'Gated work', workspace: '/tmp/ws' } },
  });
  const taskId = task.result.taskId;

  await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_gate_open',
    operation: 'decision-gate.create',
    input: { taskId },
  });

  const blocked = await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_dispatch_blocked',
    operation: 'dispatch.start',
    input: { taskId },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'DECISION_GATE_BLOCKING');

  const inspected = await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_gate_list',
    operation: 'coordination.inspect',
    input: {},
  });
  const openGateId = Object.keys(inspected.result.gates)
    .find((id) => inspected.result.gates[id].state === 'open');

  const gateResolved = await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_gate_resolve',
    operation: 'decision-gate.resolve',
    input: { gateId: openGateId, receipt: { decidedBy: 'coordinator', note: 'approved' } },
  });
  assert.equal(gateResolved.ok, true, JSON.stringify(gateResolved));

  // Gate cleared: the request now reaches the adapter boundary, which is not
  // built yet in Task 4 — UNSUPPORTED_CAPABILITY, never another gate error.
  const dispatched = await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_dispatch_ok',
    operation: 'dispatch.start',
    input: { taskId },
  });
  assert.equal(dispatched.ok, false);
  assert.equal(dispatched.error.code, 'UNSUPPORTED_CAPABILITY');

  // Idempotent cancel; conflicting second gate resolution fails without
  // rewriting the first receipt.
  const cancelOne = await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_cancel1',
    operation: 'task.cancel',
    input: { taskId, reason: 'obsolete' },
  });
  assert.equal(cancelOne.ok, true);
  const cancelTwo = await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_cancel2',
    operation: 'task.cancel',
    input: { taskId, reason: 'obsolete' },
  });
  assert.equal(cancelTwo.ok, true, JSON.stringify(cancelTwo));

  const conflict = await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_gate_conflict',
    operation: 'decision-gate.resolve',
    input: { gateId: openGateId, receipt: { decidedBy: 'coordinator', note: 'changed-my-mind' } },
  });
  assert.equal(conflict.ok, false);
});

test('delivery wait returns ordered batches and ack advances the durable watermark', async (t) => {
  const { client, coordinationId } = await startedCoordination(t, 'wait');

  await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_w_task',
    operation: 'task.create',
    input: { packet: { objective: 'Wait target', workspace: '/tmp/ws' } },
  });

  const waited = await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_wait',
    operation: 'delivery.wait',
    input: { afterSequence: 1, timeoutMs: 2000 },
  });
  assert.equal(waited.ok, true);
  const sequences = waited.result.deliveries.map((delivery) => delivery.sequence);
  assert.equal(sequences.length >= 1, true);
  assert.deepEqual([...sequences].sort((a, b) => a - b), sequences, 'ordered batch');
  const last = waited.result.lastSequence;

  const acked = await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_ack',
    operation: 'delivery.ack',
    input: { throughSequence: last },
  });
  assert.equal(acked.ok, true);
  assert.equal(acked.result.acknowledgedThrough, last);

  const timedOut = await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_wait_timeout',
    operation: 'delivery.wait',
    input: { afterSequence: last, timeoutMs: 300 },
  });
  assert.equal(timedOut.ok, true);
  assert.equal(timedOut.result.timedOut, true);
});

test('stale epochs cannot mutate after a planned transfer', async (t) => {
  const { client, coordinationId } = await startedCoordination(t, 'transfer');

  const transferred = await client.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_transfer',
    operation: 'coordination.transfer',
    input: { owner: { host: 'claude', instanceId: 'host-b' } },
  });
  assert.equal(transferred.ok, true, JSON.stringify(transferred));
  assert.equal(transferred.result.fenceEpoch, 2);
  assert.equal(JSON.stringify(transferred).includes(client.__capabilityFor(coordinationId)), false);

  const stale = await client.__callRawEnvelope(coordinationId, {
    requestId: 'req_stale_mutate',
    operation: 'task.create',
    input: { packet: { objective: 'x', workspace: '/tmp/ws' } },
    fenceEpochOverride: 1,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'STALE_COORDINATOR_EPOCH');
});

test('capabilities report protocol, limits, maturity honesty and the kill switch', async (t) => {
  const enabled = await getOrchestrationCapabilities({ env: {} });
  assert.equal(enabled.protocol, 'webmcp.ai-orchestration/v0');
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.limits.maxWaitMs, 60_000);
  assert.equal(enabled.adapters.length, 0, 'no adapter is advertised before Task 5');

  const disabled = await getOrchestrationCapabilities({
    env: { WEBMCP_AI_ORCHESTRATION_DISABLED: '1' },
  });
  assert.equal(disabled.enabled, false);
});

test('coordinator portability: host labels are opaque metadata across cold reattach', async (t) => {
  // A Codex-labelled coordinator creates the Coordination and its work.
  const { client: codexClient, stateDir } = makeClient(t, 'portable-codex');
  const created = await codexClient.create({
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_port_create',
    owner: { host: 'codex', instanceId: 'codex-a' },
  });
  const coordinationId = created.coordinationId;

  await codexClient.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_port_task',
    operation: 'task.create',
    input: { packet: { objective: 'Portable work item', workspace: '/tmp/ws' } },
  });
  await codexClient.killSupervisor(coordinationId);

  // A Claude-labelled coordinator reattaches with the SAME explicit id and
  // observes identical state; no provider-name special case exists anywhere.
  const { client: claudeClient } = makeClient(t, 'portable-claude', stateDir);
  const reattached = await claudeClient.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_port_reattach',
    operation: 'coordination.inspect',
    input: {},
  });
  assert.equal(reattached.ok, true, JSON.stringify(reattached));
  assert.equal(reattached.result.processGeneration, 2);
  assert.equal(Object.keys(reattached.result.tasks).length, 1);

  // Ordered Delivery resumes from the durable journal without duplication.
  const waited = await claudeClient.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_port_wait',
    operation: 'delivery.wait',
    input: { afterSequence: 0, timeoutMs: 2000 },
  });
  const sequences = waited.result.deliveries.map((entry) => entry.sequence);
  assert.deepEqual([...sequences].sort((a, b) => a - b), sequences);
  assert.equal(new Set(sequences).size, sequences.length, 'at-least-once replay stays duplicate-free per sequence');

  await claudeClient.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_port_ack',
    operation: 'delivery.ack',
    input: { throughSequence: waited.result.lastSequence },
  });

  // Planned transfer increments the epoch; the old coordinator is fenced.
  await claudeClient.call(coordinationId, {
    protocol: 'webmcp.ai-orchestration/v0',
    requestId: 'req_port_transfer',
    operation: 'coordination.transfer',
    input: { owner: { host: 'claude', instanceId: 'claude-b' } },
  });
  const stale = await codexClient.__callRawEnvelope(coordinationId, {
    requestId: 'req_port_stale',
    operation: 'task.create',
    input: { packet: { objective: 'x', workspace: '/tmp/ws' } },
    fenceEpochOverride: 1,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'STALE_COORDINATOR_EPOCH');
  await claudeClient.dispose();
});
