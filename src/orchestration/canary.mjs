import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AiCliError } from '../errors.mjs';
import { writeAtomicJson } from './atomic-file.mjs';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));

export const CANARY_RECEIPT_SCHEMA = 'webmcp.ai-canary-receipt/v1';
export const CANARY_CONTRACT_VERSION = 'webmcp.ai-canary-contract/v1';
export const CANARY_ADAPTER_IDS = Object.freeze([
  'owned-process',
  'opencode-server',
  'claude-stream',
  'codex-exec',
]);

/**
 * Versioned canary contract vocabulary. A receipt records an exact
 * pass/fail/unsupported verdict per capability; unclaimed capabilities are
 * simply absent and never treated as proven.
 */
export const CANARY_CAPABILITIES = Object.freeze([
  'launch',
  'progressStream',
  'promptRoundTrip',
  'continuationResume',
  'gracefulStop',
  'forceStop',
  'cleanup',
  'publicSupervisorLifecycle',
]);

/** Every provider-backed public dispatch must have THIS much live evidence. */
export const DEFAULT_REQUIRED_DISPATCH_CAPABILITIES = Object.freeze([
  'launch',
  'progressStream',
  'promptRoundTrip',
  'cleanup',
  'publicSupervisorLifecycle',
]);

/**
 * EXACT required capability set per adapter/dispatch kind. A receipt only
 * promotes its adapter when every capability in ITS set reads 'pass'.
 */
export const ADAPTER_REQUIRED_CAPABILITIES = Object.freeze({
  'owned-process': Object.freeze([
    'launch', 'progressStream', 'cleanup', 'publicSupervisorLifecycle',
  ]),
  'opencode-server': Object.freeze([
    'launch', 'progressStream', 'promptRoundTrip', 'cleanup', 'publicSupervisorLifecycle',
  ]),
  'claude-stream': Object.freeze([
    'launch', 'progressStream', 'promptRoundTrip', 'continuationResume', 'cleanup', 'publicSupervisorLifecycle',
  ]),
  'codex-exec': Object.freeze([
    'launch', 'progressStream', 'promptRoundTrip', 'cleanup', 'publicSupervisorLifecycle',
  ]),
});

/** Typed lookup; unknown adapters get the conservative default set. */
export function requiredCapabilitiesFor(adapterId) {
  return ADAPTER_REQUIRED_CAPABILITIES[adapterId] ?? DEFAULT_REQUIRED_DISPATCH_CAPABILITIES;
}

const CANARY_CAPABILITY_STATUSES = Object.freeze(['pass', 'fail', 'unsupported']);

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Behaviorally relevant local modules per adapter id, relative to this file.
 * A change in any of these files invalidates every existing receipt for that
 * adapter until a fresh, separately authorized canary runs again.
 */
const ADAPTER_BEHAVIOR_MODULES = Object.freeze({
  'owned-process': Object.freeze(['adapters/owned-process.mjs']),
  'opencode-server': Object.freeze(['adapters/opencode-server.mjs', 'adapters/opencode-events.mjs']),
  'claude-stream': Object.freeze(['adapters/claude-stream.mjs']),
  'codex-exec': Object.freeze(['adapters/codex-exec.mjs']),
});
const SHARED_BEHAVIOR_MODULES = Object.freeze([
  'public-adapters.mjs',
  // The public lifecycle is driven by these owner modules: a behavior-relevant
  // change here invalidates every provider receipt until canaries rerun.
  'supervisor.mjs',
  'store.mjs',
  'state-machine.mjs',
  // Capability-relevant shared infrastructure the scenarios exercise live:
  // authenticated IPC transport, worker callback ingress, process identity
  // proofs and journal durability all affect what a receipt actually proved.
  'ipc.mjs',
  'worker-callback.mjs',
  'process-identity.mjs',
  'journal.mjs',
]);

/** Static inspection seam for tests: per-adapter behavior module lists. */
export const ADAPTER_BEHAVIOR_MODULES_FOR_TEST = Object.freeze(
  Object.fromEntries(
    Object.entries(ADAPTER_BEHAVIOR_MODULES).map(([id, modules]) => [id, Object.freeze([...modules])]),
  ),
);

/** Static inspection seam for tests: shared behavior module list. */
export function sharedBehaviorModulesForTest() {
  return [...SHARED_BEHAVIOR_MODULES];
}

function behaviorModulePaths(adapterId, { behaviorModules } = {}) {
  if (Array.isArray(behaviorModules)) return behaviorModules;
  const perAdapter = ADAPTER_BEHAVIOR_MODULES[adapterId];
  if (!perAdapter) return null;
  return [...perAdapter, ...SHARED_BEHAVIOR_MODULES].map((relativePath) => join(moduleDir, relativePath));
}

/**
 * Stable identity digest of the adapter IMPLEMENTATION: the real module
 * sources plus shared lifecycle modules — not a name/maturity string pair.
 * Unknown adapter ids degrade to a name-only digest (they can never hold a
 * receipt anyway).
 */
export function canaryAdapterDigest(adapterId, options = {}) {
  const paths = behaviorModulePaths(adapterId, options);
  if (!paths) return sha256Text(`unmapped-adapter:${adapterId}`);
  const hash = createHash('sha256');
  hash.update(`adapter-behavior:${adapterId}\u0000`);
  for (const filePath of paths) {
    hash.update(`${filePath}\u0000`);
    hash.update(readFileSync(filePath));
    hash.update('\u0000');
  }
  return hash.digest('hex');
}

export function canaryDirectory(stateRoot) {
  return join(stateRoot, 'canary');
}

export function canaryReceiptPath(stateRoot, adapterId) {
  if (!CANARY_ADAPTER_IDS.includes(adapterId)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `unknown canary adapter ${String(adapterId)}`, { exitCode: 2 });
  }
  return join(canaryDirectory(stateRoot), `${adapterId}.json`);
}

/**
 * Machine-local receipts are the only promotion evidence. Corrupt sidecars are
 * skipped defensively: a broken receipt never blocks the capability report.
 */
export function loadCanaryReceipts(stateRoot) {
  const dir = canaryDirectory(stateRoot);
  if (!existsSync(dir)) return [];
  const receipts = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (parsed?.schema === CANARY_RECEIPT_SCHEMA && typeof parsed.adapterId === 'string') {
        receipts.push(parsed);
      }
    } catch {
      // A unreadable sidecar is ignored; the fixture-only ceiling stands.
    }
  }
  return receipts;
}

function assertCapabilityMap(capabilities) {
  if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'canary receipt requires a capabilities object', { exitCode: 2 });
  }
  const keys = Object.keys(capabilities);
  if (keys.length === 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'canary receipt capabilities must not be empty', { exitCode: 2 });
  }
  for (const key of keys) {
    if (!CANARY_CAPABILITIES.includes(key)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `unknown canary capability '${key}'`, { exitCode: 2 });
    }
    if (!CANARY_CAPABILITY_STATUSES.includes(capabilities[key])) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `capability '${key}' must be pass, fail or unsupported`, { exitCode: 2 });
    }
  }
}

export function recordCanaryReceipt(stateRoot, receipt) {
  const required = [
    'executablePathDigest', 'executablePath',
    'executableVersion', 'runtimeVersion', 'scenario', 'contractVersion',
    'capabilities', 'expiresAt', 'platformIdentity',
  ];
  for (const field of required) {
    const value = receipt?.[field];
    if (field === 'capabilities') continue;
    if (typeof value !== 'string' || value.length === 0) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `canary receipt requires ${field}`, { exitCode: 2 });
    }
  }
  if (!CANARY_ADAPTER_IDS.includes(receipt.adapterId)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `unknown canary adapter ${receipt.adapterId}`, { exitCode: 2 });
  }
  if (receipt.contractVersion !== CANARY_CONTRACT_VERSION) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `canary receipt contractVersion must be ${CANARY_CONTRACT_VERSION}`,
      { exitCode: 2 },
    );
  }
  assertCapabilityMap(receipt.capabilities);
  const expiry = Date.parse(receipt.expiresAt);
  if (Number.isNaN(expiry) || expiry <= Date.now()) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'canary receipt expiresAt must be a future timestamp', { exitCode: 2 });
  }
  const normalized = Object.freeze({
    schema: CANARY_RECEIPT_SCHEMA,
    authorizedBy: 'operator dual opt-in',
    createdAt: new Date().toISOString(),
    ...receipt,
    adapterDigest: typeof receipt.adapterDigest === 'string' && receipt.adapterDigest.length > 0
      ? receipt.adapterDigest
      : canaryAdapterDigest(receipt.adapterId),
  });
  const target = canaryReceiptPath(stateRoot, normalized.adapterId);
  mkdirSync(canaryDirectory(stateRoot), { recursive: true, mode: 0o700 });
  // Atomic write so an overwrite of any pre-existing sidecar lands back at
  // mode 0600 instead of inheriting the old file's wider mode.
  writeAtomicJson(target, normalized);
  return normalized;
}

/**
 * Resolve the executable an adapter WOULD use today, env-first, mirroring the
 * adapters' own option/env precedence without instantiating them.
 */
export function resolveAdapterExecutablePath(adapterId, { env = {} } = {}) {
  switch (adapterId) {
    case 'owned-process':
      return process.execPath;
    case 'opencode-server':
      return env.OPENCODE_BIN ?? 'opencode';
    case 'claude-stream':
      return env.CLAUDE_BIN ?? 'claude';
    case 'codex-exec':
      return env.CODEX_BIN ?? 'codex';
    default:
      return null;
  }
}

function locateRealExecutable(candidate, env) {
  if (candidate.includes('/')) return realpathSync(candidate);
  const located = spawnSync('which', [candidate], { shell: false, encoding: 'utf8', env });
  const found = String(located.stdout ?? '').trim().split(/\r?\n/)[0];
  if (located.status !== 0 || !found) throw new Error(`not found on PATH: ${candidate}`);
  return realpathSync(found);
}

/**
 * Absolute real path + CONTENT digest of the executable an adapter WOULD
 * launch in this environment right now. Hashing the file bytes — not the
 * path string — means a replaced binary at the same path invalidates every
 * receipt. Returns null when the binary is absent so the fixture-only
 * ceiling stands instead of guessing.
 */
export function resolveExecutableDigest(adapterId, { env = {} } = {}) {
  const candidate = resolveAdapterExecutablePath(adapterId, { env });
  if (!candidate) return null;
  try {
    const realPath = locateRealExecutable(candidate, env);
    return { path: realPath, digest: sha256File(realPath) };
  } catch {
    return null;
  }
}

/**
 * Cheap mutable-identity re-probe: ask the resolved executable for its
 * version right now. owned-process runs on THIS runtime, so its version is
 * process.version. Returns null when the binary cannot answer.
 */
export function probeExecutableVersion(adapterId, { env = {} } = {}) {
  if (adapterId === 'owned-process') return process.version;
  const candidate = resolveAdapterExecutablePath(adapterId, { env });
  if (!candidate || candidate === process.execPath) {
    return candidate === process.execPath ? process.version : null;
  }
  try {
    const binPath = candidate.includes('/') ? realpathSync(candidate) : candidate;
    const run = spawnSync(binPath, ['--version'], {
      shell: false,
      encoding: 'utf8',
      timeout: 15_000,
      // Ambient base so shebangs like /usr/bin/env node can resolve; caller
      // overrides still win.
      env: { ...process.env, ...env },
    });
    if (run.error || run.status !== 0) return null;
    return String(run.stdout ?? '').trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

/**
 * Compare a receipt against the CURRENT environment binding. Returns null
 * when every checked property matches, otherwise a lowercase stale reason
 * fragment suitable for user-facing diagnostics.
 */
function sameExecutablePath(firstPath, secondPath) {
  if (firstPath === secondPath) return true;
  try {
    return realpathSync(firstPath) === realpathSync(secondPath);
  } catch {
    return false;
  }
}

export function evaluateReceiptFreshness(receipt, binding) {
  if (!receipt || receipt.schema !== CANARY_RECEIPT_SCHEMA) return 'schema';
  if (receipt.contractVersion !== CANARY_CONTRACT_VERSION) return 'contract';
  const expiry = Date.parse(String(receipt.expiresAt ?? ''));
  if (Number.isNaN(expiry) || expiry <= Date.now()) return 'expiry';
  if (typeof binding.adapterDigest !== 'string' || receipt.adapterDigest !== binding.adapterDigest) return 'adapter';
  // EXACT canonical executable PATH must match too: moving/replacing the
  // binary at a different path invalidates the receipt even when content
  // digests happen to coincide. Symlink ALIASING of the same file is not drift.
  if (binding.executablePath !== undefined && typeof receipt.executablePath === 'string'
    && !sameExecutablePath(receipt.executablePath, binding.executablePath)) return 'executable-path';
  if (!binding.executablePathDigest || receipt.executablePathDigest !== binding.executablePathDigest) return 'executable';
  if (binding.installedVersion === null || receipt.executableVersion !== binding.installedVersion) return 'version';
  if (receipt.runtimeVersion !== binding.runtimeVersion) return 'runtime';
  const required = binding.requiredCapabilities ?? requiredCapabilitiesFor(receipt.adapterId);
  for (const capability of required) {
    if (receipt.capabilities?.[capability] !== 'pass') return `capability:${capability}`;
  }
  return null;
}

function currentBinding(adapterId, { env, behaviorModulesForAdapter, requiredCapabilities, installedVersionOverride }) {
  const adapterDigest = canaryAdapterDigest(adapterId, {
    behaviorModules: behaviorModulesForAdapter?.[adapterId],
  });
  const resolved = resolveExecutableDigest(adapterId, { env });
  return {
    adapterDigest,
    executablePathDigest: resolved?.digest ?? null,
    executablePath: resolved?.path ?? undefined,
    installedVersion: installedVersionOverride ?? probeExecutableVersion(adapterId, { env }),
    runtimeVersion: undefined,
    requiredCapabilities: requiredCapabilities ?? requiredCapabilitiesFor(adapterId),
  };
}

/**
 * Pure promotion decision for a JUST-recorded receipt. `CANARY_PASSED` is
 * emitted ONLY when the receipt re-evaluates as fully canary-proven in THIS
 * environment right now; anything less stays recorded evidence with a typed
 * stale reason and never claims promotion.
 */
export function decideCanaryOutcome({ receipt, binding }) {
  const staleReason = evaluateReceiptFreshness(receipt, binding);
  if (staleReason === null) return { code: 'CANARY_PASSED', promoted: true };
  return { code: 'CANARY_EVIDENCE_RECORDED', promoted: false, staleReason };
}

/**
 * Honest capability surface per known adapter id. Promotion requires a
 * machine-local receipt whose contract version, expiry, adapter behavior
 * digest, executable CONTENT digest, freshly probed executable version and
 * node runtime version all match THIS environment right now — and whose
 * per-capability verdicts cover the required dispatch set with 'pass'.
 */
export function evaluateAdapterMaturities({
  stateRoot,
  env = {},
  runtimeVersion = process.version,
  requiredCapabilities,
  behaviorModulesForAdapter,
} = {}) {
  const receipts = loadCanaryReceipts(stateRoot);
  return CANARY_ADAPTER_IDS.map((adapterId) => {
    const binding = currentBinding(adapterId, {
      env,
      behaviorModulesForAdapter,
      requiredCapabilities,
      installedVersionOverride: adapterId === 'owned-process' ? process.version : undefined,
    });
    binding.runtimeVersion = runtimeVersion;
    const receipt = receipts.find((entry) => entry.adapterId === adapterId) ?? null;
    const staleReason = receipt ? evaluateReceiptFreshness(receipt, binding) : null;
    return {
      id: adapterId,
      maturity: receipt && staleReason === null ? 'canary-proven' : 'fixture-only',
      capabilities: { ...(receipt?.capabilities ?? {}) },
      coveredCapabilities: Object.keys(receipt?.capabilities ?? {}),
      capabilitiesNote: 'alpha surface; see the packaged runtime guide for guarantees',
      ...(receipt
        ? {
          receipt: {
            createdAt: receipt.createdAt,
            expiresAt: receipt.expiresAt,
            contractVersion: receipt.contractVersion,
            scenario: receipt.scenario,
            capabilities: { ...receipt.capabilities },
            staleReason,
            executableVersion: receipt.executableVersion,
            versionDriftRisk: receipt.executableVersion !== receipt.runtimeVersion && adapterId === 'owned-process'
              ? false
              : 're-run the canary after provider upgrades',
          },
        }
        : {}),
    };
  });
}

/**
 * Bound a canary scenario in time. On timeout the registered cancel hook is
 * fully AWAITED before the typed error surfaces, so no owned process or
 * server outlives the harness decision.
 */
export async function runBoundedScenario(label, timeoutMs, work, { onCancel } = {}) {
  let timer = null;
  let timedOut = false;
  try {
    return await new Promise((resolveRun, rejectRun) => {
      timer = setTimeout(() => {
        timedOut = true;
        rejectRun(new AiCliError('CANARY_TIMEOUT', `scenario '${label}' exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      Promise.resolve().then(work).then(resolveRun, rejectRun);
    });
  } catch (error) {
    if (timedOut && typeof onCancel === 'function') {
      await onCancel();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
