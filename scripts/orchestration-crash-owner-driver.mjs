#!/usr/bin/env node
// Crash-window fault-injection driver: boots a REAL in-process supervisor
// with one fixture-backed provider adapter, seeds one task, and starts a
// dispatch. The supervisor's own WEBMCP_AI_TEST_CRASH_AFTER_SPAWN hook then
// SIGKILLs this driver EXACTLY inside the post-spawn/pre-return handshake
// window, so durable crash-state can be asserted by the harness.
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveEndpoint, requestIpc } from '../src/orchestration/ipc.mjs';
import { readClientCapability } from '../src/orchestration/authority.mjs';
import { ORCHESTRATION_PROTOCOL } from '../src/orchestration/constants.mjs';
import { resolveOrchestrationRoots } from '../src/orchestration/paths.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import {
  asPublicAdapter,
  createPublicLifecycle,
  createTrustedCoordinatorConfig,
} from '../src/orchestration/public-adapters.mjs';
import { createOwnedProcessAdapter } from '../src/orchestration/adapters/owned-process.mjs';
import { createClaudeStreamAdapter } from '../src/orchestration/adapters/claude-stream.mjs';
import { createCodexExecAdapter } from '../src/orchestration/adapters/codex-exec.mjs';
import { createOpenCodeServerAdapter } from '../src/orchestration/adapters/opencode-server.mjs';

const FIXTURES_DIR = new URL('../tests/fixtures/orchestration/', import.meta.url).pathname;

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 || index + 1 >= process.argv.length ? null : process.argv[index + 1];
}

const stateDir = readArg('--state-dir');
const coordinationId = readArg('--coordination-id');
const fixture = readArg('--fixture');
const workspace = readArg('--workspace');
// --hold 1: keep the owner ALIVE after dispatch.start returns; the harness
// SIGKILLs it externally to simulate a crash AFTER the runtime binding was
// durably recorded (as opposed to the pre-binding handshake window).
const holdOwner = readArg('--hold') === '1';

if (!stateDir || !coordinationId || !fixture || !workspace) {
  process.stderr.write('usage: crash-owner-driver --state-dir DIR --coordination-id ID --fixture KIND --workspace DIR\n');
  process.exit(2);
}

const baseConfig = {
  stateDir,
  allowFixtureDispatch: true,
  confinement: 'disposable-workspace',
  disposableRoot: tmpdir(),
};

let kind = fixture;
let inner;
if (fixture === 'owned') {
  kind = 'owned-process';
  inner = createOwnedProcessAdapter({ stateDir });
  Object.assign(baseConfig, {
    ownedProcessCommand: {
      command: process.execPath,
      args: [join(FIXTURES_DIR, 'fake-worker.mjs')],
      env: { ...process.env, FAKE_WORKER_MODE: 'hold-silent' },
    },
  });
} else if (fixture === 'claude') {
  kind = 'claude-stream';
  inner = createClaudeStreamAdapter({
    stateDir,
    claudeBin: process.execPath,
    claudeArgs: [join(FIXTURES_DIR, 'fake-claude.mjs')],
    fakeModeEnv: {
      FAKE_CLAUDE_MODE: 'trap-signals',
      FAKE_CLAUDE_TRAP_MS: String(Number(process.env.FAKE_CLAUDE_TRAP_MS ?? 20_000)),
      FAKE_QUIET: '1',
    },
  });
} else if (fixture === 'codex') {
  kind = 'codex-exec';
  inner = createCodexExecAdapter({
    stateDir,
    codexBin: process.execPath,
    codexArgs: [join(FIXTURES_DIR, 'fake-codex.mjs')],
    fakeModeEnv: { FAKE_CODEX_MODE: 'hold', FAKE_QUIET: '1' },
  });
} else if (fixture === 'opencode') {
  kind = 'opencode-server';
  inner = createOpenCodeServerAdapter({
    stateDir,
    openCodeBin: process.execPath,
    openCodeArgs: [join(FIXTURES_DIR, 'fake-opencode-server.mjs')],
    fakeQuietForTest: true,
  });
} else {
  process.stderr.write(`unknown fixture ${fixture}\n`);
  process.exit(2);
}

const config = createTrustedCoordinatorConfig(baseConfig);
const adapter = asPublicAdapter(inner, createPublicLifecycle(kind, inner, config));

const sup = await createSupervisor({
  env: {
    ...process.env,
    WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir,
    ...(holdOwner ? {} : { WEBMCP_AI_TEST_CRASH_AFTER_SPAWN: '*' }),
  },
  mode: 'create',
  coordinationId,
  adapters: [adapter],
  trustedCoordinatorConfig: config,
});

process.stdout.write(`${JSON.stringify({
  ready: true,
  coordinationId: sup.coordinationId,
  fenceEpoch: sup.fenceEpoch,
  endpoint: deriveEndpoint({
    ipcRoot: join(resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } }).stateRoot, 'ipc'),
    coordinationId,
    platform: process.platform,
  }),
})}\n`);

const call = (operation, input) => requestIpc(
  deriveEndpoint({
    ipcRoot: join(resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } }).stateRoot, 'ipc'),
    coordinationId,
    platform: process.platform,
  }),
  {
    protocol: ORCHESTRATION_PROTOCOL,
    requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
    coordinationId,
    fenceEpoch: sup.__store.state.fenceEpoch,
    capability: readClientCapability({ coordinationDir: join(resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } }).stateRoot, 'coordinations', coordinationId) }),
    operation,
    input,
  },
  { timeoutMs: 15_000 },
);

const created = await call('task.create', {
  packet: {
    objective: 'crash-window',
    workspace,
    allowedReadRoots: [],
    allowedWriteRoots: [],
  },
});
if (!created.ok) {
  process.stderr.write(`task.create failed: ${JSON.stringify(created.error)}\n`);
  process.exit(3);
}
process.stdout.write(`${JSON.stringify({ taskId: created.result.taskId })}\n`);
const startResult = await call('dispatch.start', { taskId: created.result.taskId, adapterId: kind });
if (holdOwner) {
  if (!startResult.ok) {
    process.stderr.write(`dispatch.start failed: ${JSON.stringify(startResult.error)}\n`);
    process.exit(3);
  }
  process.stdout.write(`${JSON.stringify({ started: true, dispatchId: startResult.result.dispatchId })}\n`);
  // Hold until the harness SIGKILLs us — the spawned worker survives.
  setInterval(() => {}, 1_000);
}

// The crash hook fires mid-dispatch.start; if it somehow did not, park here
// so the harness observes a loud timeout instead of a silent false green.
setInterval(() => {}, 1_000);
