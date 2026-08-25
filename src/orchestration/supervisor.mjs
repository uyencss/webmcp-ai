import { randomUUID, createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
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
  TERMINAL_WORKER_DELIVERY_TYPES,
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
import { createWorkerCallbackHandlers, buildWorkerPacket, DISPATCH_CAPABILITY_DIRNAME } from './worker-callback.mjs';
import {
  generateDispatchCapabilityToken,
  writeDispatchCapability,
  readDispatchCapabilityFile,
  capabilityDigestOf,
  renderWorkerPreamble,
} from './worker-callback.mjs';
import { validateWorkerCallback } from './contracts.mjs';
import { computeAdapterDigest, computeAdapterMaturity } from './adapters/index.mjs';
import { loadCanaryReceipts, probeExecutableVersion, resolveExecutableDigest } from './canary.mjs';
import { sanitizeEvent } from './redaction.mjs';
import { captureWorkspaceBaseline, canonicalizeExistingPrefix, assertNoProtectedWriteOverlap } from './verifier.mjs';
import { verifyDispatch as defaultVerifyDispatch } from './verifier.mjs';
import {
  SETTLEMENT_PROOF,
  classifyRecoveredStop,
  isSettlementProven,
  normalizeSettlementReceipt,
} from './settlement.mjs';

const READ_ONLY_OPERATIONS = new Set(['coordination.inspect', 'delivery.wait']);

function unsupportedAdapterBoundary(operation) {
  return new AiCliError(
    'UNSUPPORTED_CAPABILITY',
    `operation ${operation} reaches the adapter boundary, which no adapter provides yet`,
    { exitCode: 2 },
  );
}

/** Lexical containment after canonicalization; '' counts as inside. */
function isWithin(candidate, rootPath) {
  const rel = relative(rootPath, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
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

async function buildSupervisorIdentity(processGeneration, identityDepsFactory) {
  const deps = identityDepsFactory ?? createPlatformIdentityDeps;
  let startIdentity = null;
  try {
    startIdentity = await deps().getStartIdentity(process.pid);
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
// Durable launch-intent lease: written BEFORE any child spawns and upgraded
// to `bound` the instant spawn returns (real pid/pgid + proven identity), so
// an owner crash between spawn and runtime-binding persistence still leaves
// recovery a machine-local, secret-free pointer it can act on.
const LAUNCH_INTENT_SCHEMA = 'webmcp.ai-launch-intent/v0';
const LAUNCH_INTENTS_DIRNAME = 'launch-intents';
const NONTERMINAL_DISPATCH_STATES = new Set(['created', 'assigned', 'active', 'waiting', 'settling']);
// Proof-driven settlement retry budget: a failing finalizer is retried a
// bounded number of times before the dispatch parks fail-closed in settling.
const FINALIZE_MAX_ATTEMPTS = 6;
const FINALIZE_RETRY_DELAY_MS = 250;

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

function launchIntentsDirFor(layout) {
  return join(layout.coordinationDir, LAUNCH_INTENTS_DIRNAME);
}

/** Atomically persist one launch-intent lease (machine-local, secret-free). */
function writeLaunchIntent(layout, intent) {
  const dir = launchIntentsDirFor(layout);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomicJson(join(dir, `${intent.dispatchId}.json`), intent);
}

function removeLaunchIntent(layout, dispatchId) {
  try { rmSync(join(launchIntentsDirFor(layout), `${dispatchId}.json`), { force: true }); } catch { /* best effort */ }
}

/** Load every durable launch intent; corrupt files are swept as garbage. */
function loadLaunchIntents(layout) {
  const dir = launchIntentsDirFor(layout);
  const intents = new Map();
  if (!existsSync(dir)) return intents;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const dispatchId = name.slice(0, -'.json'.length);
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (parsed?.schema === LAUNCH_INTENT_SCHEMA && typeof parsed.dispatchId === 'string') {
        intents.set(parsed.dispatchId, parsed);
      } else {
        intents.set(dispatchId, { schema: LAUNCH_INTENT_SCHEMA, dispatchId, state: 'corrupt' });
      }
    } catch {
      intents.set(dispatchId, { schema: LAUNCH_INTENT_SCHEMA, dispatchId, state: 'corrupt' });
    }
  }
  return intents;
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
 * Capability-truthful reattach gate: ONLY an owned-process binding can truly
 * restore control (proven-identity signal ladder), telemetry (durable
 * capability file callbacks) and settlement (owner-side finalization) after a
 * supervisor restart. Provider session/stream handles and their finalizers
 * die with the old owner process, so those bindings must NEVER be labeled
 * reattached — however alive their provider PROCESS still is.
 */
function bindingControlCapable(record) {
  if (!record || typeof record !== 'object') return false;
  return record.capability === 'owned-process' || record.adapterId === 'owned-process';
}

/** Reprove a durable binding's PID liveness AND exact start identity. */
async function recordIdentityReproven(record, identityDeps) {
  const pid = record?.processIdentity?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    const nowIdentity = await identityDeps.getStartIdentity(pid).catch(() => null);
    return typeof record.processIdentity?.startIdentity === 'string'
      && nowIdentity === record.processIdentity.startIdentity;
  } catch {
    return false;
  }
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
    identityDepsFactory = null,
  } = options;
  // Injectable platform identity probes (test seam): production always uses
  // the real per-platform probes. Every signalling decision flows through
  // this factory so identity drift is deterministically testable.
  const identityDepsOf = identityDepsFactory ?? createPlatformIdentityDeps;
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
  const identity = await buildSupervisorIdentity(processGeneration, identityDepsOf);

  // Singleton gate FIRST: no mutable recovery, generation allocation,
  // endpoint publication or lifecycle reconciliation may run unowned.
  const lock = await acquireSupervisorLock(layout, identity);

  let store;
  let capabilityToken;
  let server = null;
  let endpoint = null;
  const runtimeBindings = new Map(); // dispatchId -> { record }
  const liveBindingObjects = new Map(); // dispatchId -> live adapter binding object
  const reattachedAtBoot = new Set(); // dispatchIds reattached during THIS boot
  // Exactly-once settlement: completion receipts are keyed `<dispatchId>:settle`
  // and pre-populated from the replayed journal so a crash between the proven
  // cleanup receipt and the settled transition never duplicates either.
  const settledCompletionKeys = new Set();
  // Idempotent residual sweeps: `<dispatchId>:residual` receipts replay from
  // the journal so repeated recoveries never append duplicate sweep events.
  const residualSweptKeys = new Set();
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
    for (const delivery of journal) {
      if (delivery?.type !== 'cleanup_recorded' || typeof delivery.payload?.idempotencyKey !== 'string') continue;
      const key = delivery.payload.idempotencyKey;
      if (key.endsWith(':settle') && isSettlementProven(delivery.payload.proof)) {
        settledCompletionKeys.add(key);
      } else if (key.endsWith(':residual')) {
        residualSweptKeys.add(key);
      }
    }
    for (const [packetTaskId, packet] of loadTaskPackets(layout)) taskPackets.set(packetTaskId, packet);

    commit = (draft) => {
      const { delivery } = commitDelivery(store, draft);
      journal.push(delivery);
      return delivery;
    };

    // Restart reconciliation is TRANSACTIONAL. Phase A loads every durable
    // record ONCE; phase B classifies every nonterminal dispatch against
    // proven identity into an in-memory nextBindings reconstruction (no
    // persistence, no journal effects); phase C persists the FULL map
    // atomically exactly once; phase D applies journal effects and artifact
    // revocations afterwards. A crash at any point therefore leaves either
    // the previous complete sidecar or the new one — a lost/settling record
    // can never wipe a live binding it was persisted ahead of.
    {
      const storedBindings = loadRuntimeBindingRecords(layout);
      const identityDeps = identityDepsOf();
      const storedIntents = loadLaunchIntents(layout);

      // ---- Phase B: classify everything into nextBindings -----------------
      const nextBindings = new Map();
      for (const [dispatchId, record] of Object.entries(storedBindings)) {
        if (!record || typeof record !== 'object') continue;
        nextBindings.set(dispatchId, { record });
      }

      const settlementEffects = [];
      const reconciledEffects = [];
      for (const dispatch of [...Object.values(store.state.dispatches)]) {
        if (!dispatch || !NONTERMINAL_DISPATCH_STATES.has(dispatch.state)) continue;
        const record = storedBindings[dispatch.dispatchId] ?? null;

        // Crash window AFTER terminal BEFORE cleanup: classify the missing
        // settlement now; its journal effects run only after the single
        // atomic persist below.
        if (dispatch.state === 'settling' && dispatch.terminalOutcome) {
          const orphanStop = await stopOrphanedByProvenIdentity(record, identityDeps);
          const settlement = classifyRecoveredStop(orphanStop);
          if (isSettlementProven(settlement.proof)) nextBindings.delete(dispatch.dispatchId);
          else nextBindings.set(dispatch.dispatchId, { record }); // park: retain control artifacts
          settlementEffects.push({ dispatch, record, orphanStop, settlement });
          continue;
        }

        let live = false;
        let orphanStop = null;
        let launchIntentStop = null;
        if (record && typeof record === 'object' && record.controlOnly !== true && bindingControlCapable(record)) {
          live = await recordIdentityReproven(record, identityDeps);
        }
        if (!live && record) {
          // A still-running orphaned owned process must never outlive its
          // typed lost reconciliation: stop it ONLY through proven identity.
          orphanStop = await stopOrphanedByProvenIdentity(record, identityDeps);
          nextBindings.delete(dispatch.dispatchId);
        } else if (live) {
          nextBindings.set(dispatch.dispatchId, { record });
          reattachedAtBoot.add(dispatch.dispatchId);
        } else {
          // No runtime binding survived the crash — but a BOUND launch intent
          // with a proven identity still gives recovery safe authority over
          // any worker spawned inside the crash window.
          const intent = storedIntents.get(dispatch.dispatchId) ?? null;
          if (intent?.state === 'bound' && intent.processIdentity?.identityProven === true) {
            launchIntentStop = await stopOrphanedByProvenIdentity(
              { processIdentity: intent.processIdentity }, identityDeps,
            );
          }
        }
        reconciledEffects.push({ dispatch, live, record, orphanStop, launchIntentStop });
      }

      // Residual sweep plan: bindings AND capability files AND launch intents
      // whose dispatch is already terminal (or absent from the journal) are
      // crash leftovers behind a settled truth; they are removed idempotently,
      // one keyed receipt per affected dispatch. A bound intent's worker is
      // proven-stopped BEFORE its last durable pointer is deleted.
      const residualSweeps = new Map();
      const residualPlanFor = (dispatchId) => {
        if (!residualSweeps.has(dispatchId)) {
          residualSweeps.set(dispatchId, { record: null, capPaths: [], intentFiles: [], proveStopIntent: null });
        }
        return residualSweeps.get(dispatchId);
      };
      for (const [dispatchId, entry] of [...nextBindings.entries()]) {
        const dispatch = store.state.dispatches[dispatchId];
        if (dispatch && NONTERMINAL_DISPATCH_STATES.has(dispatch.state)) continue;
        residualPlanFor(dispatchId).record = entry.record;
        nextBindings.delete(dispatchId);
      }
      const capabilityDir = join(layout.coordinationDir, DISPATCH_CAPABILITY_DIRNAME);
      if (existsSync(capabilityDir)) {
        for (const name of readdirSync(capabilityDir)) {
          if (!name.endsWith('.cap')) continue;
          const dispatchId = name.slice(0, -'.cap'.length);
          const dispatch = store.state.dispatches[dispatchId];
          // A live nonterminal dispatch keeps its capability even when its
          // binding is parked fail-closed — callback auth survives retries.
          if (dispatch && NONTERMINAL_DISPATCH_STATES.has(dispatch.state)) continue;
          residualPlanFor(dispatchId).capPaths.push(join(capabilityDir, name));
          nextBindings.delete(dispatchId);
        }
      }
      for (const [dispatchId, intent] of storedIntents.entries()) {
        // Intents for dispatches STILL nonterminal are handled below in the
        // post-reconcile pass (this boot may resolve them); planning here
        // would miss them because terminality is decided in Phase D.
        const dispatch = store.state.dispatches[dispatchId];
        if (dispatch && NONTERMINAL_DISPATCH_STATES.has(dispatch.state)) continue;
        const plan = residualPlanFor(dispatchId);
        plan.intentFiles.push(join(launchIntentsDirFor(layout), `${dispatchId}.json`));
        if (intent?.state === 'bound' && intent.processIdentity?.identityProven === true) {
          plan.proveStopIntent = intent.processIdentity;
        }
      }

      // ---- Phase C: ONE atomic persist of the reconstructed map -----------
      persistRuntimeBindingRecords(layout, nextBindings);
      runtimeBindings.clear();
      for (const [dispatchId, entry] of nextBindings.entries()) runtimeBindings.set(dispatchId, entry);

      // ---- Phase D: journal + filesystem effects --------------------------
      for (const effect of settlementEffects) {
        applyRecoveredSettlement(effect.dispatch.dispatchId, effect.dispatch.taskId, effect.record, effect.orphanStop, effect.settlement);
      }
      for (const effect of reconciledEffects) {
        const { dispatch, live, record, orphanStop } = effect;
        if (!live && record) {
          revokeDispatchCapabilityFile(record);
          commit({
            type: 'cleanup_recorded',
            payload: {
              dispatchId: dispatch.dispatchId,
              taskId: dispatch.taskId,
              disposition: 'recovered-binding-reconciled-lost',
              recoveredStop: orphanStop,
            },
          });
        }
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
              : record?.controlOnly === true
                ? 'telemetry-binding-degraded-lost-unattachable'
                : record && !bindingControlCapable(record)
                  ? 'provider-session-control-unrestorable-after-restart'
                  : effect.launchIntentStop
                    ? 'launch-intent-orphan-stopped-after-crash-window'
                    : 'no-live-binding-provable-after-restart',
          },
        });
      }
      // Launch-intent closure for dispatches THIS boot just resolved: a
      // reattached binding supersedes its lease; a just-typed-lost dispatch
      // had its bound orphan stopped during classification, so the last
      // durable pointer is removed under the SAME idempotency key family as
      // every other residual artifact.
      for (const effect of reconciledEffects) {
        const dispatchId = effect.dispatch.dispatchId;
        const intent = storedIntents.get(dispatchId);
        if (!intent) continue;
        if (effect.live) {
          removeLaunchIntent(layout, dispatchId);
          continue;
        }
        const key = `${dispatchId}:residual`;
        if (!effect.launchIntentStop || residualSweptKeys.has(key)) continue;
        residualSweptKeys.add(key);
        removeLaunchIntent(layout, dispatchId);
        commit({
          type: 'cleanup_recorded',
          payload: {
            dispatchId,
            taskId: effect.dispatch.taskId,
            disposition: 'launch-intent-orphan-stopped',
            idempotencyKey: key,
            recoveredStop: effect.launchIntentStop,
          },
        });
        // A `launching`-stuck lease (crash between spawn and handshake) for a
        // dispatch that stays nonterminal is RETAINED fail-closed: no safe
        // authority exists over a possibly-spawned child without identity.
      }
      for (const [dispatchId, plan] of residualSweeps.entries()) {
        const key = `${dispatchId}:residual`;
        if (residualSweptKeys.has(key)) continue;
        residualSweptKeys.add(key);
        // Prove-stop any lingering worker BEFORE deleting its last durable
        // pointer (bound launch intent behind a terminal journal entry).
        let intentStop = null;
        if (plan.proveStopIntent) {
          intentStop = await stopOrphanedByProvenIdentity(
            { processIdentity: plan.proveStopIntent }, identityDepsOf(),
          );
        }
        if (plan.record) revokeDispatchCapabilityFile(plan.record);
        for (const capPath of plan.capPaths) {
          try { rmSync(capPath, { force: true }); } catch { /* best effort */ }
        }
        for (const intentFile of plan.intentFiles) {
          try { rmSync(intentFile, { force: true }); } catch { /* best effort */ }
        }
        commit({
          type: 'cleanup_recorded',
          payload: {
            dispatchId,
            ...(store.state.dispatches[dispatchId]?.taskId
              ? { taskId: store.state.dispatches[dispatchId].taskId }
              : {}),
            disposition: 'residual-artifact-swept',
            idempotencyKey: key,
            ...(intentStop ? { launchIntentStop: intentStop } : {}),
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

  function revokeDispatchCapabilityFile(record) {
    const capabilityFile = record?.callbackCapabilityPath;
    if (typeof capabilityFile !== 'string' || capabilityFile.length === 0) return;
    try { rmSync(capabilityFile, { force: true }); } catch { /* best effort */ }
  }

  /**
   * Settle a dispatch AT MOST ONCE, and only on proven resource release.
   * The proven completion receipt carries an idempotency key replayed from
   * the journal, so retries, crashes between receipt and transition, and
   * repeated recoveries can never duplicate the settled truth.
   */
  function settleDispatchOnce(dispatchId, taskId, { proof, disposition, extraPayload = {}, record = null }) {
    const key = `${dispatchId}:settle`;
    if (!settledCompletionKeys.has(key)) {
      settledCompletionKeys.add(key);
      commit({
        type: 'cleanup_recorded',
        payload: {
          dispatchId,
          taskId,
          proof,
          disposition,
          idempotencyKey: key,
          ...extraPayload,
        },
      });
    }
    const current = store.state.dispatches[dispatchId];
    if (current && current.state === 'settling') {
      commit({
        type: 'dispatch_state_changed',
        dispatchId,
        taskId,
        payload: { dispatchId, taskId, state: 'settled' },
      });
    }
    const entry = runtimeBindings.get(dispatchId) ?? null;
    const effectiveRecord = record ?? entry?.record ?? null;
    runtimeBindings.delete(dispatchId);
    liveBindingObjects.delete(dispatchId);
    if (entry) persistRuntimeBindingRecords(layout, runtimeBindings);
    // Revoke the capability ONLY after settled is durable; retention of this
    // file is what keeps callback auth alive for unproven (parked) retries.
    if (effectiveRecord) revokeDispatchCapabilityFile(effectiveRecord);
  }

  /**
   * Identity-guarded best-effort stop of an orphaned owned process. A pid is
   * signalled ONLY when presence AND the exact recorded start identity are
   * both proven right now; recycled or unprovable pids are never touched.
   */
  async function stopOrphanedByProvenIdentity(record, identityDeps) {
    const pid = record?.processIdentity?.pid;
    const startIdentity = record?.processIdentity?.startIdentity;
    if (!Number.isInteger(pid) || pid <= 0
      || typeof startIdentity !== 'string' || startIdentity.length === 0) {
      return { attempted: false, disposition: 'no-provable-identity' };
    }
    if (pid === process.pid) {
      // Never signal our own process group, whatever a record claims.
      return { attempted: false, disposition: 'self-pid-refused' };
    }
    let alive = false;
    let identityMatches = false;
    let identityProbeOk = false;
    try {
      process.kill(pid, 0);
      alive = true;
      const nowIdentity = await identityDeps.getStartIdentity(pid).catch(() => null);
      identityProbeOk = typeof nowIdentity === 'string' && nowIdentity.length > 0;
      identityMatches = nowIdentity === startIdentity;
    } catch {
      alive = false;
    }
    if (!alive) return { attempted: false, disposition: 'already-exited' };
    if (!identityMatches) {
      // A SUCCESSFUL probe that mismatched proves the original process exited
      // (its pid now belongs to a newcomer we never signal). A FAILED probe
      // proves nothing and must park the settlement fail-closed.
      return {
        attempted: false,
        disposition: identityProbeOk ? 'pid-recycled-original-exited' : 'pid-recycled-identity-unavailable',
      };
    }
    const ladder = await restoredSignalLadder(record, identityDeps);
    return {
      attempted: true,
      disposition: ladder.disposition,
      signalsAttempted: ladder.signalsAttempted,
    };
  }

  /**
   * Crash-window settlement completion: the worker outcome is already durable.
   * Recovery proves resource release (identity-guarded) BEFORE any settle:
   * proven outcomes drive settling -> settled exactly once and release the
   * binding + capability; unproven outcomes PARK the dispatch fail-closed in
   * settling with its binding retained so a retry keeps control.
   */
  async function completeRecoveredSettlement(dispatchId, taskId, record) {
    const orphanStop = await stopOrphanedByProvenIdentity(record, identityDepsOf());
    const settlement = classifyRecoveredStop(orphanStop);
    applyRecoveredSettlement(dispatchId, taskId, record, orphanStop, settlement);
  }

  /**
   * Effect half of a classified recovered settlement. Proven outcomes drive
   * settling -> settled exactly once and release binding + capability;
   * unproven outcomes park the dispatch fail-closed with every control
   * artifact retained (the transactional boot persist already re-approved the
   * durable record before this runs).
   */
  function applyRecoveredSettlement(dispatchId, taskId, record, orphanStop, settlement) {
    if (isSettlementProven(settlement.proof)) {
      settleDispatchOnce(dispatchId, taskId, {
        proof: settlement.proof,
        disposition: 'recovered-post-terminal-cleanup',
        extraPayload: { recoveredStop: orphanStop },
        record,
      });
      return;
    }
    commit({
      type: 'cleanup_recorded',
      payload: {
        dispatchId,
        taskId,
        proof: settlement.proof,
        disposition: `recovered-settlement-${settlement.disposition}`,
        recoveredStop: orphanStop,
      },
    });
    if (record && !runtimeBindings.has(dispatchId)) {
      runtimeBindings.set(dispatchId, { record });
      persistRuntimeBindingRecords(layout, runtimeBindings);
    }
  }

  const recoveredFinalizations = new Set();

  /**
   * Owner-side finalization for a REATTACHED dispatch whose terminal arrives
   * after the restart. The crashed owner's finalizer is gone; this supervisor
   * now owns cleanup + settle + revocation exactly once per dispatch.
   */
  async function finalizeRecoveredTerminal(dispatchId) {
    if (recoveredFinalizations.has(dispatchId)) return;
    recoveredFinalizations.add(dispatchId);
    try {
      const dispatch = store.state.dispatches[dispatchId];
      if (!dispatch) return;
      const record = runtimeBindings.get(dispatchId)?.record ?? null;
      await completeRecoveredSettlement(dispatchId, dispatch.taskId, record);
    } catch {
      // Recovery reconciliation stays truthful even when this best-effort
      // completion fails: a later restart settles from the durable journal.
    } finally {
      recoveredFinalizations.delete(dispatchId);
    }
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
   * Reprove the EXACT recorded start identity of the original worker process
   * right now. Returns 'ok' (alive and identical), 'exited' (ESRCH: the
   * ORIGINAL provably exited) or 'drift' (the pid is held by a different or
   * unprovable process — a recycled pid must NEVER be signalled).
   */
  async function reproveOriginalIdentity(pid, startIdentity, identityDeps) {
    if (!Number.isInteger(pid) || pid <= 0
      || typeof startIdentity !== 'string' || startIdentity.length === 0) return 'drift';
    try {
      process.kill(pid, 0);
    } catch {
      return 'exited';
    }
    const nowIdentity = await identityDeps.getStartIdentity(pid).catch(() => null);
    if (typeof nowIdentity !== 'string' || nowIdentity.length === 0) return 'drift';
    return nowIdentity === startIdentity ? 'ok' : 'drift';
  }

  /**
   * Raw restored-control signal ladder for an owned worker whose live adapter
   * handle no longer exists (post-restart reattach). The durable binding's
   * proven process/group identity is the only authority to signal, the ladder
   * is SIGINT -> SIGTERM -> SIGKILL with exit proof between steps, and the
   * exact start identity is REPROVEN before EVERY signal: identity drift or
   * pid reuse between steps aborts the ladder immediately so a recycled
   * holder can never receive a single byte of our signalling. A surviving
   * worker yields 'group-signalled', which NEVER counts as group-stopped.
   */
  async function restoredSignalLadder(record, identityDeps) {
    const pid = record?.processIdentity?.pid;
    const processGroupId = record?.processIdentity?.processGroupId;
    const startIdentity = record?.processIdentity?.startIdentity;
    const signalsAttempted = [];
    const graceMs = 400;
    let driftAborted = false;
    const awaitExit = async () => {
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline && pidIsAlive(pid)) {
        await new Promise((resolveTick) => setTimeout(resolveTick, 25));
      }
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
      const proof = await reproveOriginalIdentity(pid, startIdentity, identityDeps);
      if (proof === 'exited') break; // original gone: nothing left to signal
      if (proof === 'drift') { driftAborted = true; break; }
      if (process.platform !== 'win32' && Number.isInteger(processGroupId) && processGroupId > 1) {
        try {
          process.kill(-processGroupId, signal);
          signalsAttempted.push(`GROUP_${signal}`);
        } catch {
          try {
            process.kill(pid, signal);
            signalsAttempted.push(signal);
          } catch { /* already gone */ }
        }
      } else {
        try {
          process.kill(pid, signal);
          signalsAttempted.push(signal);
        } catch { /* already gone */ }
      }
      await awaitExit();
    }
    if (driftAborted) {
      return { signalsAttempted, disposition: 'identity-drift-aborted', driftAborted: true };
    }
    // Terminal classification requires FRESH proof, not assumption.
    const finalProof = await reproveOriginalIdentity(pid, startIdentity, identityDeps);
    if (finalProof === 'exited') {
      return { signalsAttempted, disposition: 'group-stopped', exitProven: true };
    }
    if (finalProof === 'drift') {
      return { signalsAttempted, disposition: 'identity-drift-aborted', driftAborted: true };
    }
    return {
      signalsAttempted,
      disposition: signalsAttempted.length > 0 ? 'group-signalled' : 'untouched-alive',
    };
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
      try {
        commit({
          type: 'dispatch_state_changed',
          dispatchId,
          taskId: current.taskId,
          payload: { dispatchId, taskId: current.taskId, state: 'cancelled' },
        });
      } catch {
        // A provider terminal bridge that won a close race already reconciled
        // this dispatch truthfully; our cancellation is then redundant, not
        // an error.
      }
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
    const identityDeps = identityDepsOf();
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
      controlled = await restoredSignalLadder(record, identityDeps);
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
      // The CANONICAL path is part of dispatch-time identity: identical
      // bytes/version at a different location are STALE here, exactly as the
      // pure receipt evaluator treats them.
      executablePath: executable?.path ?? undefined,
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
   * Preventive confinement boundary for EVERY mutable dispatch. An adapter
   * that can write — or whose read-only nature is UNPROVEN — may only launch
   * when the WHOLE task workspace lives inside a coordinator-declared
   * disposable workspace (canonicalized segment-by-segment against lexical,
   * symlink and missing-tail escapes). A provider-native preventive gate
   * counts only when trusted configuration records its canary proof.
   */
  function assertConfinementFor(packet, adapter) {
    const nativeGateProven = trustedConfig?.providerNativeGate?.[adapter?.id] === 'canary-proven';
    const hasWriteRoots = (packet?.allowedWriteRoots ?? []).length > 0;
    if (nativeGateProven && !hasWriteRoots) return; // provider-native gate covers read-only tasks

    // Empty allowedWriteRoots NEVER proves a worker read-only.
    if (!trustedConfig?.confinement || trustedConfig.confinement !== 'disposable-workspace' || !trustedConfig.disposableRoot) {
      throw new AiCliError(
        'POLICY_DENIED',
        'dispatch requires preventive confinement (a disposable workspace) before launch',
      );
    }
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
    const disposableReal = realpathSync(trustedConfig.disposableRoot);
    // Workspace containment: canonical existing prefix + lexical missing
    // tail, so symlinked segments are judged by their REAL destination and a
    // not-yet-created workspace tail stays safely inside the root.
    const workspaceReal = canonicalizeExistingPrefix(String(packet.workspace));
    if (!isWithin(workspaceReal, disposableReal)) {
      throw new AiCliError(
        'POLICY_DENIED',
        'task workspace must live inside the disposable workspace before any worker spawns',
      );
    }
    for (const root of packet.allowedWriteRoots ?? []) {
      if (!isAbsolute(root)) {
        throw new AiCliError('POLICY_DENIED', 'mutable write roots must be absolute paths');
      }
      if (!isWithin(canonicalizeExistingPrefix(root), disposableReal)) {
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
    assertConfinementFor(packet, adapter);
    // Pre-launch RE-CHECK of the canonical protected/write policy: symlink
    // state may have changed since task admission (TOCTOU substitution), so
    // the refusal must happen here — BEFORE the first durable commit, before
    // baseline capture, and long before any worker spawns.
    assertNoProtectedWriteOverlap(packet);

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

    // Production Worker ABI: build the bounded non-secret packet and persist
    // the per-dispatch capability file (0600 inside a 0700 dir). The worker
    // receives ONLY the capability-file path via a single trusted env var;
    // the token itself never enters argv, prompts, journals or responses.
    const dispatchMode = packet?.mode ?? 'delegated-result-return';
    const workerPacket = buildWorkerPacket(taskContext, {
      coordinationId,
      dispatchId,
      bindingId,
      mode: dispatchMode,
      guaranteeTier: 'owned-process',
      fenceEpoch,
    });
    const workerPreamble = renderWorkerPreamble(workerPacket);
    let capabilityFile = null;
    try {
      capabilityFile = writeDispatchCapability({
        coordinationDir: layout.coordinationDir,
        endpoint,
        coordinationId,
        taskId,
        dispatchId,
        bindingId,
        fenceEpoch,
        capabilityToken,
      });
    } catch {
      // A capability file that cannot be persisted means callbacks can never
      // authenticate; the dispatch still launches but stays callback-less.
      capabilityFile = null;
    }

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
      // Durable LAUNCH INTENT before any child can exist: if this owner dies
      // between spawn and runtime-binding persistence, recovery still finds a
      // machine-local, secret-free lease naming exactly what was launched.
      const intentBase = {
        schema: LAUNCH_INTENT_SCHEMA,
        dispatchId,
        bindingId,
        taskId,
        adapterId: adapter.id,
        capability: adapter.lifecycle.kind,
        fenceEpoch,
        coordinationId,
      };
      writeLaunchIntent(layout, { ...intentBase, state: 'launching', issuedAt: new Date().toISOString() });
      // Deterministic crash-window probe (fixture-gated): die EXACTLY after
      // the spawn handshake below but BEFORE the old binding persist path.
      const crashAfterSpawn = trustedConfig?.allowFixtureDispatch === true
        && typeof env.WEBMCP_AI_TEST_CRASH_AFTER_SPAWN === 'string'
        && (env.WEBMCP_AI_TEST_CRASH_AFTER_SPAWN === '*' || env.WEBMCP_AI_TEST_CRASH_AFTER_SPAWN === taskId);
      started = await adapter.lifecycle.launch({
        task: taskContext,
        dispatch: {
          dispatchId,
          bindingId,
          taskId,
          coordinationId,
          fenceEpoch,
          mode: dispatchMode,
          guaranteeTier: 'owned-process',
          capabilityFile,
          workerPacket,
          onSpawned: async ({ pid, processGroupId, startIdentity, identityProven }) => {
            // Launch-intent HANDSHAKE: the adapter calls this the instant the
            // child exists and its identity is probed, upgrading the durable
            // lease to `bound` so the orphan is locatable and controllable.
            writeLaunchIntent(layout, {
              ...intentBase,
              state: 'bound',
              issuedAt: new Date().toISOString(),
              processIdentity: {
                pid,
                processGroupId,
                ...(identityProven ? { startIdentity } : {}),
                identityProven: identityProven === true,
              },
            });
            if (crashAfterSpawn) {
              process.kill(process.pid, 'SIGKILL');
            }
          },
          // Durable evidence namespace: spilled output lands under THIS
          // coordination's canonical refsDir, namespaced per dispatch so no
          // two dispatches can ever overwrite each other's evidence.
          refsDir: layout.refsDir,
          refNamespace: `${coordinationId}__${dispatchId}`,
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
    // The token itself NEVER persists: only its digest and the capability
    // file path (re-read under supervisor ownership, incl. after restart).
    const identity = started.binding.processIdentity ?? null;
    await __recordRuntimeBinding(dispatchId, {
      bindingId,
      adapterId: adapter.id,
      capability: adapter.lifecycle.kind,
      taskId,
      fenceEpoch,
      callbackCapabilityDigest: capabilityDigestOf(capabilityToken),
      ...(capabilityFile ? { callbackCapabilityPath: capabilityFile } : {}),
      processIdentity: identity ?? undefined,
      controlOnly: !identity,
    });
    // The runtime binding is now the durable control record; its launch-intent
    // lease has served its crash-window purpose and is removed idempotently.
    removeLaunchIntent(layout, dispatchId);
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
        // Proof-driven settlement: the owner retries the finalizer a bounded
        // number of times and the dispatch settles ONLY on a PROVEN release
        // receipt. Cleanup errors, unproven stops (`group-signalled`) and
        // unusable receipts park the dispatch fail-closed in settling with
        // its runtime binding and capability retained for retry.
        let settlement = null;
        for (let attempt = 1; attempt <= FINALIZE_MAX_ATTEMPTS; attempt += 1) {
          let receipt = null;
          let finalizeError = null;
          try {
            receipt = await adapter.lifecycle.finalize({ binding: started.binding });
          } catch (error) {
            finalizeError = error;
          }
          settlement = normalizeSettlementReceipt(receipt, finalizeError);
          if (isSettlementProven(settlement.proof)) break;
          if (attempt < FINALIZE_MAX_ATTEMPTS) {
            await new Promise((resolveTick) => setTimeout(resolveTick, FINALIZE_RETRY_DELAY_MS));
          }
        }
        if (isSettlementProven(settlement.proof)) {
          settleDispatchOnce(dispatchId, taskId, {
            proof: settlement.proof,
            disposition: settlement.disposition,
            extraPayload: {
              ...(settlement.reason ? { reason: settlement.reason } : {}),
              released: settlement.proof === SETTLEMENT_PROOF.PROVEN_EXIT ? true : settlement.released,
              signalsAttempted: settlement.signalsAttempted ?? undefined,
            },
          });
        } else {
          commit({
            type: 'cleanup_recorded',
            payload: {
              dispatchId,
              taskId,
              proof: settlement.proof,
              disposition: settlement.disposition,
              reason: settlement.reason,
              retriesExhausted: true,
            },
          });
          // Retain binding + capability file: the retry surface stays intact.
          persistRuntimeBindingRecords(layout, runtimeBindings);
        }
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
      // A transfer fences EVERYTHING authenticated against the current epoch:
      // runtime bindings, per-dispatch worker capabilities and every worker
      // callback. With live work in flight that fencing would orphan running
      // workers behind STALE_COORDINATOR_EPOCH forever, so transfer refuses
      // until no nonterminal dispatch and no retained runtime binding
      // remains. The refusal itself mutates nothing — no epoch bump, no token
      // rotation, no owner change, no lost control worker.
      const activeDispatchIds = Object.values(store.state.dispatches)
        .filter((dispatch) => dispatch && NONTERMINAL_DISPATCH_STATES.has(dispatch.state))
        .map((dispatch) => dispatch.dispatchId)
        .sort();
      const liveBindingIds = [...runtimeBindings.keys()].sort();
      if (activeDispatchIds.length > 0 || liveBindingIds.length > 0) {
        throw new AiCliError(
          'TRANSFER_BLOCKED_ACTIVE_DISPATCHES',
          'ownership transfer refused while nonterminal dispatches or runtime bindings remain',
          { details: { activeDispatches: activeDispatchIds, liveBindings: liveBindingIds } },
        );
      }
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
      const boundDispatchIds = new Set(runtimeBindings.keys());
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
      // Fail-closed closure: a live/settling dispatch WITHOUT a controllable
      // binding (e.g. parked after an unproven settlement) also defers close —
      // its settlement was never proven, so the coordination cannot honestly
      // declare everything terminal.
      for (const dispatch of Object.values(store.state.dispatches)) {
        if (!dispatch || !NONTERMINAL_DISPATCH_STATES.has(dispatch.state)) continue;
        if (boundDispatchIds.has(dispatch.dispatchId)) continue;
        if (!['active', 'waiting', 'settling'].includes(dispatch.state)) continue;
        pending.push({
          dispatchId: dispatch.dispatchId,
          code: 'WORKER_STOP_UNPROVEN',
          reason: 'settlement unproven: no controllable runtime binding',
        });
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
      // Canonical overlap policy: lexical disjointness is NOT enough. Alias
      // spellings (symlinks) resolving onto a protected location are refused
      // BEFORE any durable task record exists.
      assertNoProtectedWriteOverlap(packet);
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
      // Truthfulness over the state machine: a task that already received its
      // worker's terminal report (awaiting_acceptance) or reached an accepted/
      // rejected/cancelled end can NEVER truthfully answer cancelled:true.
      // These answers are idempotent, typed and commit NOTHING.
      if (['awaiting_acceptance', 'accepted', 'rejected', 'cancelled'].includes(taskNow)) {
        return {
          cancelled: false,
          alreadyTerminal: true,
          state: taskNow,
          interruptEffects: store.state.interruptEffects.filter((effect) => effect.taskId === taskId),
          stops,
        };
      }
      commit({
        type: 'task_state_changed',
        taskId,
        payload: { taskId, state: 'cancelled', reason: String(input.reason ?? ''), actor: envelope.requestId },
      });
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
    try {
      // Bounded shutdown: an orphaned half-open client socket must never wedge
      // the owner's exit. closeAllConnections (when available) drops stragglers.
      await Promise.race([
        Promise.resolve(server.close()),
        new Promise((resolveTick) => setTimeout(resolveTick, 3_000).unref?.()),
      ]);
      server.closeAllConnections?.();
    } catch {
      // Best-effort teardown; recovery reconciles anything left behind.
    }
    runtimeBindings.clear();
    liveBindingObjects.clear();
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
      const rec = entry.record;
      // Legacy seam records may carry a plaintext capability; production
      // records hold ONLY digest + path and re-read the file every time.
      let token = typeof rec.callbackCapability === 'string' ? rec.callbackCapability : null;
      if (!token && rec.callbackCapabilityPath) {
        try {
          const cap = readDispatchCapabilityFile(rec.callbackCapabilityPath);
          if (cap.dispatchId !== dispatchId || cap.bindingId !== rec.bindingId) continue;
          if (typeof rec.callbackCapabilityDigest === 'string'
            && capabilityDigestOf(cap.capabilityToken) !== rec.callbackCapabilityDigest) continue;
          token = cap.capabilityToken;
        } catch {
          // Revoked/missing/unreadable capability: callbacks fail closed.
          continue;
        }
      }
      if (!token) continue;
      map.set(rec.bindingId, { dispatchId, taskId: rec.taskId, capabilityToken: token });
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
        // A recovered (reattached) dispatch has NO live owner finalizer — this
        // supervisor IS the owner now, so a terminal callback must trigger
        // resource settlement exactly once. Dispatches launched by THIS
        // process keep their own launch-time finalizer and are skipped here.
        if (TERMINAL_WORKER_DELIVERY_TYPES.includes(type)) {
          const terminalDispatchId = typeof payload?.dispatchId === 'string' ? payload.dispatchId : null;
          if (terminalDispatchId && reattachedAtBoot.has(terminalDispatchId)) {
            void finalizeRecoveredTerminal(terminalDispatchId);
          }
        }
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
