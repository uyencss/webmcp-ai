import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

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
  WORKER_CALLBACK_OPERATIONS,
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
import { createWorkerCallbackHandlers } from './worker-callback.mjs';
import { generateDispatchCapabilityToken } from './worker-callback.mjs';
import { validateWorkerCallback } from './contracts.mjs';
import { computeAdapterDigest, computeAdapterMaturity } from './adapters/index.mjs';
import { loadCanaryReceipts, probeExecutableVersion, resolveExecutableDigest } from './canary.mjs';
import { sanitizeEvent } from './redaction.mjs';
import { captureWorkspaceBaseline } from './verifier.mjs';
import { verifyDispatch as defaultVerifyDispatch } from './verifier.mjs';

const READ_ONLY_OPERATIONS = new Set(['coordination.inspect', 'delivery.wait']);

function unsupportedAdapterBoundary(operation) {
  return new AiCliError(
    'UNSUPPORTED_CAPABILITY',
    `operation ${operation} reaches the adapter boundary, which no adapter provides yet`,
    { exitCode: 2 },
  );
}

const DISPATCH_START_FIELDS = new Set(['taskId', 'adapterId', 'capability']);

function strictDispatchStartInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'dispatch.start input must be an object', { exitCode: 2 });
  }
  const unknown = Object.keys(input).filter((key) => !DISPATCH_START_FIELDS.has(key));
  if (unknown.length > 0) {
    // Request-supplied executables, commands, environment overrides, database
    // paths or maturity bypasses are contract violations, never hints.
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `dispatch.start input has forbidden field(s): ${unknown.sort().join(', ')}`,
      { exitCode: 2 },
    );
  }
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
    trustedCoordinatorConfig: trustedConfig = null,
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
  const liveBindingObjects = new Map(); // dispatchId -> live adapter binding object
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
        if (record && typeof record === 'object' && record.controlOnly !== true) {
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
      // Route-scoped authentication: worker callback frames authenticate
      // against their OWN binding's dispatch capability, never the
      // coordinator token.
      capability: (envelope) => {
        if (WORKER_CALLBACK_OPERATIONS.includes(envelope?.operation)) {
          const bindingId = envelope.input?.bindingId ?? null;
          return callbackBindingsMap().get(bindingId)?.capabilityToken ?? null;
        }
        return capabilityToken;
      },
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
    const state = store.state.coordinationState;
    if (!['open'].includes(state)) {
      // A deferred close must stay retryable while the coordination drains:
      // close is the ONLY mutation allowed from the closing state.
      if (operation === 'coordination.close' && state === 'closing') return;
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
   * Raw restored-control signal ladder for an owned worker whose live adapter
   * handle no longer exists (post-restart reattach). The durable binding's
   * proven process/group identity is the only authority to signal, and the
   * ladder is SIGINT -> SIGTERM -> SIGKILL with exit proof between steps.
   */
  async function restoredSignalLadder(pid, processGroupId) {
    const signalsAttempted = [];
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
    if (process.platform !== 'win32' && Number.isInteger(processGroupId) && processGroupId > 1) {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
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
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
        if (!isAlive(pid)) break;
        try {
          process.kill(pid, signal);
          signalsAttempted.push(signal);
        } catch { /* already gone */ }
        await awaitExit();
      }
    }
    return { signalsAttempted, disposition: isAlive(pid) ? 'group-signalled' : 'group-stopped' };
  }

  function pidIsAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function awaitExitProof(pid, graceMs = 2_000) {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && pidIsAlive(pid)) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 25));
    }
    return !pidIsAlive(pid);
  }

  function dispatchReconciled(dispatch) {
    if (!dispatch) return true;
    return ['settled', 'lost', 'failed'].includes(dispatch.state)
      || Boolean(dispatch.terminalOutcome)
      || dispatch.state === 'cancelled';
  }

  /** Bounded wait for the provider/bridge to reach a truthful terminal state. */
  async function awaitDispatchReconciliation(dispatchId, windowMs = 3_000) {
    const deadline = Date.now() + windowMs;
    for (;;) {
      if (dispatchReconciled(store.state.dispatches[dispatchId])) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolveTick) => setTimeout(resolveTick, 25));
    }
  }

  /**
   * Release a binding ONLY after its stop is proven: commit cleanup evidence,
   * reconcile the dispatch truthfully and drop both live maps.
   */
  async function releaseBindingAfterProvenStop(dispatchId, record, disposition, extraPayload = {}) {
    commit({
      type: 'cleanup_recorded',
      payload: {
        dispatchId,
        taskId: record.taskId,
        disposition,
        ...extraPayload,
      },
    });
    const current = store.state.dispatches[dispatchId];
    if (current && ['created', 'assigned', 'active', 'waiting'].includes(current.state)) {
      commit({
        type: 'dispatch_state_changed',
        dispatchId,
        taskId: current.taskId,
        payload: { dispatchId, taskId: current.taskId, state: 'cancelled' },
      });
    }
    runtimeBindings.delete(dispatchId);
    liveBindingObjects.delete(dispatchId);
    persistRuntimeBindingRecords(layout, runtimeBindings);
  }

  /**
   * Proof-driven binding control. Every path either PROVES the worker stop
   * (exit or truthful reconciliation) before any state/binding mutation, or
   * retains the binding and returns a typed WORKER_STOP_UNPROVEN refusal so
   * retries keep control. PID reuse never authorizes signalling; session-kind
   * adapters are aborted through their own control surface, never killed.
   */
  async function controlRuntimeBinding(dispatchId, reason = '') {
    const entry = runtimeBindings.get(dispatchId);
    const record = entry?.record ?? null;
    if (!record || typeof record !== 'object') {
      return {
        ok: false,
        interrupted: false,
        stopped: false,
        resolved: false,
        error: { code: 'DISPATCH_NOT_FOUND', message: `no live runtime binding for ${dispatchId}` },
        reason,
      };
    }
    // Fence epoch guard: bindings issued under another epoch never control.
    if (Number.isInteger(record.fenceEpoch) && record.fenceEpoch !== store.state.fenceEpoch) {
      return {
        ok: false,
        interrupted: false,
        stopped: false,
        resolved: false,
        error: { code: 'STALE_COORDINATOR_EPOCH', message: 'binding was issued under a different fence epoch' },
        reason,
      };
    }

    const liveBinding = liveBindingObjects.get(dispatchId) ?? null;
    const adapter = registry.get(record.adapterId);
    const adapterControl = adapter?.lifecycle?.control ?? null;

    const pid = record.processIdentity?.pid;
    const startIdentity = record.processIdentity?.startIdentity;
    const hasProvenIdentityFields = Number.isInteger(pid) && pid > 0
      && typeof startIdentity === 'string'
      && startIdentity.length > 0;

    // Session-style adapters: the abort IS the control; provider terminal
    // events settle the dispatch later. The server process stays alive.
    if (record.capability === 'opencode-server') {
      if (!liveBinding || typeof adapterControl !== 'function') {
        return {
          ok: false,
          interrupted: false,
          stopped: false,
          resolved: false,
          error: { code: 'WORKER_IDENTITY_UNPROVEN', message: 'no live session control available after restart' },
          reason,
        };
      }
      let aborted;
      try {
        aborted = await adapterControl({ binding: liveBinding, record, reason });
      } catch (error) {
        return {
          ok: false,
          interrupted: false,
          stopped: false,
          resolved: false,
          error: { code: error.code ?? 'WORKER_STOP_UNPROVEN', message: String(error.message ?? 'session abort failed').slice(0, 300) },
          reason,
        };
      }
      if (!aborted || aborted.ok !== true) {
        return {
          ok: false,
          interrupted: false,
          stopped: false,
          resolved: false,
          error: aborted?.error ?? { code: 'WORKER_STOP_UNPROVEN', message: 'session abort refused' },
          reason,
        };
      }
      commit({
        type: 'cleanup_recorded',
        payload: {
          dispatchId,
          taskId: record.taskId,
          disposition: 'session-abort-requested',
          mode: 'session-abort',
        },
      });
      return { ok: true, interrupted: true, stopped: false, resolved: false, mode: 'session-abort' };
    }

    if (!hasProvenIdentityFields) {
      return {
        ok: false,
        interrupted: false,
        stopped: false,
        resolved: false,
        error: { code: 'WORKER_IDENTITY_UNPROVEN', message: 'no proven process identity for this binding' },
        reason,
      };
    }

    // Presence + identity proof BEFORE anything else.
    let presenceAlive = false;
    let identityMatches = false;
    const identityDeps = createPlatformIdentityDeps();
    try {
      process.kill(pid, 0);
      presenceAlive = true;
      const nowIdentity = await identityDeps.getStartIdentity(pid).catch(() => null);
      identityMatches = nowIdentity === startIdentity;
    } catch {
      presenceAlive = false;
    }
    if (!presenceAlive) {
      // Exit is PROVEN by absence: release truthfully without signalling.
      await releaseBindingAfterProvenStop(dispatchId, record, 'already-exited');
      return { ok: true, interrupted: false, stopped: true, resolved: true, disposition: 'already-exited' };
    }
    if (!identityMatches) {
      // PID recycled: the original worker is provably gone and the newcomer
      // is NEVER signalled. Release our binding without touching that pid.
      await releaseBindingAfterProvenStop(dispatchId, record, 'pid-recycled-original-exited');
      return { ok: true, interrupted: false, stopped: true, resolved: true, disposition: 'pid-recycled' };
    }

    let controlled = null;
    if (liveBinding && typeof adapterControl === 'function') {
      try {
        controlled = await adapter.lifecycle.control({ binding: liveBinding, record, reason });
      } catch (error) {
        return {
          ok: false,
          interrupted: true,
          stopped: false,
          resolved: false,
          error: { code: error.code ?? 'WORKER_STOP_UNPROVEN', message: String(error.message ?? 'adapter control failed').slice(0, 300) },
          reason,
        };
      }
      if (!controlled || controlled.ok !== true) {
        return {
          ok: false,
          interrupted: true,
          stopped: false,
          resolved: false,
          error: controlled?.error ?? { code: 'WORKER_STOP_UNPROVEN', message: 'adapter control refused the stop' },
          reason,
        };
      }
    } else {
      // Restored-control fallback: only owned-process capability may take the
      // raw signal ladder; everything else fails closed.
      if (record.capability !== 'owned-process' && record.adapterId !== 'owned-process') {
        return {
          ok: false,
          interrupted: false,
          stopped: false,
          resolved: false,
          error: { code: 'UNSUPPORTED_CAPABILITY', message: `adapter ${record.adapterId} exposes no interrupt control for this binding` },
          reason,
        };
      }
      controlled = await restoredSignalLadder(pid, record.processIdentity?.processGroupId);
    }

    const stopped = await awaitExitProof(pid, (controlled.signalsAttempted?.length ?? 0) === 0 ? 300 : 2_000);
    const signalsAttempted = controlled.signalsAttempted ?? liveBinding?.__signalsAttempted ?? [];
    if (!stopped) {
      // The worker SURVIVED the full control attempt. Keep the binding so a
      // retry keeps control, and record the honest evidence.
      commit({
        type: 'cleanup_recorded',
        payload: {
          dispatchId,
          taskId: record.taskId,
          disposition: 'signalled-stop-unproven',
          signalsAttempted: [...signalsAttempted],
          processIdentity: { ...(record.processIdentity ?? {}) },
        },
      });
      return {
        ok: false,
        interrupted: true,
        stopped: false,
        resolved: false,
        signalsAttempted: [...signalsAttempted],
        error: { code: 'WORKER_STOP_UNPROVEN', message: 'worker survived the stop control; binding retained for retry' },
        reason,
      };
    }
    await releaseBindingAfterProvenStop(dispatchId, record, controlled.disposition ?? 'group-stopped', {
      signalsAttempted: [...signalsAttempted],
    });
    return {
      ok: true,
      interrupted: true,
      stopped: true,
      resolved: true,
      disposition: controlled.disposition ?? 'group-stopped',
      signalsAttempted: [...signalsAttempted],
    };
  }

  /**
   * Capability-specific maturity gate for provider-backed kinds. Fixture
   * adapters stay reachable only through the dual-opt-in trusted seam; no
   * request can bypass a stale or missing receipt. Cheap mutable identity is
   * re-probed at dispatch time: executable CONTENT digest and the live
   * `--version` answer must both match the receipt right now.
   */
  function assertPublicDispatchMaturity(adapter) {
    if (adapter.lifecycle.kind === 'owned-process') return;
    if (trustedConfig?.allowFixtureDispatch === true) return;
    // Authorized-harness seam: the canary/closure coordinator may drive a
    // provider through the PUBLIC runtime to EARN its receipt. Still never a
    // request-level bypass.
    if (trustedConfig?.allowUnprovenProviderDispatch === true) return;
    const receipts = loadCanaryReceipts(roots.stateRoot);
    const executable = resolveExecutableDigest(adapter.id, { env });
    const evidence = {
      canaryReceipts: receipts,
      adapterDigest: computeAdapterDigest(adapter),
      executablePathDigest: executable?.digest ?? null,
      installedVersion: probeExecutableVersion(adapter.id, { env }),
      runtimeVersion: process.version,
    };
    const maturity = computeAdapterMaturity(adapter, evidence);
    if (maturity !== 'canary-proven') {
      throw new AiCliError(
        'POLICY_DENIED',
        `provider-backed dispatch via ${adapter.id} requires current capability-specific canary evidence`,
      );
    }
  }

  /**
   * Preventive confinement boundary for mutable dispatch: without a
   * coordinator-declared disposable workspace the dispatch refuses to launch.
   */
  function assertConfinementFor(packet) {
    const mutable = (packet?.allowedWriteRoots ?? []).length > 0;
    if (!mutable) return;
    if (trustedConfig?.confinement !== 'disposable-workspace' || !trustedConfig.disposableRoot) {
      throw new AiCliError(
        'POLICY_DENIED',
        'mutable dispatch requires preventive confinement (a disposable workspace) before launch',
      );
    }
    // A confinement root that does not exist (or is not a real directory)
    // cannot preventively confine anything — refuse instead of pretending.
    if (!isAbsolute(trustedConfig.disposableRoot)) {
      throw new AiCliError('POLICY_DENIED', 'disposable workspace root must be an absolute path');
    }
    let disposableStats = null;
    try {
      disposableStats = lstatSync(trustedConfig.disposableRoot);
    } catch {
      throw new AiCliError('POLICY_DENIED', 'disposable workspace root does not exist; create it before dispatching mutable work');
    }
    if (!disposableStats.isDirectory()) {
      throw new AiCliError('POLICY_DENIED', 'disposable workspace root must be a directory');
    }
    for (const root of packet.allowedWriteRoots) {
      if (!isAbsolute(root) || relative(trustedConfig.disposableRoot, root).startsWith('..')) {
        throw new AiCliError(
          'POLICY_DENIED',
          'mutable write roots must live inside the disposable workspace',
        );
      }
    }
  }

  /**
   * The authoritative public dispatch pipeline: validate → resolve trusted
   * adapter → enforce maturity → capture supervisor-owned baseline → durable
   * state → launch through the adapter → ingest sanitized progress → retain a
   * restart-recoverable control handle → finalize after terminal state and
   * resource reconciliation.
   */
  async function runPublicDispatch(adapter, { taskId, packet }) {
    assertPublicDispatchMaturity(adapter);
    assertConfinementFor(packet);

    const dispatchId = `disp_${randomUUID()}`;
    const bindingId = `worker_${randomUUID().slice(0, 12)}`;
    const capabilityToken = generateDispatchCapabilityToken();
    const fenceEpoch = store.state.fenceEpoch;

    // Supervisor-owned pre-dispatch workspace baseline. Non-git fixture
    // workspaces record a null baseline so verification later fails closed.
    let baseline = null;
    try {
      baseline = captureWorkspaceBaseline({ ...packet, taskId });
    } catch {
      baseline = null;
    }
    if (baseline) {
      writeAtomicJson(join(layout.coordinationDir, 'tasks', `${taskId}.baseline.json`), baseline);
    }

    commit({
      type: 'dispatch_created',
      dispatchId,
      taskId,
      payload: {
        dispatchId,
        taskId,
        adapterId: adapter.id,
        capability: adapter.lifecycle.kind,
        baselineCaptured: baseline !== null,
      },
    });

    const taskContext = { ...packet, taskId };

    // Server-style adapters settle through provider terminal events instead of
    // an owned process exit; bridge both shapes onto one done promise.
    let resolveServerDone;
    const serverDone = new Promise((resolveDone) => { resolveServerDone = resolveDone; });

    const emit = (type, payload) => {
      const sanitizedPayload = sanitizeEvent(payload ?? {});
      if (type === 'worker_done') resolveServerDone?.({ outcome: 'completed' });
      try {
        commit({
          type,
          ...(sanitizedPayload?.dispatchId ? { dispatchId: sanitizedPayload.dispatchId } : {}),
          ...(sanitizedPayload?.taskId ? { taskId: sanitizedPayload.taskId } : {}),
          payload: sanitizedPayload,
        });
      } catch {
        // Provider telemetry that cannot satisfy the delivery contract is
        // dropped defensively; terminal resolution above still proceeds.
      }
    };

    commit({
      type: 'worker_binding_recorded',
      bindingId,
      payload: { bindingId, dispatchId, guaranteeTier: 'owned-process', ownershipMode: 'runtime-owned' },
    });
    commit({
      type: 'dispatch_state_changed',
      dispatchId,
      taskId,
      payload: { dispatchId, taskId, state: 'assigned' },
    });

    let started;
    try {
      started = await adapter.lifecycle.launch({
        task: taskContext,
        dispatch: {
          dispatchId,
          bindingId,
          taskId,
          coordinationId,
          fenceEpoch,
          mode: packet?.mode ?? 'delegated-result-return',
          guaranteeTier: 'owned-process',
        },
        emit,
        resumeSessionId: null,
        resumeThread: null,
        doneForServer: serverDone,
      });
    } catch (error) {
      // Launch failure must leave truthful durable state, never a phantom
      // active dispatch.
      commit({
        type: 'dispatch_state_changed',
        dispatchId,
        taskId,
        payload: { dispatchId, taskId, state: 'failed', reason: error.message?.slice(0, 300) ?? 'launch-failed' },
      });
      throw error;
    }

    if (!started?.ok || !started.binding) {
      commit({
        type: 'dispatch_state_changed',
        dispatchId,
        taskId,
        payload: { dispatchId, taskId, state: 'failed', reason: 'adapter-refused-launch' },
      });
      throw new AiCliError('PROVIDER_PROTOCOL_ERROR', `${adapter.id} refused to launch its worker`);
    }

    commit({
      type: 'dispatch_state_changed',
      dispatchId,
      taskId,
      payload: { dispatchId, taskId, state: 'active' },
    });

    // Retain the control handle durably when the adapter proved process
    // identity; telemetry-only bindings reconcile to lost on recovery.
    const identity = started.binding.processIdentity ?? null;
    await __recordRuntimeBinding(dispatchId, {
      bindingId,
      adapterId: adapter.id,
      capability: adapter.lifecycle.kind,
      taskId,
      fenceEpoch,
      callbackCapability: capabilityToken,
      processIdentity: identity ?? undefined,
      controlOnly: !identity,
    });
    // Keep the LIVE adapter handle so interrupt/close route through the
    // adapter's own control surface (session abort, graceful ladder, ...).
    liveBindingObjects.set(dispatchId, started.binding);

    // Finalization belongs to the OWNER lifetime, not to the start call:
    // after provider terminal state AND resource reconciliation the dispatch
    // settles DURABLY and its runtime binding is released.
    void (async () => {
      try {
        const terminal = started.done ? await started.done : await serverDone;
        // Terminal results that arrive only through the done promise (e.g. a
        // provider closing its stream without a result event) must still
        // become a terminal Delivery — otherwise the reducer never leaves
        // active and the dispatch hangs forever.
        const currentAfterTerminal = store.state.dispatches[dispatchId];
        if (currentAfterTerminal && currentAfterTerminal.terminalOutcome === null) {
          const bridgedType = ({
            worker_done: 'worker_done',
            worker_failed: 'worker_failed',
            worker_cancelled: 'worker_cancelled',
          })[terminal?.terminalType] ?? 'worker_failed';
          commit({
            type: bridgedType,
            payload: {
              dispatchId,
              taskId,
              outcome: bridgedType === 'worker_done' ? 'completed' : bridgedType === 'worker_cancelled' ? 'cancelled' : 'failed',
              exitCode: Number.isInteger(terminal?.exitCode) ? terminal.exitCode : null,
              source: 'supervisor-terminal-bridge',
            },
          });
        }
        let cleanupReceipt = null;
        try {
          cleanupReceipt = await adapter.lifecycle.finalize({ binding: started.binding });
        } catch (error) {
          cleanupReceipt = { disposition: 'cleanup-error', reason: error.message?.slice(0, 200) };
        }
        commit({
          type: 'cleanup_recorded',
          payload: {
            dispatchId,
            taskId,
            disposition: cleanupReceipt?.disposition ?? 'unknown',
            released: cleanupReceipt?.released ?? null,
            retained: cleanupReceipt?.retained ?? null,
          },
        });
        // The legal settling -> settled transition is committed by the owner
        // only after resource reconciliation evidence is durable.
        const current = store.state.dispatches[dispatchId];
        if (current && current.state === 'settling') {
          commit({
            type: 'dispatch_state_changed',
            dispatchId,
            taskId,
            payload: { dispatchId, taskId, state: 'settled' },
          });
        }
        runtimeBindings.delete(dispatchId);
        liveBindingObjects.delete(dispatchId);
        persistRuntimeBindingRecords(layout, runtimeBindings);
      } catch {
        // The owner process is shutting down or the wait was cancelled;
        // recovery reconciliation records the truthful outcome instead.
      }
    })();

    return {
      dispatchId,
      bindingId,
      adapterId: adapter.id,
      sessionId: started.sessionId ?? started.binding.sessionId ?? null,
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
      if (store.state.coordinationState === 'open') {
        commit({ type: 'coordination_state_changed', payload: { state: 'closing' } });
      }
      // Closing is not just a state change: every live owned worker is
      // interrupted through its proven binding identity first, and closure
      // commits ONLY after every stop is proven or truthfully reconciled.
      const stoppedDispatches = [];
      const pending = [];
      for (const [dispatchId] of [...runtimeBindings.entries()]) {
        const state = store.state.dispatches[dispatchId]?.state;
        if (!state || !NONTERMINAL_DISPATCH_STATES.has(state)) continue;
        const stop = await controlRuntimeBinding(dispatchId, 'coordination-close');
        stoppedDispatches.push({ dispatchId, ok: stop.ok === true, stopped: stop.stopped === true });
        if (stop.resolved !== true) {
          const reconciled = await awaitDispatchReconciliation(dispatchId);
          if (!reconciled) pending.push({ dispatchId, code: stop.error?.code ?? 'WORKER_STOP_UNPROVEN' });
        }
      }
      if (pending.length > 0) {
        throw new AiCliError(
          'WORKER_STOP_UNPROVEN',
          'coordination close deferred; live workers remain unproven',
          { details: { pending } },
        );
      }
      if (store.state.coordinationState !== 'closed') {
        commit({ type: 'coordination_state_changed', payload: { state: 'closed' } });
      }
      return { closed: true, stoppedDispatches };
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
      // Cancelling is executable, not just an intent record: every live
      // runtime binding for this task is interrupted through its proven
      // process identity, and the durable task state commits CANCELLED only
      // after every matching live dispatch is terminal or truthfully
      // reconciled. Unproven stops defer the cancellation and keep control.
      const stops = [];
      const pending = [];
      for (const [dispatchId] of [...runtimeBindings.entries()]) {
        if (runtimeBindings.get(dispatchId)?.record.taskId !== taskId) continue;
        const state = store.state.dispatches[dispatchId]?.state;
        if (!state || !NONTERMINAL_DISPATCH_STATES.has(state)) continue;
        const stop = await controlRuntimeBinding(dispatchId, String(input.reason ?? 'task-cancelled'));
        stops.push({ dispatchId, ok: stop.ok === true, stopped: stop.stopped === true });
        if (stop.resolved !== true) {
          const reconciled = await awaitDispatchReconciliation(dispatchId);
          if (!reconciled) pending.push({ dispatchId, code: stop.error?.code ?? 'WORKER_STOP_UNPROVEN' });
        }
      }
      if (pending.length > 0) {
        throw new AiCliError(
          'WORKER_STOP_UNPROVEN',
          'task cancellation deferred; matching live workers are not yet provably terminal',
          { details: { pending } },
        );
      }
      const taskNow = store.state.tasks[taskId].state;
      // A worker that already reported its own terminal state moves the task
      // to awaiting_acceptance through the bridge; cancelling then is a no-op
      // over an already-post-terminal task, never a state regression.
      if (taskNow !== 'cancelled' && taskNow !== 'awaiting_acceptance') {
        commit({
          type: 'task_state_changed',
          taskId,
          payload: { taskId, state: 'cancelled', reason: String(input.reason ?? ''), actor: envelope.requestId },
        });
      }
      return {
        cancelled: true,
        interruptEffects: store.state.interruptEffects.filter((effect) => effect.taskId === taskId),
        stops,
      };
    },
    'dispatch.start': async (input) => {
      strictDispatchStartInput(input);
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
      if (!adapter || adapter.maturity === 'unavailable' || !adapter.lifecycle) {
        throw unsupportedAdapterBoundary('dispatch.start');
      }
      return runPublicDispatch(adapter, { taskId, packet, capability: input.capability ?? null });
    },
    'dispatch.reply': async () => { throw unsupportedAdapterBoundary('dispatch.reply'); },
    'dispatch.guidance': async () => { throw unsupportedAdapterBoundary('dispatch.guidance'); },
    'dispatch.permission.resolve': async () => { throw unsupportedAdapterBoundary('dispatch.permission.resolve'); },
    'dispatch.interrupt': async (input) => {
      const dispatchId = input?.dispatchId;
      if (typeof dispatchId !== 'string' || !runtimeBindings.has(dispatchId)) {
        // Without a reproven runtime binding there is no ownership proof to
        // signal against; the typed boundary stays honest.
        throw unsupportedAdapterBoundary('dispatch.interrupt');
      }
      // Route through the proof-driven control path: fence epoch, binding
      // identity, adapter capability and exit proof are all required.
      const stop = await controlRuntimeBinding(dispatchId, input?.reason);
      if (!stop.ok) {
        throw new AiCliError(
          stop.error.code ?? 'WORKER_STOP_UNPROVEN',
          stop.error.message ?? 'interrupt refused',
          { details: { reason: stop.reason ?? null, ...(stop.signalsAttempted ? { signalsAttempted: stop.signalsAttempted } : {}) } },
        );
      }
      return stop;
    },
    'dispatch.verify': async (input) => {
      // Strict input contract: verification evidence is NEVER caller
      // supplied. Baseline, worker outcome and acceptance commands come from
      // supervisor-owned durable state and the trusted Task packet only.
      const allowedVerifyFields = new Set(['taskId', 'dispatchId']);
      const unknownFields = Object.keys(input ?? {}).filter((key) => !allowedVerifyFields.has(key));
      if (unknownFields.length > 0) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          `dispatch.verify has forbidden field(s): ${unknownFields.sort().join(', ')}`,
        );
      }
      const verify = verifyDispatch ?? defaultVerifyDispatch;
      if (!verify) throw unsupportedAdapterBoundary('dispatch.verify');
      const taskId = input.taskId;
      const task = store.state.tasks[taskId];
      if (!task) throw new AiCliError('TASK_NOT_FOUND', `no task ${taskId}`);
      const packet = taskPackets.get(taskId);
      if (!packet) {
        throw new AiCliError('TASK_NOT_FOUND', `no trusted packet recorded for ${taskId}`);
      }

      // The verified dispatch must be the one THIS task owns and it must have
      // settled durably (terminal outcome + resource reconciliation).
      const candidates = Object.values(store.state.dispatches)
        .filter((entry) => entry.taskId === taskId);
      let dispatch = null;
      if (typeof input.dispatchId === 'string') {
        dispatch = store.state.dispatches[input.dispatchId] ?? null;
        if (!dispatch || dispatch.taskId !== taskId) {
          throw new AiCliError('DISPATCH_NOT_FOUND', `no dispatch ${input.dispatchId} bound to task ${taskId}`);
        }
      } else if (candidates.length === 1) {
        dispatch = candidates[0];
      } else {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          `task ${taskId} does not identify exactly one dispatch (${candidates.length})`,
        );
      }
      if (dispatch.state !== 'settled' || !dispatch.terminalOutcome) {
        throw new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          `dispatch ${dispatch.dispatchId} is ${dispatch.state}; independent verification requires a settled dispatch`,
        );
      }

      // Supervisor-owned pre-dispatch baseline sidecar is the ONLY baseline.
      const baselinePath = join(layout.coordinationDir, 'tasks', `${taskId}.baseline.json`);
      let baseline = null;
      if (existsSync(baselinePath)) {
        try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')); } catch { baseline = null; }
      }
      if (!baseline) {
        throw new AiCliError(
          'ORCHESTRATION_INDETERMINATE',
          'no pre-dispatch workspace baseline is available for independent verification',
        );
      }

      const receipt = await verify({
        coordinationId,
        taskId,
        dispatchId: dispatch.dispatchId,
        fenceEpoch: store.state.fenceEpoch,
        task: { ...packet, taskId, workspace: packet.workspace },
        baseline,
        workerOutcome: dispatch.terminalOutcome,
        commands: packet.acceptanceCommands ?? [],
        stateDir: layout.coordinationDir,
        now: Date.now(),
      });
      if (receipt.verdict === 'accepted' || receipt.verdict === 'rejected') {
        commit({
          type: 'acceptance_recorded',
          taskId,
          payload: {
            taskId,
            dispatchId: dispatch.dispatchId,
            acceptance: receipt.verdict,
            workerClaimMatched: receipt.workerClaimMatched,
            testsRun: receipt.tests.length,
          },
        });
      } else {
        // Indeterminate verification is evidence, never an acceptance state.
        commit({
          type: 'test_verdict_recorded',
          dispatchId: dispatch.dispatchId,
          payload: { dispatchId: dispatch.dispatchId, verdict: 'indeterminate', reason: 'verification-indeterminate' },
        });
      }
      return { receipt, verdict: receipt.verdict, dispatchId: dispatch.dispatchId };
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

  function handleEnvelope(envelope, meta = {}) {
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
      // Worker callback route: the frame IS the callback contract; its own
      // validator plus the per-binding capability check (already matched by
      // the transport for this route) authorize it.
      if (WORKER_CALLBACK_OPERATIONS.includes(envelope.operation)) {
        return Promise.resolve()
          .then(() => processWorkerCallback(envelope.input ?? {}, { presentedCapability: meta.presentedCapability }))
          .then((result) => (result.ok
            ? respond({ ok: true, result })
            : respond({ ok: false, error: result.error })));
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
    if (record.controlOnly === true) {
      // Telemetry-only binding: no proven process identity, so recovery must
      // reconcile this dispatch to lost rather than reattach.
    } else {
      validateRuntimeBindingRecord(record);
    }
    runtimeBindings.set(dispatchId, { record });
    persistRuntimeBindingRecords(layout, runtimeBindings);
    return { ok: true, persisted: true };
  }

  function callbackBindingsMap() {
    const map = new Map();
    for (const [dispatchId, entry] of runtimeBindings) {
      if (entry.record.callbackCapability === undefined) continue;
      map.set(entry.record.bindingId, {
        dispatchId,
        taskId: entry.record.taskId,
        capabilityToken: entry.record.callbackCapability,
      });
    }
    return map;
  }

  /**
   * Machine-local test/pipeline seam: the durable worker binding table the
   * callback transport authenticates against. A generic CLI worker learns its
   * bindingId + dispatch capability from this recorded pairing.
   */
  function __workerBindings() {
    return [...callbackBindingsMap().entries()].map(([bindingId, entry]) => ({
      bindingId,
      dispatchId: entry.dispatchId,
      taskId: entry.taskId,
      capabilityToken: entry.capabilityToken,
    }));
  }

  function workerCallbackOptions() {
    return {
      fenceEpoch: () => store.state.fenceEpoch,
      bindings: callbackBindingsMap(),
      activeDispatches: () => {
        const live = new Set();
        for (const dispatch of Object.values(store.state.dispatches)) {
          if (NONTERMINAL_DISPATCH_STATES.has(dispatch.state)) live.add(dispatch.dispatchId);
        }
        return live;
      },
      knownDispatchIds: () => new Set(Object.keys(store.state.dispatches)),
      dispatchOutcomeOf: (dispatchId) => store.state.dispatches[dispatchId]?.terminalOutcome ?? null,
      appendDelivery: (type, payload, callbackRef) => {
        // Duplicates must bypass the generic commit wrapper: they return the
        // prior durable acknowledgement and never touch the journal.
        const result = commitDelivery(store, { type, payload, ...(callbackRef ? { callbackRef } : {}) });
        if (result.duplicate) {
          return { duplicate: true, acknowledgedSequence: result.acknowledgedSequence };
        }
        journal.push(result.delivery);
        return { sequence: result.delivery.sequence };
      },
    };
  }

  /**
   * Owner-controlled worker callback ingress. The envelope is validated
   * against the v0 contract, routed through the handler table and committed
   * by the single-writer path; duplicates replay the prior durable
   * acknowledgement without appending.
   */
  async function processWorkerCallback(rawCallback, meta = {}) {
    let callback;
    try {
      callback = validateWorkerCallback(rawCallback ?? {});
    } catch (error) {
      return {
        ok: false,
        error: { code: error.code ?? 'ORCHESTRATION_INVALID_INPUT', message: error.message },
      };
    }
    const handlers = createWorkerCallbackHandlers(workerCallbackOptions());
    const handler = handlers[callback.operation];
    if (!handler) {
      return { ok: false, error: { code: 'UNSUPPORTED_CAPABILITY', message: `no worker callback route for ${callback.operation}` } };
    }
    const response = await handler({
      callback,
      presentedCapability: meta.presentedCapability ?? callbackBindingsMap().get(callback.bindingId)?.capabilityToken,
      presentingBindingId: meta.presentingBindingId,
    });
    if (!response.ok && response.error) return response;
    if (response.duplicate) {
      return {
        ok: true,
        duplicate: true,
        acknowledgedSequence: response.acknowledgedSequence,
        ...(response.sequence !== undefined ? { sequence: response.sequence } : {}),
      };
    }
    return { ...response, acknowledgedSequence: response.acknowledgedSequence ?? response.sequence };
  }

  return {
    coordinationId,
    endpoint,
    fenceEpoch: store.state.fenceEpoch,
    processGeneration: identity.processGeneration,
    stop,
    __store: store,
    __recordRuntimeBinding,
    __workerBindings,
    processWorkerCallback,
  };
}
