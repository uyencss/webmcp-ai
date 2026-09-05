import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  COORDINATOR_DISPATCHER_IMPLEMENTATION,
  COORDINATOR_DISPATCHER_MARKER,
  COORDINATOR_DISPATCHER_SCHEMA,
  HOST_ISOLATION_DISPATCHER_UNTRUSTED,
} from '../src/orchestration/managed-host/host-isolation.mjs';
import { createSupervisor } from '../src/orchestration/public-entry.mjs';

function markCoordinatorDispatcher(dispatch) {
  const marker = Object.freeze({
    owner: 'coordinator',
    schema: COORDINATOR_DISPATCHER_SCHEMA,
    implementation: COORDINATOR_DISPATCHER_IMPLEMENTATION,
    dispatch,
  });
  Object.defineProperty(dispatch, COORDINATOR_DISPATCHER_MARKER, {
    value: marker,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(dispatch);
}

function isolatedEnv(t, name) {
  const stateDir = mkdtempSync(join(tmpdir(), `webmcp-ai-public-${name}-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  return { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir };
}

test('public orchestration entry exports the supervisor boundary', async () => {
  const entry = await import('../src/orchestration/public-entry.mjs');
  assert.equal(typeof entry.createOrchestrationClient, 'function');
  assert.equal(typeof entry.getOrchestrationCapabilities, 'function');
  assert.equal(typeof entry.isOrchestrationDisabled, 'function');
  assert.equal(typeof entry.createSupervisor, 'function');
});

test('public supervisor preserves default non-coordinator behavior', async (t) => {
  const supervisor = await createSupervisor({
    env: isolatedEnv(t, 'default'),
    mode: 'create',
    coordinationId: 'coord_public_default',
  });
  assert.equal(supervisor.coordinationId, 'coord_public_default');
  await supervisor.stop();
});

test('public supervisor accepts only the construction-marked coordinator dispatcher', async (t) => {
  const dispatcher = markCoordinatorDispatcher(async () => ({ ok: true }));
  const supervisor = await createSupervisor({
    env: isolatedEnv(t, 'dispatcher'),
    mode: 'create',
    coordinationId: 'coord_public_dispatcher',
    coordinatorDispatcher: dispatcher,
  });
  assert.equal(supervisor.coordinationId, 'coord_public_dispatcher');
  await supervisor.stop();
});

test('public supervisor rejects an arbitrary callback before supervisor ownership', async () => {
  await assert.rejects(
    () => createSupervisor({ coordinatorDispatcher: async () => ({ ok: true }) }),
    (error) => error?.code === HOST_ISOLATION_DISPATCHER_UNTRUSTED,
  );
});

test('public supervisor rejects non-plain option containers', async () => {
  await assert.rejects(
    () => createSupervisor([]),
    (error) => error?.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});
