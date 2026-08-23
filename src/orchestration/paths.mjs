import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { AiCliError } from '../errors.mjs';
import { ID_PREFIXES } from './constants.mjs';

function refuseIfSymlink(dirPath) {
  try {
    const stats = lstatSync(dirPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new AiCliError('POLICY_DENIED', `refusing unsafe state directory: ${basename(dirPath)}`, {
        exitCode: 2,
      });
    }
  } catch (error) {
    if (error instanceof AiCliError) throw error;
    // ENOENT: nothing exists yet; creation proceeds.
    return;
  }
}

const STATE_DIR_OVERRIDE = 'WEBMCP_AI_ORCHESTRATION_STATE_DIR';

function defaultStateRoot(platform, env, homeDir) {
  switch (platform) {
    case 'darwin':
      return join(homeDir, 'Library', 'Application Support', 'webmcp-ai', 'orchestration');
    case 'linux':
      return join(env.XDG_STATE_HOME || join(homeDir, '.local', 'state'), 'webmcp-ai', 'orchestration');
    case 'win32':
      return join(env.LOCALAPPDATA || join(homeDir, 'AppData', 'Local'), 'webmcp-ai', 'orchestration');
    default:
      throw new AiCliError(
        'ORCHESTRATION_UNSUPPORTED_VERSION',
        `platform ${platform} has no orchestration state root in this alpha`,
        { exitCode: 2 },
      );
  }
}

/**
 * Resolve machine-local orchestration roots. The state root lives outside
 * repositories, /tmp and provider stores. The only override is the explicit
 * WEBMCP_AI_ORCHESTRATION_STATE_DIR used by tests/operators.
 */
export function resolveOrchestrationRoots({ env = {}, platform = process.platform, homeDir } = {}) {
  const home = homeDir ?? homedir();
  const override = typeof env[STATE_DIR_OVERRIDE] === 'string' && env[STATE_DIR_OVERRIDE].trim()
    ? resolve(env[STATE_DIR_OVERRIDE])
    : null;
  const stateRoot = override ?? defaultStateRoot(platform, env, home);
  if (!isAbsolute(stateRoot)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'orchestration state root must be absolute', {
      exitCode: 2,
    });
  }
  return Object.freeze({
    stateRoot,
    coordinationsRoot: join(stateRoot, 'coordinations'),
    ipcRoot: join(stateRoot, 'ipc'),
  });
}

function ensurePrivateDir(dirPath) {
  refuseIfSymlink(dirPath);
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const stats = lstatSync(dirPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AiCliError('POLICY_DENIED', `refusing unsafe state directory: ${basename(dirPath)}`, {
      exitCode: 2,
    });
  }
  // Canonicalize against the resolved parent so no symlinked segment can
  // redirect coordination state elsewhere after creation.
  const real = realpathSync(dirPath);
  const expectedReal = join(realpathSync(dirname(dirPath)), basename(dirPath));
  if (real !== expectedReal) {
    throw new AiCliError('POLICY_DENIED', 'state directory resolution mismatch', { exitCode: 2 });
  }
}

export function ensureOrchestrationRoots(roots) {
  ensurePrivateDir(roots.stateRoot);
  ensurePrivateDir(roots.coordinationsRoot);
  return roots;
}

export function createCoordinationLayout(stateRoot, coordinationId) {
  if (typeof coordinationId !== 'string' || !coordinationId.startsWith(ID_PREFIXES.coordination)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'coordination id must use the coord_ prefix', {
      exitCode: 2,
    });
  }
  const coordinationDir = join(stateRoot, 'coordinations', coordinationId);
  ensurePrivateDir(coordinationDir);
  const refsDir = join(coordinationDir, 'refs');
  ensurePrivateDir(refsDir);
  return Object.freeze({
    coordinationDir,
    manifestPath: join(coordinationDir, 'manifest.json'),
    journalPath: join(coordinationDir, 'events.jsonl'),
    snapshotPath: join(coordinationDir, 'snapshot.json'),
    refsDir,
    lockPath: join(coordinationDir, 'supervisor.lock'),
  });
}
