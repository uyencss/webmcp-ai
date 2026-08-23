import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AiCliError } from '../errors.mjs';

export const CANARY_RECEIPT_SCHEMA = 'webmcp.ai-canary-receipt/v0';
export const CANARY_ADAPTER_IDS = Object.freeze([
  'owned-process',
  'opencode-server',
  'claude-stream',
  'codex-exec',
]);

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/** Stable adapter identity digest; mirrors computeAdapterDigest without instantiation. */
export function canaryAdapterDigest(adapterId) {
  return sha256Text(`${adapterId}:fixture-only`);
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

export function recordCanaryReceipt(stateRoot, receipt) {
  const required = [
    'adapterId', 'adapterDigest', 'executablePathDigest', 'executablePath',
    'executableVersion', 'runtimeVersion', 'scenario',
  ];
  for (const field of required) {
    if (typeof receipt?.[field] !== 'string' || receipt[field].length === 0) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `canary receipt requires ${field}`, { exitCode: 2 });
    }
  }
  if (!CANARY_ADAPTER_IDS.includes(receipt.adapterId)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `unknown canary adapter ${receipt.adapterId}`, { exitCode: 2 });
  }
  const normalized = Object.freeze({
    schema: CANARY_RECEIPT_SCHEMA,
    authorizedBy: 'operator dual opt-in',
    createdAt: new Date().toISOString(),
    ...receipt,
    adapterDigest: canaryAdapterDigest(receipt.adapterId),
  });
  const target = canaryReceiptPath(stateRoot, normalized.adapterId);
  mkdirSync(canaryDirectory(stateRoot), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify(normalized, null, 1)}\n`, { mode: 0o600 });
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
 * Absolute real path + digest of the executable an adapter WOULD launch in
 * this environment right now. Returns null when the binary is absent so the
 * fixture-only ceiling stands instead of guessing.
 */
export function resolveExecutableDigest(adapterId, { env = {} } = {}) {
  const candidate = resolveAdapterExecutablePath(adapterId, { env });
  if (!candidate) return null;
  try {
    const realPath = locateRealExecutable(candidate, env);
    return { path: realPath, digest: sha256Text(realPath) };
  } catch {
    return null;
  }
}

function currentExecutablePathDigest(adapterId, { env }) {
  return resolveExecutableDigest(adapterId, { env })?.digest ?? null;
}

/**
 * Honest capability surface per known adapter id. Promotion to canary-proven
 * requires a machine-local receipt whose adapter digest, resolved executable
 * path digest and node runtime version all match THIS environment right now.
 * The recorded provider version is displayed for drift awareness; dispatch
 * time re-verifies strictly through computeAdapterMaturity with probed
 * evidence.
 */
export function evaluateAdapterMaturities({ stateRoot, env = {}, runtimeVersion = process.version } = {}) {
  const receipts = loadCanaryReceipts(stateRoot);
  return CANARY_ADAPTER_IDS.map((adapterId) => {
    const adapterDigest = canaryAdapterDigest(adapterId);
    const executablePathDigest = currentExecutablePathDigest(adapterId, { env });
    const receipt = receipts.find((entry) => entry.adapterId === adapterId) ?? null;
    const promoted = Boolean(
      receipt
      && receipt.adapterDigest === adapterDigest
      && executablePathDigest !== null
      && receipt.executablePathDigest === executablePathDigest
      && receipt.runtimeVersion === runtimeVersion,
    );
    return {
      id: adapterId,
      maturity: promoted ? 'canary-proven' : 'fixture-only',
      capabilitiesNote: 'alpha surface; see the packaged runtime guide for guarantees',
      ...(receipt
        ? {
          receipt: {
            createdAt: receipt.createdAt,
            scenario: receipt.scenario,
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
