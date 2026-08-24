import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AiCliError } from '../errors.mjs';
import { ORCHESTRATION_PROTOCOL } from './constants.mjs';
import {
  createPublicAdapters,
  createTrustedCoordinatorConfig,
  loadTrustedCoordinatorConfigFile,
  loadTrustedAdapterRegistry,
} from './public-adapters.mjs';
import { createSupervisor } from './supervisor.mjs';

const BOOTSTRAP_OWNER_FIELDS = new Set(['host', 'instanceId']);

function readArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

/**
 * Strict bootstrap contract: the only accepted payload is
 * `{ "owner": { "host"?, "instanceId"? } | null }`. Anything else — invalid
 * JSON, unknown fields, non-object shapes, wrong descriptor types — fails
 * closed with a typed ORCHESTRATION_INVALID_INPUT before any state is touched.
 */
export function parseBootstrapInput(raw) {
  if (raw === null || raw === undefined || !String(raw).trim()) {
    return { owner: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'bootstrap input is not valid JSON', { exitCode: 2 });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'bootstrap input must be a JSON object', { exitCode: 2 });
  }
  for (const key of Object.keys(parsed)) {
    if (key !== 'owner') {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `bootstrap input has unknown field ${key}`, { exitCode: 2 });
    }
  }
  let owner = null;
  if (parsed.owner !== undefined && parsed.owner !== null) {
    const candidate = parsed.owner;
    if (typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'bootstrap owner must be an object or null', { exitCode: 2 });
    }
    owner = {};
    for (const key of Object.keys(candidate)) {
      if (!BOOTSTRAP_OWNER_FIELDS.has(key)) {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `bootstrap owner has unknown field ${key}`, { exitCode: 2 });
      }
      const value = candidate[key];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `bootstrap owner.${key} must be a string`, { exitCode: 2 });
      }
      if (typeof value === 'string') owner[key] = value.slice(0, 128);
    }
  }
  return { owner };
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

// Signal handlers are installed before any ownership work so a terminate
// racing bootstrap can never default-exit while the singleton lock is held.
let activeSupervisor = null;
let shuttingDown = false;
let shutdownRequested = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (activeSupervisor) await activeSupervisor.stop();
  } catch {
    // A failed release leaves the audit lock; recovery archives it.
  }
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdownRequested = true;
  if (activeSupervisor) void shutdown();
});
process.on('SIGINT', () => {
  shutdownRequested = true;
  if (activeSupervisor) void shutdown();
});

async function main() {
  const mode = readArgValue('--mode') ?? 'create';
  const coordinationId = readArgValue('--coordination-id');

  // Bootstrap metadata arrives on stdin (owner descriptors only); tokens,
  // prompts and passwords never enter argv. The launching parent ends stdin
  // immediately after the validated payload, so this read always terminates.
  let rawBootstrap = '';
  try {
    rawBootstrap = readFileSync(0, 'utf8');
  } catch (error) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `bootstrap stdin is unreadable: ${error?.code ?? 'ERROR'}`, { exitCode: 2 });
  }
  const bootstrap = parseBootstrapInput(rawBootstrap);

  // Adapter assembly is coordinator-owned machine-local configuration. The
  // packaged supervisor stays fail-closed (no adapters) unless operators opt
  // in through WEBMCP_AI_ORCHESTRATION_PUBLIC_ADAPTERS=1; fixture overrides
  // additionally require WEBMCP_AI_ORCHESTRATION_TEST_FIXTURES=1.
  //
  // Confinement policy, disposable roots and launch commands NEVER arrive via
  // Task payloads or IPC frames: they come exclusively from a mode-0600
  // machine-local config file named by WEBMCP_AI_ORCHESTRATION_TRUSTED_CONFIG
  // (plus, optionally, a trusted adapter registry file for generic
  // owned-process launches).
  let adapters = [];
  let trustedConfig = null;
  if (process.env.WEBMCP_AI_ORCHESTRATION_PUBLIC_ADAPTERS === '1') {
    const allowFixtures = process.env.WEBMCP_AI_ORCHESTRATION_TEST_FIXTURES === '1';
    const fileConfig = process.env.WEBMCP_AI_ORCHESTRATION_TRUSTED_CONFIG
      ? loadTrustedCoordinatorConfigFile(process.env.WEBMCP_AI_ORCHESTRATION_TRUSTED_CONFIG)
      : null;
    const registryEntry = process.env.WEBMCP_AI_ORCHESTRATION_TRUSTED_ADAPTERS
      ? (loadTrustedAdapterRegistry(process.env.WEBMCP_AI_ORCHESTRATION_TRUSTED_ADAPTERS).adapters
        .find((adapterEntry) => adapterEntry.id === 'owned-process') ?? null)
      : null;
    // File-granted fields override ambient defaults; opt-in flags stay
    // environment-only and can NEVER be granted by any file.
    const configOptions = {
      ...fileConfig,
      env: process.env,
      stateDir: fileConfig?.stateDir
        ?? process.env.WEBMCP_AI_ORCHESTRATION_STATE_DIR
        ?? join(homedir(), '.webmcp-ai', 'orchestration-state'),
      allowFixtureDispatch: allowFixtures,
      allowUnprovenProviderDispatch: false,
    };
    if (!configOptions.ownedProcessCommand && registryEntry) {
      configOptions.ownedProcessCommand = {
        command: registryEntry.command,
        args: registryEntry.args,
        env: registryEntry.env,
      };
    }
    trustedConfig = createTrustedCoordinatorConfig(configOptions);
    adapters = createPublicAdapters(trustedConfig);
  }

  activeSupervisor = await createSupervisor({
    env: process.env,
    mode,
    ...(coordinationId ? { coordinationId } : {}),
    manifest: { owner: bootstrap.owner },
    ...(adapters.length > 0 ? { adapters, trustedCoordinatorConfig: trustedConfig } : {}),
  });

  emit({
    ok: true,
    protocol: ORCHESTRATION_PROTOCOL,
    coordinationId: activeSupervisor.coordinationId,
    fenceEpoch: activeSupervisor.fenceEpoch,
    processGeneration: activeSupervisor.processGeneration,
  });

  if (shutdownRequested) {
    await shutdown();
  }
}

// The entry auto-executes only as the launched main module. Importing it for
// unit inspection (bootstrap contract tests, harnesses) must never spawn a
// supervisor as an import side effect.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    if (process.env.WEBMCP_AI_BOOTSTRAP_TRACE && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    emit({
      ok: false,
      protocol: ORCHESTRATION_PROTOCOL,
      error: {
        code: error.code ?? 'ORCHESTRATION_INDETERMINATE',
        message: error.message,
      },
    });
    process.exit(error.exitCode ?? 1);
  });
}
