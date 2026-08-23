import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AiCliError } from '../errors.mjs';
import { readClientCapability, recoverAuthority } from './authority.mjs';
import {
  GUARANTEE_TIERS,
  OPERATIONS,
  ORCHESTRATION_LIMITS,
  ORCHESTRATION_MODES,
  ORCHESTRATION_PROTOCOL,
} from './constants.mjs';
import { validateCallRequest, validateCreateRequest } from './contracts.mjs';
import { evaluateAdapterMaturities } from './canary.mjs';
import { readOrchestrationGuide } from './guide.mjs';
import { deriveEndpoint, requestIpc } from './ipc.mjs';
import { resolveOrchestrationRoots } from './paths.mjs';
import { evaluateRetention, pruneCoordination } from './retention.mjs';

const ENTRY_PATH = fileURLToPath(new URL('./supervisor-entry.mjs', import.meta.url));
const PACKAGE_JSON_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')).version;
  } catch {
    return null;
  }
}

export function isOrchestrationDisabled(env = {}) {
  return env.WEBMCP_AI_ORCHESTRATION_DISABLED === '1';
}

function layoutFor(roots, coordinationId) {
  const coordinationDir = join(roots.stateRoot, 'coordinations', coordinationId);
  return Object.freeze({
    coordinationDir,
    manifestPath: join(coordinationDir, 'manifest.json'),
    journalPath: join(coordinationDir, 'events.jsonl'),
    snapshotPath: join(coordinationDir, 'snapshot.json'),
    refsDir: join(coordinationDir, 'refs'),
    lockPath: join(coordinationDir, 'supervisor.lock'),
  });
}

function readSnapshot(layout) {
  if (!existsSync(layout.snapshotPath)) return null;
  try {
    return JSON.parse(readFileSync(layout.snapshotPath, 'utf8'));
  } catch {
    throw new AiCliError('SNAPSHOT_CORRUPT', 'coordination snapshot is not valid JSON');
  }
}

/**
 * Read-only capability report. Usable even when the kill switch is engaged.
 */
export function getOrchestrationCapabilities(options = {}) {
  const env = options.env ?? {};
  const roots = resolveOrchestrationRoots({ env });
  return {
    ok: true,
    protocol: ORCHESTRATION_PROTOCOL,
    packageVersion: options.packageVersion ?? readPackageVersion(),
    enabled: !isOrchestrationDisabled(env),
    stateRoot: roots.stateRoot,
    limits: ORCHESTRATION_LIMITS,
    modes: ORCHESTRATION_MODES,
    guaranteeTiers: GUARANTEE_TIERS,
    operations: OPERATIONS,
    adapters: evaluateAdapterMaturities({ stateRoot: roots.stateRoot, env }),
    maturityNotice: 'adapter maturity is fixture-only until separately authorized live canary receipts exist',
  };
}

/**
 * Library client that spawns/reattaches per-Coordination supervisors and
 * injects machine-local authority into every IPC request.
 */
export function createOrchestrationClient({ env = {}, spawnImpl } = {}) {
  const children = new Map();
  const doSpawn = spawnImpl ?? ((entryArgs, childEnv) => new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(process.execPath, [ENTRY_PATH, ...entryArgs], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let buffered = '';
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      // Release the bootstrap pipes so a detached supervisor never keeps the
      // launching CLI process alive waiting on inherited stdio.
      child.stdout.destroy();
      child.stderr.destroy();
      fn(value);
    };
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      if (!buffered.includes('\n')) return;
      const line = buffered.slice(0, buffered.indexOf('\n')).trim();
      let ready;
      try {
        ready = JSON.parse(line);
      } catch {
        settle(rejectSpawn, new AiCliError('ORCHESTRATION_INDETERMINATE', 'supervisor bootstrap produced no valid ready line'));
        return;
      }
      if (ready.ok) {
        settle(resolveSpawn, { child, ready });
      } else {
        settle(rejectSpawn, Object.assign(
          new AiCliError(ready.error?.code ?? 'ORCHESTRATION_INDETERMINATE', ready.error?.message ?? 'supervisor bootstrap failed', { exitCode: 1 }),
          { payload: ready },
        ));
      }
    });
    child.stderr.on('data', (chunk) => {
      // Bootstrap diagnostics stay bounded; never echoed into Deliveries.
      void chunk.toString('utf8').slice(0, 2000);
    });
    child.once('exit', (code) => {
      settle(rejectSpawn, new AiCliError('WORKER_PROCESS_LOST', `supervisor exited during bootstrap (code ${code})`));
    });
  }));

  function guardDisabled() {
    if (isOrchestrationDisabled(env)) {
      throw new AiCliError(
        'ORCHESTRATION_DISABLED',
        'orchestration is disabled by WEBMCP_AI_ORCHESTRATION_DISABLED=1; one-shot commands remain available',
      );
    }
  }

  async function spawnSupervisor(mode, coordinationId, bootstrap = {}) {
    const args = ['--mode', mode];
    if (coordinationId) args.push('--coordination-id', coordinationId);
    const { child, ready } = await doSpawn(args, env);
    if (coordinationId) children.set(coordinationId, child);
    else if (ready.coordinationId) children.set(ready.coordinationId, child);
    if (bootstrap.stdinPayload !== undefined) {
      try {
        child.stdin.write(`${JSON.stringify(bootstrap.stdinPayload)}\n`);
        child.stdin.end();
      } catch {
        // Entry may have already closed stdin after reading EOF.
      }
    } else {
      child.stdin.end();
    }
    child.unref();
    return ready;
  }

  async function callOnce(coordinationId, request) {
    const roots = resolveOrchestrationRoots({ env });
    const layout = layoutFor(roots, coordinationId);
    if (!existsSync(layout.manifestPath)) {
      throw new AiCliError('COORDINATION_NOT_FOUND', `no coordination ${coordinationId}`);
    }
    const snapshot = readSnapshot(layout);
    const capability = readClientCapability(layout);
    const envelope = {
      protocol: request.protocol,
      requestId: request.requestId,
      coordinationId,
      fenceEpoch: snapshot?.fenceEpoch ?? 1,
      capability,
      operation: request.operation,
      input: request.input,
    };
    const endpoint = deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId });
    const waitBudget = request.operation === 'delivery.wait'
      ? Math.min(Number(request.input?.timeoutMs ?? 30_000), ORCHESTRATION_LIMITS.maxWaitMs) + 5_000
      : undefined;
    return requestIpc(endpoint, envelope, { timeoutMs: waitBudget ?? 10_000 });
  }

  function isConnectivityError(error) {
    return ['ECONNREFUSED', 'ENOENT', 'EACCES', 'ECONNRESET', 'EPIPE', 'EINVAL'].includes(error?.code);
  }

  const client = {
    /** Create a Coordination with its detached supervisor (generation 1). */
    async create(createRequest) {
      guardDisabled();
      const normalized = validateCreateRequest(createRequest);
      const ready = await spawnSupervisor('create', null, {
        stdinPayload: { owner: normalized.owner ?? null },
      });
      return {
        ok: true,
        protocol: ORCHESTRATION_PROTOCOL,
        requestId: normalized.requestId,
        coordinationId: ready.coordinationId,
        fenceEpoch: ready.fenceEpoch,
        processGeneration: ready.processGeneration,
      };
    },

    /** Call by explicit Coordination ID; recovers a dead supervisor once. */
    async call(coordinationId, callRequest) {
      guardDisabled();
      const normalized = validateCallRequest(callRequest);
      try {
        return await callOnce(coordinationId, normalized);
      } catch (error) {
        if (!isConnectivityError(error)) throw error;
      }
      // Cold reattach: recovery receives only the Coordination ID and resolved
      // state root context — no tokens or prompts on argv.
      const roots = resolveOrchestrationRoots({ env });
      const layout = layoutFor(roots, coordinationId);
      recoverAuthority(layout, readSnapshot(layout));
      await spawnSupervisor('recover', coordinationId);
      return callOnce(coordinationId, normalized);
    },

    capabilities() {
      return getOrchestrationCapabilities({ env, packageVersion: readPackageVersion() });
    },

    guide(requestOptions = {}) {
      return readOrchestrationGuide({
        packageVersion: readPackageVersion(),
        format: requestOptions.format ?? 'markdown',
      });
    },

    /** Evaluate retention for every known Coordination and execute safe prunes. */
    async prune() {
      guardDisabled();
      const roots = resolveOrchestrationRoots({ env });
      const coordinationsDir = join(roots.stateRoot, 'coordinations');
      const receipts = [];
      if (!existsSync(coordinationsDir)) return { ok: true, receipts };
      for (const name of readdirSync(coordinationsDir)) {
        if (!name.startsWith('coord_')) continue;
        const layout = layoutFor(roots, name);
        const snapshot = existsSync(layout.snapshotPath) ? readSnapshot(layout) : null;
        if (!snapshot) continue;
        const decision = evaluateRetention(snapshot, Date.now(), {});
        receipts.push({
          coordinationId: name,
          decision,
          ...(await pruneCoordination(layout, decision)),
        });
      }
      return { ok: true, receipts };
    },

    /* ---- test/machine-local inspection hooks (not part of the public ABI) --- */
    __capabilityFor(coordinationId) {
      return readClientCapability(layoutFor(resolveOrchestrationRoots({ env }), coordinationId));
    },
    __endpointFor(coordinationId) {
      const roots = resolveOrchestrationRoots({ env });
      return deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId });
    },
    async __callRawEnvelope(coordinationId, envelopeOverrides = {}) {
      const roots = resolveOrchestrationRoots({ env });
      const layout = layoutFor(roots, coordinationId);
      const snapshot = readSnapshot(layout);
      const base = {
        protocol: ORCHESTRATION_PROTOCOL,
        requestId: 'req_raw',
        coordinationId,
        fenceEpoch: snapshot?.fenceEpoch ?? 1,
        capability: readClientCapability(layout),
        operation: 'coordination.inspect',
        input: {},
        ...envelopeOverrides,
      };
      if (base.fenceEpochOverride !== undefined) {
        base.fenceEpoch = base.fenceEpochOverride;
        delete base.fenceEpochOverride;
      }
      const endpoint = deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId });
      return requestIpc(endpoint, base, { timeoutMs: 5000 });
    },
    async killSupervisor(coordinationId) {
      const child = children.get(coordinationId);
      if (!child || child.exitCode !== null || child.signalCode !== null) return false;
      child.kill('SIGKILL');
      await new Promise((resolveExit) => child.once('exit', resolveExit));
      children.delete(coordinationId);
      // A SIGKILLed supervisor leaves its socket inode behind; remove it so
      // the next connection surfaces as a clean connectivity failure.
      const endpoint = this.__endpointFor(coordinationId);
      try {
        if (existsSync(endpoint)) unlinkSync(endpoint);
      } catch {
        // Best-effort only; recovery also unlinks under lock proof.
      }
      return true;
    },
    async dispose() {
      for (const [id, child] of [...children]) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await Promise.race([
            new Promise((resolveExit) => child.once('exit', resolveExit)),
            new Promise((resolveTick) => setTimeout(resolveTick, 1500).unref?.()),
          ]);
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
        children.delete(id);
      }
    },
  };
  return client;
}
