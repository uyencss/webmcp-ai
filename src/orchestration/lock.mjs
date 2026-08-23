import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';

import { AiCliError } from '../errors.mjs';
import { createPlatformIdentityDeps, readProcessIdentity } from './process-identity.mjs';

function readLockFile(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

async function inspectPidLiveness(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return { alive: false, startIdentity: null };
    return null;
  }
  const identity = await readProcessIdentity(pid, createPlatformIdentityDeps());
  if (!identity) return null;
  return { alive: true, startIdentity: identity.startIdentity };
}

/**
 * Acquire the exclusive supervisor lock with open('wx'). A live owner with a
 * proven matching start identity blocks acquisition; an indeterminate owner
 * also blocks (never unlink while live/indeterminate). Dead or reused PIDs are
 * archived to an audit sibling before retry.
 */
export async function acquireSupervisorLock(layout, identity, deps = {}) {
  if (
    !Number.isFinite(identity.pid)
    || typeof identity.startIdentity !== 'string'
    || typeof identity.runtimeNonce !== 'string'
    || !Number.isFinite(identity.processGeneration)
  ) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'supervisor identity is incomplete', { exitCode: 2 });
  }
  const inspectPid = deps.inspectPid ?? inspectPidLiveness;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = openSync(layout.lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      const existing = readLockFile(layout.lockPath);
      if (!existing?.identity?.pid) {
        renameSync(layout.lockPath, `${layout.lockPath}.stale`);
        continue;
      }
      const proof = await inspectPid(existing.identity.pid);
      if (proof == null) {
        throw new AiCliError(
          'COORDINATION_LOCKED',
          'existing supervisor lock cannot be proven stale; refusing takeover',
        );
      }
      if (proof.alive && proof.startIdentity === existing.identity.startIdentity) {
        throw new AiCliError(
          'COORDINATION_LOCKED',
          `a live supervisor (pid ${existing.identity.pid}) already owns this coordination`,
        );
      }
      renameSync(layout.lockPath, `${layout.lockPath}.stale`);
      continue;
    }
    try {
      const payload = `${JSON.stringify({
        schema: 'webmcp.ai-supervisor-lock/v0',
        identity,
        acquiredAt: new Date().toISOString(),
      })}\n`;
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { layout, path: layout.lockPath, identity, released: false };
  }

  throw new AiCliError('COORDINATION_LOCKED', 'could not acquire the supervisor lock');
}

/**
 * Release requires the exact runtime nonce of the recorded owner. Non-owner
 * releases are rejected without touching the lock file.
 */
export async function releaseSupervisorLock(lock, presentedNonce) {
  if (!lock || lock.released) return true;
  const recorded = readLockFile(lock.path);
  if (!recorded?.identity?.runtimeNonce || recorded.identity.runtimeNonce !== presentedNonce) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'non-owner attempted to release the supervisor lock',
    );
  }
  unlinkSync(lock.path);
  lock.released = true;
  return true;
}
