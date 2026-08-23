import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { AiCliError } from '../errors.mjs';
import {
  createAuthority,
  readClientCapability,
  recoverAuthority,
  transferAuthority,
} from './authority.mjs';
import { writeAtomicJson } from './atomic-file.mjs';
import {
  MANIFEST_SCHEMA,
  OPERATIONS,
  ORCHESTRATION_LIMITS,
  ORCHESTRATION_PROTOCOL,
} from './constants.mjs';
import { validateTaskPacket } from './contracts.mjs';
import { replayJournal } from './journal.mjs';
import { createIpcServer, deriveEndpoint } from './ipc.mjs';
import {
  createCoordinationLayout,
  ensureOrchestrationRoots,
  resolveOrchestrationRoots,
} from './paths.mjs';
import { acquireSupervisorLock, releaseSupervisorLock } from './lock.mjs';
import { createPlatformIdentityDeps } from './process-identity.mjs';
import { commitDelivery, openCoordinationStore, persistAck } from './store.mjs';

const READ_ONLY_OPERATIONS = new Set(['coordination.inspect', 'delivery.wait']);

function unsupportedAdapterBoundary(operation) {
  return new AiCliError(
    'UNSUPPORTED_CAPABILITY',
    `operation ${operation} reaches the adapter boundary, which no adapter provides yet`,
    { exitCode: 2 },
  );
}

async function buildSupervisorIdentity(processGeneration) {
  const deps = createPlatformIdentityDeps();
  let startIdentity = null;
  try {
    startIdentity = await deps.getStartIdentity(process.pid);
  } catch {
    startIdentity = null;
  }
  return {
    pid: process.pid,
    // An indeterminate probe still allows local supervision but this value
    // never authorizes signalling decisions anywhere else.
    startIdentity: startIdentity ?? `${process.platform}:indeterminate-${process.pid}`,
    processGroupId: process.pid,
    processGeneration,
    runtimeNonce: `nonce_${randomUUID()}`,
  };
}

function loadTaskPackets(layout) {
  const packetsDir = join(layout.coordinationDir, 'tasks');
  const packets = new Map();
  if (!existsSync(packetsDir)) return packets;
  for (const name of readdirSync(packetsDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(readFileSync(join(packetsDir, name), 'utf8'));
      packets.set(record.taskId, record.packet);
    } catch {
      // A corrupt optional sidecar never blocks lifecycle recovery.
    }
  }
  return packets;
}

function recoverLayout(roots, coordinationId) {
  const coordinationDir = join(roots.stateRoot, 'coordinations', coordinationId);
  if (!existsSync(join(coordinationDir, 'manifest.json'))) {
    throw new AiCliError('COORDINATION_NOT_FOUND', `no coordination ${coordinationId}`);
  }
  return Object.freeze({
    coordinationDir,
    manifestPath: join(coordinationDir, 'manifest.json'),
    journalPath: join(coordinationDir, 'events.jsonl'),
    snapshotPath: join(coordinationDir, 'snapshot.json'),
    refsDir: join(coordinationDir, 'refs'),
    lockPath: join(coordinationDir, 'supervisor.lock'),
  });
}

/**
 * Single-writer supervisor: owns the lock, replays the journal, serves the
 * frozen operation table over authenticated local IPC.
 */
export async function createSupervisor(options = {}) {
  const {
    env = {},
    coordinationId = `coord_${randomUUID()}`,
    manifest = {},
  } = options;
  const freshCreate = options.mode ? options.mode === 'create' : true;

  const roots = resolveOrchestrationRoots({ env });
  ensureOrchestrationRoots(roots);
  mkdirSync(roots.ipcRoot, { recursive: true, mode: 0o700 });

  const layout = freshCreate
    ? createCoordinationLayout(roots.stateRoot, coordinationId)
    : recoverLayout(roots, coordinationId);

  let store;
  let capabilityToken;
  if (freshCreate) {
    const authority = createAuthority(layout);
    capabilityToken = authority.token;
    writeAtomicJson(layout.manifestPath, {
      schema: MANIFEST_SCHEMA,
      coordinationId,
      fenceEpoch: 1,
      processGeneration: 1,
      createdAt: new Date().toISOString(),
      owner: manifest.owner ?? null,
    });
    store = openCoordinationStore(layout);
    commitDelivery(store, { type: 'coordination_created', payload: { owner: manifest.owner ?? null } });
  } else {
    // Settle authority crash windows before anything trusts client.cap.
    const priorSnapshot = existsSync(layout.snapshotPath)
      ? JSON.parse(readFileSync(layout.snapshotPath, 'utf8'))
      : null;
    recoverAuthority(layout, priorSnapshot);
    capabilityToken = readClientCapability(layout);
    store = openCoordinationStore(layout);
  }

  const journal = replayJournal(layout).deliveries.slice();
  const taskPackets = loadTaskPackets(layout);

  // Process generation: 1 on create; previous + 1 after takeover/recovery.
  let previousGeneration = 0;
  if (!freshCreate && existsSync(layout.lockPath)) {
    try {
      previousGeneration
        = JSON.parse(readFileSync(layout.lockPath, 'utf8'))?.identity?.processGeneration ?? 0;
    } catch {
      previousGeneration = 0;
    }
  }
  const identity = await buildSupervisorIdentity(Math.max(previousGeneration + 1, freshCreate ? 1 : 2));
  const lock = await acquireSupervisorLock(layout, identity);

  const endpoint = deriveEndpoint({ ipcRoot: roots.ipcRoot, coordinationId, platform: process.platform });
  if (process.platform !== 'win32' && existsSync(endpoint)) {
    // The proven lock authorizes removing a stale socket inode.
    unlinkSync(endpoint);
  }

  function commit(draft) {
    const { delivery } = commitDelivery(store, draft);
    journal.push(delivery);
    return delivery;
  }

  function assertMutationAllowed(operation) {
    if (READ_ONLY_OPERATIONS.has(operation)) return;
    if (env.WEBMCP_AI_ORCHESTRATION_DISABLED === '1') {
      throw new AiCliError(
        'ORCHESTRATION_DISABLED',
        'orchestration is disabled by WEBMCP_AI_ORCHESTRATION_DISABLED',
      );
    }
    if (!['open'].includes(store.state.coordinationState)) {
      throw new AiCliError('COORDINATION_CLOSED', 'this coordination no longer accepts mutations');
    }
  }

  function openGatesFor(taskId) {
    return Object.values(store.state.gates).filter(
      (gate) => gate.state === 'open'
        && (gate.taskId === taskId || gate.dependsOnTaskId === taskId),
    );
  }

  async function waitForDeliveries(input) {
    const requested = Number.isInteger(input.timeoutMs) ? input.timeoutMs : 30_000;
    const timeoutMs = Math.max(1, Math.min(requested, ORCHESTRATION_LIMITS.maxWaitMs));
    const afterSequence = Number.isInteger(input.afterSequence) ? input.afterSequence : 0;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pending = journal.filter((entry) => entry.sequence > afterSequence);
      if (pending.length > 0 || store.state.coordinationState !== 'open') {
        return {
          deliveries: pending.slice(0, ORCHESTRATION_LIMITS.maxBatchDeliveries),
          lastSequence: store.state.lastSequence,
          acknowledgedThrough: store.state.acknowledgedThrough,
          timedOut: false,
        };
      }
      if (Date.now() >= deadline) {
        return {
          deliveries: [],
          lastSequence: store.state.lastSequence,
          acknowledgedThrough: store.state.acknowledgedThrough,
          timedOut: true,
        };
      }
      await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    }
  }

  const handlers = Object.freeze({
    'coordination.inspect': async () => ({
      coordinationId,
      fenceEpoch: store.state.fenceEpoch,
      processGeneration: identity.processGeneration,
      coordinationState: store.state.coordinationState,
      lastSequence: store.state.lastSequence,
      acknowledgedThrough: store.state.acknowledgedThrough,
      tasks: Object.fromEntries(
        Object.values(store.state.tasks).map((task) => [task.taskId, { state: task.state, acceptance: task.acceptance }]),
      ),
      gates: Object.fromEntries(
        Object.values(store.state.gates).map((gate) => [gate.gateId, { state: gate.state }]),
      ),
      dispatches: Object.fromEntries(
        Object.values(store.state.dispatches).map((dispatch) => [
          dispatch.dispatchId,
          { state: dispatch.state, terminalOutcome: dispatch.terminalOutcome },
        ]),
      ),
      escalations: store.state.escalations.length,
      stateRoot: roots.stateRoot,
    }),
    'coordination.transfer': async (input) => {
      const receipt = await transferAuthority(store, input.owner ?? null);
      capabilityToken = receipt.token;
      return {
        fenceEpoch: receipt.fenceEpoch,
        authorityRevisionId: receipt.authorityRevisionId,
        owner: receipt.owner,
      };
    },
    'coordination.close': async () => {
      commit({ type: 'coordination_state_changed', payload: { state: 'closing' } });
      commit({ type: 'coordination_state_changed', payload: { state: 'closed' } });
      return { closed: true };
    },
    'task.create': async (input, envelope) => {
      const packet = validateTaskPacket(input.packet ?? {});
      const taskId = `task_${randomUUID()}`;
      mkdirSync(join(layout.coordinationDir, 'tasks'), { recursive: true, mode: 0o700 });
      writeAtomicJson(join(layout.coordinationDir, 'tasks', `${taskId}.json`), { taskId, packet });
      taskPackets.set(taskId, packet);
      commit({ type: 'task_created', taskId, payload: { taskId }, time: undefined, actor: envelope.requestId });
      return { taskId };
    },
    'task.cancel': async (input, envelope) => {
      const taskId = input.taskId;
      if (!store.state.tasks[taskId]) {
        throw new AiCliError('TASK_NOT_FOUND', `no task ${taskId}`);
      }
      commit({
        type: 'task_state_changed',
        taskId,
        payload: { taskId, state: 'cancelled', reason: String(input.reason ?? ''), actor: envelope.requestId },
      });
      return {
        cancelled: true,
        interruptEffects: store.state.interruptEffects.filter((effect) => effect.taskId === taskId),
      };
    },
    'dispatch.start': async (input) => {
      const taskId = input.taskId;
      const task = store.state.tasks[taskId];
      if (!task) throw new AiCliError('TASK_NOT_FOUND', `no task ${taskId}`);
      if (!['created', 'ready'].includes(task.state)) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `task ${taskId} is not dispatchable from state ${task.state}`);
      }
      const gates = openGatesFor(taskId);
      if (gates.length > 0) {
        throw new AiCliError('DECISION_GATE_BLOCKING', `open decision gate ${gates[0].gateId} blocks this task`);
      }
      const packet = taskPackets.get(taskId);
      for (const dependencyId of packet?.dependencies ?? []) {
        if (store.state.tasks[dependencyId]?.state !== 'accepted') {
          throw new AiCliError('DECISION_GATE_BLOCKING', `unresolved dependency ${dependencyId} blocks this task`);
        }
      }
      // Adapter registry lands in Task 5; until then every mutable dispatch
      // fails closed at exactly this seam.
      throw unsupportedAdapterBoundary('dispatch.start');
    },
    'dispatch.reply': async () => { throw unsupportedAdapterBoundary('dispatch.reply'); },
    'dispatch.guidance': async () => { throw unsupportedAdapterBoundary('dispatch.guidance'); },
    'dispatch.permission.resolve': async () => { throw unsupportedAdapterBoundary('dispatch.permission.resolve'); },
    'dispatch.interrupt': async () => { throw unsupportedAdapterBoundary('dispatch.interrupt'); },
    'dispatch.verify': async () => { throw unsupportedAdapterBoundary('dispatch.verify'); },
    'decision-gate.create': async (input) => {
      const gateId = `gate_${randomUUID().slice(0, 8)}`;
      commit({
        type: 'decision_gate_created',
        payload: {
          gateId,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.dependsOnTaskId ? { dependsOnTaskId: input.dependsOnTaskId } : {}),
        },
      });
      return { gateId };
    },
    'decision-gate.resolve': async (input) => {
      const gate = store.state.gates[input.gateId];
      if (!gate) throw new AiCliError('DECISION_GATE_NOT_FOUND', `no decision gate ${input.gateId}`);
      if (gate.state === 'resolved') {
        const existingDigest = JSON.stringify(gate.resolution ?? null);
        const requestedDigest = JSON.stringify(input.receipt ?? null);
        if (existingDigest === requestedDigest) {
          return { gateId: gate.gateId, resolution: gate.resolution, idempotent: true };
        }
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          'conflicting decision-gate resolution; the first receipt stands',
        );
      }
      commit({ type: 'decision_gate_resolved', payload: { gateId: gate.gateId, receipt: input.receipt ?? null } });
      return { gateId: gate.gateId, resolution: store.state.gates[gate.gateId].resolution };
    },
    'delivery.wait': waitForDeliveries,
    'delivery.ack': async (input) => {
      persistAck(store, input.throughSequence);
      return { acknowledgedThrough: store.state.acknowledgedThrough };
    },
  });

  function handleEnvelope(envelope) {
    const respond = (payload) => ({
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: envelope.requestId ?? null,
      coordinationId,
      ...payload,
    });
    try {
      if (envelope.protocol !== ORCHESTRATION_PROTOCOL) {
        throw new AiCliError(
          'ORCHESTRATION_UNSUPPORTED_VERSION',
          `unsupported protocol ${String(envelope.protocol)}`,
          { exitCode: 2 },
        );
      }
      if (!OPERATIONS.includes(envelope.operation)) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `unknown orchestration operation: ${String(envelope.operation)}`, { exitCode: 2 });
      }
      const epoch = envelope.fenceEpoch;
      if (!Number.isInteger(epoch) || epoch !== store.state.fenceEpoch) {
        throw new AiCliError(
          'STALE_COORDINATOR_EPOCH',
          `Coordinator epoch ${JSON.stringify(epoch ?? null)} is stale; current epoch is ${store.state.fenceEpoch}`,
          { details: { currentEpoch: store.state.fenceEpoch } },
        );
      }
      assertMutationAllowed(envelope.operation);
      const handler = handlers[envelope.operation];
      return Promise.resolve()
        .then(() => handler(envelope.input ?? {}, envelope))
        .then((result) => respond({ ok: true, result }))
        .catch((error) => respond({
          ok: false,
          error: error instanceof AiCliError
            ? error.toJSON()
            : new AiCliError('ORCHESTRATION_INDETERMINATE', error?.message ?? 'handler failure').toJSON(),
        }));
    } catch (error) {
      return Promise.resolve(respond({
        ok: false,
        error: error instanceof AiCliError
          ? error.toJSON()
          : new AiCliError('ORCHESTRATION_INDETERMINATE', error?.message ?? 'ipc failure').toJSON(),
      }));
    }
  }

  const server = await createIpcServer({
    endpoint,
    capability: () => capabilityToken,
    handler: handleEnvelope,
    protocol: ORCHESTRATION_PROTOCOL,
  });

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    await server.close();
    try {
      await releaseSupervisorLock(lock, identity.runtimeNonce);
    } catch {
      // A failed release leaves the audit lock in place; recovery archives it.
    }
  }

  return {
    coordinationId,
    endpoint,
    fenceEpoch: store.state.fenceEpoch,
    processGeneration: identity.processGeneration,
    stop,
    __store: store,
  };
}
