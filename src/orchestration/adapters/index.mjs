import { AiCliError } from '../../errors.mjs';
import { GUARANTEE_TIERS, ORCHESTRATION_LIMITS } from '../constants.mjs';
import { canaryAdapterDigest, evaluateReceiptFreshness } from '../canary.mjs';
import { modeRequiresTierSatisfied } from '../contracts.mjs';

export const CAPABILITY_KEYS = Object.freeze([
  'liveEvents',
  'explicitResume',
  'externalAttach',
  'questionChannel',
  'permissionControl',
  'sameTurnSteer',
  'gracefulInterrupt',
  'preToolGate',
  'processOwnership',
  'fileEvents',
  'testEvents',
]);

export const ADAPTER_MATURITY_LEVELS = Object.freeze([
  'unavailable',
  'fixture-only',
  'canary-proven',
]);

const ADAPTER_METHODS = [
  'probe',
  'spawn',
  'attach',
  'subscribe',
  'readSession',
  'sendReply',
  'sendGuidance',
  'resolvePermission',
  'interrupt',
  'close',
  'sanitize',
];

/**
 * Fail-closed adapter validation. Alpha code can never declare `supported`:
 * that requires a later compatibility-range release decision.
 */
export function validateAdapter(adapter) {
  if (typeof adapter !== 'object' || adapter === null || Array.isArray(adapter)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'adapter must be an object', { exitCode: 2 });
  }
  if (typeof adapter.id !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(adapter.id)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'adapter id must be a short kebab-case string', { exitCode: 2 });
  }
  if (!ADAPTER_MATURITY_LEVELS.includes(adapter.maturity)) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `adapter ${adapter.id} maturity must be one of ${ADAPTER_MATURITY_LEVELS.join(', ')}`,
      { exitCode: 2 },
    );
  }
  const capabilities = adapter.capabilities ?? {};
  for (const key of CAPABILITY_KEYS) {
    if (typeof capabilities[key] !== 'boolean') {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        `adapter ${adapter.id} is missing boolean capability ${key}`,
        { exitCode: 2 },
      );
    }
  }
  for (const key of Object.keys(capabilities)) {
    if (!CAPABILITY_KEYS.includes(key)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `unknown adapter capability flag ${key}`, { exitCode: 2 });
    }
  }
  for (const method of ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `adapter ${adapter.id} is missing method ${method}()`, { exitCode: 2 });
    }
  }
  return adapter;
}

/** Validated, immutable adapter registry keyed by adapter id. */
export function createAdapterRegistry(adapters = []) {
  const map = new Map();
  for (const adapter of adapters) {
    validateAdapter(adapter);
    if (map.has(adapter.id)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `duplicate adapter id ${adapter.id}`, { exitCode: 2 });
    }
    map.set(adapter.id, adapter);
  }
  return {
    ids: () => [...map.keys()],
    get: (id) => map.get(id) ?? null,
    require: (id) => {
      const found = map.get(id);
      if (!found) {
        throw new AiCliError('UNSUPPORTED_CAPABILITY', `no orchestration adapter provides '${id}'`, { exitCode: 2 });
      }
      return found;
    },
    entries: () => [...map.values()],
  };
}

/**
 * Stable digest of the adapter's real implementation sources for canary
 * receipt comparison. A behavior-relevant code change invalidates every
 * existing receipt for that adapter.
 */
export function computeAdapterDigest(adapter) {
  return canaryAdapterDigest(adapter.id);
}

/**
 * Evidence-derived maturity, capability-specific by contract. The code
 * declares a fixture-only ceiling; a machine-local canary receipt may raise
 * it to canary-proven only when contract version, expiry, adapter behavior
 * digest, executable CONTENT digest, freshly probed executable version,
 * runtime version AND every required capability verdict all match right now.
 */
export function computeAdapterMaturity(adapter, evidence = null) {
  if (!evidence) return adapter.maturity;
  if (adapter.maturity !== 'fixture-only') return adapter.maturity;

  const receipt = (evidence.canaryReceipts ?? []).find((entry) => entry.adapterId === adapter.id);
  if (!receipt) return adapter.maturity;

  const staleReason = evaluateReceiptFreshness(receipt, {
    adapterDigest: typeof evidence.adapterDigest === 'string'
      ? evidence.adapterDigest
      : computeAdapterDigest(adapter),
    executablePathDigest: evidence.executablePathDigest,
    installedVersion: evidence.installedVersion ?? null,
    runtimeVersion: evidence.runtimeVersion ?? process.version,
    requiredCapabilities: evidence.requiredCapabilities,
  });
  return staleReason === null ? 'canary-proven' : adapter.maturity;
}

/**
 * Dispatch-time mode/tier compatibility gate. `attached-observer` never
 * satisfies mutable supervised modes and `unsupported` can never dispatch.
 */
export function assertModeTierCompatible(mode, guaranteeTier, { mutable = true } = {}) {
  if (!GUARANTEE_TIERS.includes(guaranteeTier)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `unknown guarantee tier ${String(guaranteeTier)}`, { exitCode: 2 });
  }
  if (guaranteeTier === 'unsupported') {
    throw new AiCliError('POLICY_DENIED', 'guarantee tier unsupported can never create a Dispatch');
  }
  if (mutable && !modeRequiresTierSatisfied(mode, guaranteeTier)) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      `mode ${mode} is not satisfied by guarantee tier ${guaranteeTier}`,
      { exitCode: 2 },
    );
  }
  return true;
}

export function maxAcceptanceCommands() {
  return ORCHESTRATION_LIMITS.maxAcceptanceCommands;
}

/**
 * Build the default validated registry for a supervisor. Callers decide which
 * adapters to include; nothing is auto-registered, so adapter-backed dispatch
 * keeps failing closed until an explicit, validated adapter exists.
 */
export function createDefaultOrchestrationAdapters({ ownedProcess = null } = {}) {
  const adapters = [];
  if (ownedProcess) adapters.push(ownedProcess);
  return createAdapterRegistry(adapters);
}
