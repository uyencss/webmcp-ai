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
  ID_PREFIXES,
  MANIFEST_SCHEMA,
  OPERATIONS,
  ORCHESTRATION_LIMITS,
  ORCHESTRATION_PROTOCOL,
} from './constants.mjs';
import { validateTaskPacket } from './contracts.mjs';
import { createAdapterRegistry } from './adapters/index.mjs';
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
import { verifyDispatch as defaultVerifyDispatch } from './verifier.mjs';

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

const GENERATION_SCHEMA = 'webmcp.ai-supervisor-generation/v0';
const BINDINGS_SCHEMA = 'webmcp.ai-supervisor-runtime-bindings/v0';
const BINDINGS_FILENAME = 'runtime-bindings.json';
const NONTERMINAL_DISPATCH_STATES = new Set(['created', 'assigned', 'active', 'waiting', 'settling']);

function generationPath(layout) {
  return join(layout.coordinationDir, 'generation.json');
}

function bindingsPathFor(layout) {
  return join(layout.coordinationDir, BINDINGS_FILENAME);
}

/**
 * Read-only peek at every durable generation source. The authoritative
 * increment happens only after the singleton lock is held.
 */
function readDurableGeneration(layout, manifestFallback = 0) {
  let candidate = Number.isInteger(manifestFallback) ? manifestFallback : 0;
  const consider = (value) => {
    if (Number.isInteger(value) && value > candidate) candidate = value;
  };
  try {
    if (existsSync(layout.lockPath)) {
      consider(JSON.parse(readFileSync(layout.lockPath, 'utf8'))?.identity?.processGeneration);
    }
  } catch {
    // Unreadable lock contributes nothing; the lock owner resolves it.
  }
  try {
    if (existsSync(generationPath(layout))) {
      consider(JSON.parse(readFileSync(generationPath(layout), 'utf8'))?.lastGeneration);
    }
  } catch {
    // Corrupt generation sidecar falls back to lock/manifest sources.
  }
  return candidate;
}

/** Persist the strictly-monotonic generation watermark atomically (under lock). */
function persistDurableGeneration(layout, generation) {
  writeAtomicJson(generationPath(layout), { schema: GENERATION_SCHEMA, lastGeneration: generation });
}

/**
 * Durable dispatch runtime bindings: adapter identity, trusted launch
 * binding and proven process/group identity for every live owned worker.
 * Mode-0600 machine-local; recovery reads it to reattach or reconcile.
 */
function loadRuntimeBindingRecords(layout) {
  const path = bindingsPathFor(layout);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.schema !== BINDINGS_SCHEMA || typeof parsed.bindings !== 'object' || parsed.bindings === null) {
      return {};
    }
    return parsed.bindings;
  } catch {
    // A corrupt sidecar never fabricates control proof; reconciliation fails
    // closed to the typed lost state instead.
    return {};
  }
}

function persistRuntimeBindingRecords(layout, bindingsMap) {
  const bindings = {};
  for (const [dispatchId, entry] of bindingsMap) bindings[dispatchId] = entry.record;
  writeAtomicJson(bindingsPathFor(layout), { schema: BINDINGS_SCHEMA, bindings });
}

function validateRuntimeBindingRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'runtime binding record must be an object', { exitCode: 2 });
  }
  if (typeof record.bindingId !== 'string' || !record.bindingId.startsWith(ID_PREFIXES.worker)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'runtime binding bindingId must use the worker_ prefix', { exitCode: 2 });
  }
  if (typeof record.adapterId !== 'string' || record.adapterId.length === 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'runtime binding adapterId must be a non-empty string', { exitCode: 2 });
  }
  if (typeof record.taskId !== 'string' || !record.taskId.startsWith(ID_PREFIXES.task)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'runtime binding taskId must use the task_ prefix', { exitCode: 2 });
  }
  const processIdentity = record.processIdentity ?? {};
  if (!Number.isInteger(processIdentity.pid) || processIdentity.pid <= 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'runtime binding requires a positive integer pid', { exitCode: 2 });
  }
  if (typeof processIdentity.startIdentity !== 'string' || processIdentity.startIdentity.length === 0) {
    throw new AiCliError(
      'ORCHESTRATION_INDETERMINATE',
      'runtime binding requires a proven startIdentity; indeterminate identity never authorizes control',
      { exitCode: 2 },
    );
  }
  if (!Number.isInteger(processIdentity.processGroupId) || processIdentity.processGroupId <= 1) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'runtime binding requires a valid process group id', { exitCode: 2 });
  }
  return record;
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
    adapters = [],
    verifyDispatch = null,
  } = options;
  const freshCreate = options.mode ? options.mode === 'create' : true;
  // The registry stays empty by default: adapter-backed dispatch fails closed
  // at the UNSUPPORTED_CAPABILITY boundary until a validated adapter is
  // explicitly provided to this supervisor.
  const registry = createAdapterRegistry(adapters);

  const roots = resolveOrchestrationRoots({ env });
  ensureOrchestrationRoots(roots);
  mkdirSync(roots.ipcRoot, { recursive: true, mode: 0o700 });

  const layout = freshCreate
    ? createCoordinationLayout(roots.stateRoot, coordinationId)
    : recoverLayout(roots, coordinationId);

  // Read-only generation peek BEFORE the gate; the authoritative increment is
  // persisted atomically under the lock below.
  let manifestGeneration = 0;
  try {
    manifestGeneration = JSON.parse(readFileSync(layout.manifestPath, 'utf8'))?.processGeneration ?? 0;
  } catch {
    manifestGeneration = 0;
  }
  const previousGeneration = readDurableGeneration(layout, manifestGeneration);
  const processGeneration = freshCreate ? 1 : previousGeneration + 1;
  const identity = await buildSupervisorIdentity(processGeneration);

  // Singleton gate FIRST: no mutable recovery, generation allocation,
  // endpoint publication or lifecycle reconciliation may run unowned.
  const lock = await acquireSupervisorLock(layout, identity);

  let store;
  let capabilityToken;
  let server = null;
  let endpoint = null;
  const runtimeBindings = new Map(); // dispatchId -> { record }
  let journal = [];
  const taskPackets = new Map();
  let commit = () => {
    throw new AiCliError('ORCHESTRATION_INDETERMINATE', 'supervisor commit path is not initialized');
  };

  try {
    persistDurableGeneration(layout, processGeneration);

    if (freshCreate) {
      const authority = createAuthority(layout);
      capabilityToken = authority.token;
      writeAtomicJson(layout.manifestPath, {
        schema: MANIFEST_SCHEMA,
        coordinationId,
        fenceEpoch: 1,
        processGeneration,
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

    journal = replayJournal(layout).deliveries.slice();
    for (const [packetTaskId, packet] of loadTaskPackets(layout)) taskPackets.set(packetTaskId, packet);

    commit = (draft) => {
      const { delivery } = commitDelivery(store, draft);
      journal.push(delivery);
      return delivery;
    };

    // Restart reconciliation: every nonterminal dispatch must end this block
    // either reattached under a reproven binding identity or typed lost.
    {
      const storedBindings = loadRuntimeBindingRecords(layout);
      const identityDeps = createPlatformIdentityDeps();
      for (const dispatch of [...Object.values(store.state.dispatches)]) {
        if (!dispatch || !NONTERMINAL_DISPATCH_STATES.has(dispatch.state)) continue;
        const record = storedBindings[dispatch.dispatchId] ?? null;
        let live = false;
        if (record && typeof record === 'object') {
          const pid = record.processIdentity?.pid;
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
              const nowIdentity = await identityDeps.getStartIdentity(pid).catch(() => null);
              live = typeof record.processIdentity?.startIdentity === 'string'
                && nowIdentity === record.processIdentity.startIdentity;
            } catch {
              live = false;
            }
          }
        }
        if (live) runtimeBindings.set(dispatch.dispatchId, { record });
        commit({
          type: 'dispatch_reconciled',
          dispatchId: dispatch.dispatchId,
          taskId: dispatch.taskId,
          payload: {
            dispatchId: dispatch.dispatchId,
            taskId: dispatch.taskId,
            outcome: live ? 'reattached' : 'lost',
            reason: live
              ? 'binding-identity-reproven-after-restart'
              : 'no-live-binding-provable-after-restart',
          },
        });
      }
    }

    endpoint = deriveEndpoint({ ipcRoot: roots.ipcRoot, coordinationId, platform: process.platform });
    if (process.platform !== 'win32' && existsSync(endpoint)) {
      // The proven lock authorizes removing a stale socket inode.
      unlinkSync(endpoint);
    }

    server = await createIpcServer({
      endpoint,
      capability: () => capabilityToken,
      handler: handleEnvelope,
      protocol: ORCHESTRATION_PROTOCOL,
    });
  } catch (error) {
    // A failed bootstrap must never orphan an owner: release the lock, close
    // the server and remove any socket this attempt published.
    if (server) {
      try { await server.close(); } catch { /* best effort */ }
    }
    if (endpoint && process.platform !== 'win32' && existsSync(endpoint)) {
      try { unlinkSync(endpoint); } catch { /* best effort */ }
    }
    try { await releaseSupervisorLock(lock, identity.runtimeNonce); } catch { /* audit trail retained */ }
    throw error;
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

  /**
   * Restored-control interrupt ladder for a reattached owned worker. The
   * durable binding's proven process/group identity is the only authority to
   * signal; every attempted signal is recorded in a cleanup receipt.
   */
  async function interruptRuntimeBinding(dispatchId, record, reason = '') {
    const signalsAttempted = [];
    const pid = record.processIdentity?.pid;
    const processGroupId = record.processIdentity?.processGroupId;
    const isAlive = (targetPid) => {
      try {
        process.kill(targetPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const graceMs = 400;
    const awaitExit = async () => {
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline && isAlive(pid)) {
        await new Promise((resolveTick) => setTimeout(resolveTick, 25));
      }
    };
    if (Number.isInteger(pid) && pid > 0) {
      if (process.platform !== 'win32' && Number.isInteger(processGroupId) && processGroupId > 1) {
        for (const signal of ['SIGTERM', 'SIGKILL']) {
          if (!isAlive(pid)) break;
          try {
            process.kill(-processGroupId, signal);
            signalsAttempted.push(`GROUP_${signal}`);
          } catch {
            try {
              process.kill(pid, signal);
              signalsAttempted.push(signal);
            } catch { /* already gone */ }
          }
          await awaitExit();
        }
      } else {
        for (const signal of ['SIGTERM', 'SIGKILL']) {
          if (!isAlive(pid)) break;
          try {
            process.kill(pid, signal);
            signalsAttempted.push(signal);
          } catch { /* already gone */ }
          await awaitExit();
        }
      }
    }
    const stopped = !isAlive(pid);
    commit({
      type: 'cleanup_recorded',
      payload: {
        dispatchId,
        disposition: stopped ? 'group-stopped' : 'group-signalled',
        signalsAttempted: [...signalsAttempted],
        processIdentity: { ...(record.processIdentity ?? {}) },
      },
    });
    const current = store.state.dispatches[dispatchId];
    if (current && ['active', 'waiting'].includes(current.state)) {
      commit({
        type: 'dispatch_state_changed',
        dispatchId,
        taskId: current.taskId,
        payload: { dispatchId, taskId: current.taskId, state: 'cancelled' },
      });
    }
    runtimeBindings.delete(dispatchId);
    persistRuntimeBindingRecords(layout, runtimeBindings);
    return {
      ok: true,
      interrupted: true,
      reason: String(reason ?? ''),
      signalsAttempted,
      stopped,
    };
  }

  async function waitForDeliveries(input) {
    const requested = Number.isInteger(input.timeoutMs) ? input.timeoutMs : 30_000;
    const timeoutMs = Math.max(1, Math.min(requested, ORCHESTRATION_LIMITS.maxWaitMs));
    const afterSequence = Number.isInteger(input.afterSequence) ? input.afterSequence : 0;
    if (afterSequence < 0) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'delivery.wait afterSequence must be a non-negative integer');
    }
    if (afterSequence < store.state.acknowledgedThrough) {
      // v0 retains no pre-watermark history for this consumer: the cursor has
      // fallen behind the durable ack and is expired by definition.
      throw new AiCliError(
        'ORCHESTRATION_CURSOR_EXPIRED',
        `cursor ${afterSequence} precedes the durable acknowledgement watermark ${store.state.acknowledgedThrough}`,
      );
    }
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
      // Task JSON may choose an adapter id but never command/path/argv; the
      // registry only contains validated adapters with honest maturity.
      const adapterId = input.adapterId ?? packet?.adapterId ?? null;
      const adapter = adapterId ? registry.get(adapterId) : null;
      if (!adapter || adapter.maturity === 'unavailable') {
        throw unsupportedAdapterBoundary('dispatch.start');
      }
      throw unsupportedAdapterBoundary('dispatch.start');
    },
    'dispatch.reply': async () => { throw unsupportedAdapterBoundary('dispatch.reply'); },
    'dispatch.guidance': async () => { throw unsupportedAdapterBoundary('dispatch.guidance'); },
    'dispatch.permission.resolve': async () => { throw unsupportedAdapterBoundary('dispatch.permission.resolve'); },
    'dispatch.interrupt': async (input) => {
      const dispatchId = input?.dispatchId;
      const entry = typeof dispatchId === 'string' ? runtimeBindings.get(dispatchId) : null;
      if (!entry) {
        // Without a reproven runtime binding there is no ownership proof to
        // signal against; the typed boundary stays honest.
        throw unsupportedAdapterBoundary('dispatch.interrupt');
      }
      return interruptRuntimeBinding(dispatchId, entry.record, input?.reason);
    },
    'dispatch.verify': async (input) => {
      const verify = verifyDispatch ?? defaultVerifyDispatch;
      if (!verify) throw unsupportedAdapterBoundary('dispatch.verify');
      const taskId = input.taskId;
      const dispatchId = input.dispatchId ?? input.taskId;
      const task = store.state.tasks[taskId];
      if (!task) throw new AiCliError('TASK_NOT_FOUND', `no task ${taskId}`);
      const packet = taskPackets.get(taskId);
      const baseline = input.baseline ?? packet?.baseline ?? null;
      if (!baseline) {
        throw new AiCliError(
          'ORCHESTRATION_INDETERMINATE',
          'no pre-dispatch workspace baseline is available for independent verification',
        );
      }
      const receipt = await verify({
        coordinationId,
        taskId,
        dispatchId,
        fenceEpoch: store.state.fenceEpoch,
        task: { ...packet, taskId, workspace: packet?.workspace ?? input.workspace },
        baseline,
        workerOutcome: input.workerOutcome ?? null,
        commands: input.commands ?? packet?.acceptanceCommands ?? [],
        stateDir: layout.coordinationDir,
        now: Date.now(),
      });
      commit({
        type: 'acceptance_recorded',
        taskId,
        payload: {
          taskId,
          dispatchId,
          verdict: receipt.verdict,
          workerClaimMatched: receipt.workerClaimMatched,
          testsRun: receipt.tests.length,
        },
      });
      return { receipt, verdict: receipt.verdict };
    },
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

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    await server.close();
    runtimeBindings.clear();
    try {
      await releaseSupervisorLock(lock, identity.runtimeNonce);
    } catch {
      // A failed release leaves the audit lock in place; recovery archives it.
    }
  }

  /**
   * Machine-local test/pipeline seam: durably record the trusted launch
   * binding for a live dispatch so a restart can reattach or reconcile.
   * Registration validates identity proof and persists atomically under the
   * held singleton lock.
   */
  async function __recordRuntimeBinding(dispatchId, record) {
    const dispatch = store.state.dispatches[dispatchId];
    if (!dispatch) {
      throw new AiCliError('DISPATCH_NOT_FOUND', `no dispatch ${dispatchId} for runtime binding`);
    }
    if (!NONTERMINAL_DISPATCH_STATES.has(dispatch.state)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `dispatch ${dispatchId} is terminal; no binding may be recorded`);
    }
    if (record.taskId !== dispatch.taskId) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'runtime binding taskId does not match its dispatch');
    }
    validateRuntimeBindingRecord(record);
    runtimeBindings.set(dispatchId, { record });
    persistRuntimeBindingRecords(layout, runtimeBindings);
    return { ok: true, persisted: true };
  }

  return {
    coordinationId,
    endpoint,
    fenceEpoch: store.state.fenceEpoch,
    processGeneration: identity.processGeneration,
    stop,
    __store: store,
    __recordRuntimeBinding,
  };
}
