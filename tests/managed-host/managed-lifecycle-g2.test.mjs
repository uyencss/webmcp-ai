import assert from 'node:assert/strict';
import { chmodSync, renameSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { spawn as spawnProcess, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  HOST_ISOLATION_MODE,
  HOST_ISOLATION_BROKER_IMPLEMENTATION,
  HOST_ISOLATION_LAUNCH_BOUNDARY,
  HOST_ISOLATION_PRIMITIVE_UNAVAILABLE,
  buildSeatbeltLaunchSpec,
  createMediatedToolBroker,
  normalizeHostIsolationConfig,
  assertHostIsolationPrimitive,
} from '../../src/orchestration/managed-host/host-isolation.mjs';
import {
  asPublicAdapter,
  createPublicLifecycle,
  createTrustedCoordinatorConfig,
  isTrustedManagedLifecycle,
} from '../../src/orchestration/public-adapters.mjs';
import { createOwnedProcessAdapter, isTrustedOwnedProcessAdapter } from '../../src/orchestration/adapters/owned-process.mjs';
import { createSupervisor } from '../../src/orchestration/supervisor.mjs';
import { buildEntryPlan } from '../../src/orchestration/managed-host/entry-plan.mjs';
import { ENTRY_POLICY_REVISION } from '../../src/orchestration/managed-host/capability-profile.mjs';
import { DEFAULT_ROLE_POLICY, computePolicyDigest } from '../../src/orchestration/role-policy.mjs';
import { MANAGED_BINDING_SCHEMA } from '../../src/orchestration/managed-binding.mjs';
import { ORCHESTRATION_ERROR_CODES, ORCHESTRATION_PROTOCOL, PERMISSION_REQUIRED, TASK_PACKET_PROTOCOL_V1_R2 } from '../../src/orchestration/constants.mjs';
import { readClientCapability } from '../../src/orchestration/authority.mjs';
import { deriveEndpoint, requestIpc } from '../../src/orchestration/ipc.mjs';
import { resolveOrchestrationRoots } from '../../src/orchestration/paths.mjs';

const ROLE_REVISION = computePolicyDigest(DEFAULT_ROLE_POLICY);

function makeBinding() {
  return {
    schema: MANAGED_BINDING_SCHEMA,
    bindingId: 'bind_e7_g2_writer_01',
    adapterId: 'owned-process',
    provider: 'test-provider',
    model: 'test-model-1',
    effort: 'high',
    variant: 'default',
    agent: 'writer-agent',
    capabilityTier: ['write-code'],
    eligibleRoles: ['writer', 'observer'],
    deniedRoles: ['coordinator'],
    expiresAt: Date.now() + 3600_000,
    calibrationEvidenceDigest: `sha256:${'1'.repeat(64)}`,
    approvalDigest: `sha256:${'2'.repeat(64)}`,
    revision: 1,
    executableIdentityDigest: `sha256:${'3'.repeat(64)}`,
  };
}

function makeWorkspace(t, name, { outsideRoot = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), `e7-g2-${name}-`));
  const workspace = join(root, 'workspace');
  const writeRoot = join(workspace, 'out');
  const outside = outsideRoot ?? join(root, 'outside');
  mkdirSync(writeRoot, { recursive: true });
  mkdirSync(outside, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (outsideRoot) t.after(() => rmSync(outsideRoot, { recursive: true, force: true }));
  return { root, workspace, writeRoot, outside };
}

function managedPacket(workspace, writeRoot, objective = 'E7-G2 managed lifecycle') {
  return {
    packetVersion: TASK_PACKET_PROTOCOL_V1_R2,
    objective,
    workspace,
    allowedReadRoots: [workspace],
    allowedWriteRoots: [writeRoot],
    protectedPaths: [],
    role: 'writer',
    riskTier: 'low',
    modelRequirements: { minimumAssurance: 'code-bounded', requiredCapabilities: ['write-code'] },
    rolePolicyRevision: ROLE_REVISION,
    modelBindingRevision: 1,
    bindingRevision: 1,
    fallbackPolicy: { mode: 'explicit-only', allowedBindingIds: [] },
    independencePolicy: { readOnly: false, mustNotMatchDispatchIds: [], mustNotContributeToLineage: false },
  };
}

function trustedEntryEvidence() {
  const plan = buildEntryPlan({
    entryState: 'ENTRY_READY',
    projectPolicyLoaded: true,
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: ROLE_REVISION,
  });
  return {
    entryState: 'ENTRY_READY',
    projectPolicyLoaded: true,
    entryPolicyRevision: ENTRY_POLICY_REVISION,
    rolePolicyRevision: ROLE_REVISION,
    capabilityProfileRevision: plan.capabilityProfileRevision,
  };
}

function makeCaller({ stateDir, coordinationId, sup, roots }) {
  return (operation, input) => requestIpc(
    deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId }),
    {
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: `req_${createHash('sha256').update(`${operation}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 10)}`,
      coordinationId,
      fenceEpoch: sup.__store.state.fenceEpoch,
      capability: readClientCapability({ coordinationDir: join(roots.stateRoot, 'coordinations', coordinationId) }),
      operation,
      input,
    },
    { timeoutMs: 20_000 },
  );
}

async function startManagedSupervisor(t, name, { config, env = {}, adapters = null, binding = makeBinding() } = {}) {
  const stateDir = config.stateDir;
  const coordinationId = `coord_e7_g2_${name}_${Date.now()}`;
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const inner = createOwnedProcessAdapter({ stateDir });
  const adapter = adapters ?? asPublicAdapter(inner, createPublicLifecycle('owned-process', inner, config));
  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir, ...env },
    mode: 'create',
    coordinationId,
    adapters: [adapter],
    trustedCoordinatorConfig: config,
    managedBinding: binding,
    rolePolicy: DEFAULT_ROLE_POLICY,
    trustedEntryEvidence: trustedEntryEvidence(),
  });
  t.after(() => sup.stop());
  return { sup, adapter, coordinationId, roots, call: makeCaller({ stateDir, coordinationId, sup, roots }) };
}

async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForSettled(sup, dispatchId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sup.__store.state.dispatches[dispatchId]?.state === 'settled') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`dispatch ${dispatchId} did not settle: ${sup.__store.state.dispatches[dispatchId]?.state}`);
}

function errorCode(value) {
  return value?.error?.code ?? value?.code;
}

function coordinatorBroker(allowedTools = ['webmcp.echo']) {
  return {
    implementation: HOST_ISOLATION_BROKER_IMPLEMENTATION,
    allowedTools,
  };
}

const TRUSTED_COORDINATOR_CONFIG_SCHEMA = 'webmcp.ai-trusted-coordinator-config/v1';
const PUBLIC_G2_ERROR_CODES = Object.freeze([
  PERMISSION_REQUIRED,
  'HOST_ISOLATION_PRIMITIVE_UNAVAILABLE',
  'HOST_ISOLATION_BROKER_REQUIRED',
  'HOST_ISOLATION_LIFECYCLE_UNTRUSTED',
  'HOST_ISOLATION_UNSAFE_WORKSPACE',
  'HOST_ISOLATION_BOUNDARY_MISMATCH',
  'BROKER_PROTOCOL_ERROR',
  'UNLISTED_MCP_TOOL_DENIED',
  'HOST_ISOLATION_AUTHORITY_BYPASS',
]);

function brokerRequest(socket, request) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    let settled = false;
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      try {
        finishResolve(JSON.parse(buffered.slice(0, newline)));
      } catch (error) {
        finishReject(error);
      }
    };
    const onError = (error) => finishReject(error);
    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

async function waitForFirstJsonLine(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for packaged supervisor bootstrap${stderr ? `: ${stderr.trim().slice(-2000)}` : ''}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onData = (chunk) => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      cleanup();
      try {
        resolve(JSON.parse(buffered.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`packaged supervisor exited before bootstrap (${code ?? signal})${stderr ? `: ${stderr.trim().slice(-2000)}` : ''}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onStderr = (chunk) => {
      stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

test('G2 host isolation config is explicit and never silently falls back to G1', () => {
  assert.equal(normalizeHostIsolationConfig(null), null);
  assert.deepEqual(normalizeHostIsolationConfig({ mode: HOST_ISOLATION_MODE }), { mode: HOST_ISOLATION_MODE });
  assert.throws(() => normalizeHostIsolationConfig({ mode: 'darwin-seatbelt' }), (error) => error.code === 'ORCHESTRATION_INVALID_INPUT');
  assert.throws(() => normalizeHostIsolationConfig({ mode: HOST_ISOLATION_MODE, permit: 'secret' }), (error) => error.code === 'ORCHESTRATION_INVALID_INPUT');
  assert.throws(() => normalizeHostIsolationConfig({ mode: HOST_ISOLATION_MODE, broker: { allowedTools: ['webmcp.echo'] } }), (error) => error.code === 'HOST_ISOLATION_BROKER_REQUIRED');
  assert.throws(() => normalizeHostIsolationConfig({ mode: HOST_ISOLATION_MODE, broker: { allowedTools: ['webmcp.echo'], invoke() {} } }), (error) => error.code === 'ORCHESTRATION_INVALID_INPUT');
  assert.deepEqual(
    normalizeHostIsolationConfig({ mode: HOST_ISOLATION_MODE, broker: coordinatorBroker() }),
    { mode: HOST_ISOLATION_MODE, broker: coordinatorBroker() },
  );

  assert.throws(() => assertHostIsolationPrimitive({ platform: 'linux', sandboxExecPath: null }), (error) => {
    assert.equal(error.code, HOST_ISOLATION_PRIMITIVE_UNAVAILABLE);
    return true;
  });
});

test('installed packaged supervisor-entry performs a real FD3 webmcp.echo round trip', { timeout: 120_000 }, async (t) => {
  // Keep the installed entry under the canonical /Users path. macOS exposes
  // /var through /private/var; Node's import.meta.url realpath can therefore
  // differ from process.argv[1] and make supervisor-entry correctly refuse
  // to auto-execute as a main module.
  const root = mkdtempSync(join(process.cwd(), '.e7-g2-packaged-'));
  const packRoot = join(root, 'pack');
  const consumerRoot = join(root, 'consumer');
  // Keep the Unix-domain socket root short enough for Darwin's pathname
  // limit; the installed package and disposable workspace remain under the
  // candidate so supervisor-entry still executes from the packaged topology.
  const stateDir = mkdtempSync(join(tmpdir(), 'e7-g2-packaged-state-'));
  const configPath = join(root, 'trusted-config.json');
  mkdirSync(packRoot, { recursive: true });
  mkdirSync(consumerRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const npmrc = join(root, 'empty.npmrc');
  writeFileSync(npmrc, '');
  const npmEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    NPM_CONFIG_USERCONFIG: npmrc,
    NPM_CONFIG_CACHE: join(root, 'npm-cache'),
    NPM_CONFIG_PREFIX: join(root, 'npm-prefix'),
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
  writeFileSync(join(consumerRoot, 'package.json'), '{"name":"e7-g2-packaged-consumer","private":true}\n');
  const packedRun = spawnSync('npm', [
    'pack', '--ignore-scripts', '--json', '--pack-destination', packRoot,
  ], { cwd: process.cwd(), encoding: 'utf8', env: npmEnv, timeout: 60_000 });
  assert.equal(packedRun.error, undefined, `npm pack failed to start or timed out: ${packedRun.error?.code ?? 'unknown'}`);
  assert.equal(packedRun.status, 0, `npm pack failed: ${packedRun.stderr}`);
  const [packed] = JSON.parse(packedRun.stdout);
  const tarballPath = join(packRoot, packed.filename);
  const installRun = spawnSync('npm', [
    'install', tarballPath, '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error',
  ], { cwd: consumerRoot, encoding: 'utf8', env: npmEnv, timeout: 60_000 });
  assert.equal(installRun.error, undefined, `npm install failed to start or timed out: ${installRun.error?.code ?? 'unknown'}`);
  assert.equal(installRun.status, 0, `npm install failed: ${installRun.stderr}`);
  const installedPackageRoot = join(consumerRoot, 'node_modules', '@gyga-browser', 'webmcp-ai');
  const installedEntryPath = join(installedPackageRoot, 'src/orchestration/supervisor-entry.mjs');
  assert.equal(existsSync(installedEntryPath), true);

  const workspace = join(root, 'workspace');
  const writeRoot = join(workspace, 'out');
  const resultPath = join(writeRoot, 'packaged-echo.json');
  mkdirSync(writeRoot, { recursive: true });
  const workerScript = [
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    `const resultPath = ${JSON.stringify(resultPath)};`,
    "const socket = new net.Socket({ fd: 3, readable: true, writable: true });",
    "let buffered = '';",
    "const finish = (value, exitCode = 0) => { try { fs.writeFileSync(resultPath, JSON.stringify(value)); } finally { socket.destroy(); process.exitCode = exitCode; } };",
    "socket.on('data', (chunk) => { buffered += chunk.toString('utf8'); const newline = buffered.indexOf('\\n'); if (newline < 0) return; try { finish(JSON.parse(buffered.slice(0, newline))); } catch (error) { finish({ fatal: error.code || error.name }, 1); } });",
    "socket.once('error', (error) => finish({ fatal: error.code || error.name }, 1));",
    "socket.write(JSON.stringify({ protocol: 'webmcp-managed-broker/1', requestId: 'req_packaged_fd3_echo', tool: 'webmcp.echo', input: { message: 'packaged-fd3-echo' } }) + '\\n');",
  ].join('\n');
  const config = {
    schema: TRUSTED_COORDINATOR_CONFIG_SCHEMA,
    stateDir,
    confinement: 'disposable-workspace',
    disposableRoot: root,
    ownedProcess: {
      command: process.execPath,
      args: ['-e', workerScript],
      env: { LANG: 'C' },
    },
    hostIsolation: {
      mode: HOST_ISOLATION_MODE,
      broker: coordinatorBroker(),
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  const child = spawnProcess(process.execPath, [installedEntryPath], {
    cwd: consumerRoot,
    env: {
      ...process.env,
      WEBMCP_AI_ORCHESTRATION_PUBLIC_ADAPTERS: '1',
      WEBMCP_AI_ORCHESTRATION_TEST_FIXTURES: '1',
      WEBMCP_AI_ORCHESTRATION_TRUSTED_CONFIG: configPath,
      WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let exited = false;
  child.once('exit', () => { exited = true; });
  t.after(async () => {
    if (exited) return;
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    if (!exited) await once(child, 'exit').catch(() => {});
  });
  child.stdin.end(JSON.stringify({ owner: { host: 'packaged-g2' } }));

  const boot = await waitForFirstJsonLine(child);
  assert.equal(boot.ok, true, JSON.stringify(boot));
  assert.equal(typeof boot.coordinationId, 'string');
  assert.equal(JSON.stringify(config).includes('invoke'), false);

  // Exercise the installed supervisor through its real IPC endpoint. The
  // worker must use inherited FD3 for the allow-listed tool; merely reaching
  // dispatch.start does not prove packaged G2 topology.
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const capability = readClientCapability({
    coordinationDir: join(roots.stateRoot, 'coordinations', boot.coordinationId),
  });
  let requestSequence = 0;
  const call = (operation, input) => requestIpc(
    deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId: boot.coordinationId }),
    {
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: `req_packaged_${requestSequence += 1}`,
      coordinationId: boot.coordinationId,
      fenceEpoch: boot.fenceEpoch,
      capability,
      operation,
      input,
    },
    { timeoutMs: 20_000 },
  );
  const created = await call('task.create', {
    packet: {
      objective: 'packaged G2 reachability probe',
      workspace,
      allowedReadRoots: [workspace],
      allowedWriteRoots: [writeRoot],
    },
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const started = await call('dispatch.start', {
    taskId: created.result.taskId,
    adapterId: 'owned-process',
  });
  assert.equal(started.ok, true, JSON.stringify(started));

  await waitForFile(resultPath);
  let cursor = 0;
  const seen = new Set();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && (!seen.has('worker_done') || !seen.has('cleanup_recorded'))) {
    const waited = await call('delivery.wait', { afterSequence: cursor, timeoutMs: 1_000 });
    assert.equal(waited.ok, true, JSON.stringify(waited));
    for (const delivery of waited.result.deliveries ?? []) {
      seen.add(delivery.type);
      cursor = Math.max(cursor, delivery.sequence);
    }
  }
  const brokerResult = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.deepEqual(brokerResult, {
    protocol: 'webmcp-managed-broker/1',
    requestId: 'req_packaged_fd3_echo',
    ok: true,
    result: { echoed: 'packaged-fd3-echo' },
  });
  assert.equal(seen.has('worker_started'), true);
  assert.equal(seen.has('worker_done'), true);
  assert.equal(seen.has('cleanup_recorded'), true);
  const inspected = await call('coordination.inspect', {});
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.equal(inspected.result.dispatches[started.result.dispatchId].state, 'settled');

  child.kill('SIGTERM');
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0);
});

test('G1 lifecycle retains the legacy capability-file route when host isolation is absent', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'e7-g2-g1-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const seen = [];
  const adapter = {
    async spawn(input) {
      seen.push(input);
      return { ok: true, binding: {}, done: Promise.resolve({ terminalType: 'worker_done' }) };
    },
    async interrupt() { return { ok: true }; },
    async close() { return { proof: 'proven-exit', released: true }; },
  };
  const lifecycle = createPublicLifecycle('owned-process', adapter, createTrustedCoordinatorConfig({
    ownedProcessCommand: { command: process.execPath, args: ['-e', 'process.exit(0)'], env: { LANG: 'C' } },
  }));
  await lifecycle.launch({
    task: { workspace, allowedReadRoots: [], allowedWriteRoots: [] },
    dispatch: { dispatchId: 'disp_e7_g1', capabilityFile: '/private/capability-file' },
    emit() {},
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command, process.execPath);
  assert.equal(seen[0].env.WEBMCP_AI_WORKER_CAPABILITY_FILE, '/private/capability-file');
  assert.equal(seen[0].brokerSocket, undefined);
});

test('owned-process launch does not let runtime instrumentation mutate a frozen environment', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'e7-g2-env-'));
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = createOwnedProcessAdapter({ stateDir });
  const started = await adapter.spawn({
    task: { workspace },
    dispatch: { dispatchId: 'disp_e7_g2_env', async onSpawned() {} },
    emit() {},
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: Object.freeze({ HOME: workspace, TMPDIR: workspace, LANG: 'C' }),
  });
  const terminal = await started.done;
  assert.equal(terminal.terminalType, 'worker_done');
  await adapter.close({ binding: started.binding });
});

test('G2 rejects a public lifecycle wrapped around an untrusted process adapter', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'e7-g2-untrusted-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const adapter = {
    async spawn() { throw new Error('ambient spawn must not be reached'); },
    async interrupt() { return { ok: true }; },
    async close() { return { ok: true }; },
  };
  assert.equal(isTrustedOwnedProcessAdapter(adapter), false);
  const lifecycle = createPublicLifecycle('owned-process', adapter, createTrustedCoordinatorConfig({
    hostIsolation: {
      mode: HOST_ISOLATION_MODE,
      broker: coordinatorBroker(),
    },
    ownedProcessCommand: { command: process.execPath, args: ['-e', 'process.exit(0)'], env: {} },
  }));
  assert.equal(isTrustedManagedLifecycle(lifecycle), false);
  await assert.rejects(
    () => lifecycle.launch({ task: { workspace }, dispatch: {}, emit() {} }),
    (error) => error.code === 'HOST_ISOLATION_LIFECYCLE_UNTRUSTED',
  );
});

test('G2 rejects a broker-shaped object that is not the supervisor-created mediated channel', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'e7-g2-untrusted-broker-'));
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = createOwnedProcessAdapter({ stateDir });
  const lifecycle = createPublicLifecycle('owned-process', adapter, createTrustedCoordinatorConfig({
    hostIsolation: {
      mode: HOST_ISOLATION_MODE,
      broker: coordinatorBroker(),
    },
    ownedProcessCommand: { command: process.execPath, args: ['-e', 'process.exit(0)'], env: {} },
  }));
  await assert.rejects(
    () => lifecycle.launch({
      task: { workspace, allowedReadRoots: [], allowedWriteRoots: [] },
      dispatch: { mediatedBroker: { socket: { on() {} } } },
      emit() {},
    }),
    (error) => error.code === 'HOST_ISOLATION_BROKER_REQUIRED',
  );
});

test('G2 trust marker, adapter, lifecycle, and launch authority are immutable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'e7-g2-immutable-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inner = createOwnedProcessAdapter({ stateDir: join(root, 'state') });
  const config = createTrustedCoordinatorConfig({
    stateDir: join(root, 'state'),
    hostIsolation: { mode: HOST_ISOLATION_MODE, broker: coordinatorBroker() },
    ownedProcessCommand: { command: process.execPath, args: ['-e', 'process.exit(0)'], env: { LANG: 'C' } },
  });
  const lifecycle = createPublicLifecycle('owned-process', inner, config);

  assert.equal(Object.isFrozen(inner), true);
  assert.equal(Object.isFrozen(inner.capabilities), true);
  assert.equal(Object.isFrozen(lifecycle), true);
  assert.equal(Object.isFrozen(config.ownedProcessCommand), true);
  assert.equal(Object.isFrozen(config.ownedProcessCommand.args), true);
  assert.equal(Object.isFrozen(config.ownedProcessCommand.env), true);
  assert.equal(isTrustedManagedLifecycle(lifecycle), true);
  assert.throws(() => { inner.spawn = async () => {}; }, TypeError);
  assert.throws(() => { lifecycle.launch = async () => {}; }, TypeError);
  assert.equal(isTrustedManagedLifecycle(lifecycle), true);
});

test('broker recursively enforces workspace/read/write/protected and capability boundaries', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'e7-g2-nested-'));
  const workspace = join(root, 'workspace');
  const writeRoot = join(workspace, 'out');
  const protectedPath = join(workspace, 'protected.txt');
  const outside = join(root, 'outside');
  mkdirSync(writeRoot, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(protectedPath, 'protected');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const broker = await createMediatedToolBroker({
    socketRoot: join(root, 'sockets'),
    dispatchId: 'disp_e7_nested',
    bindingId: 'worker_e7_nested',
    taskId: 'task_e7_nested',
    fenceEpoch: 1,
    task: {
      workspace,
      allowedReadRoots: [workspace],
      allowedWriteRoots: [writeRoot],
      protectedPaths: [protectedPath],
    },
    broker: coordinatorBroker(),
  });
  t.after(() => broker.close());

  const base = { protocol: 'webmcp-managed-broker/1', tool: 'webmcp.echo' };
  const denied = [
    { name: 'array path bypass', input: { paths: [outside] } },
    { name: 'source path bypass', input: { source: outside } },
    { name: 'deep array path bypass', input: { payload: [{ artifact: { locations: [outside] } }] } },
    { name: 'opaque relative traversal', input: { metadata: [{ value: '../outside/secret.txt' }] } },
    { name: 'write-root bypass', input: { metadata: [{ output: join(workspace, 'not-writable.txt') }] } },
    { name: 'protected path', input: { metadata: { requested: { path: protectedPath } } } },
    { name: 'network URL', input: { metadata: [{ endpoint: 'https://example.invalid/tool' }] } },
    { name: 'opaque browser URI', input: { metadata: [{ value: 'chrome://settings' }] } },
    { name: 'opaque network host', input: { metadata: [{ value: 'example.invalid/tool' }] } },
    { name: 'browser javascript URL', input: { nested: { browser: { target: 'javascript:alert(1)' } } } },
    { name: 'shell command', input: { nested: [{ command: ['/bin/sh', '-c', 'echo bypass'] }] } },
    { name: 'shell metacharacter hidden under value', input: { metadata: [{ value: 'echo safe; /bin/sh -c bypass' }] } },
  ];
  for (const testCase of denied) {
    const response = await brokerRequest(broker.socket, { ...base, requestId: `req_${testCase.name.replace(/[^a-z0-9]/gi, '_')}`, input: testCase.input });
    assert.equal(response.ok, false, testCase.name);
    assert.ok([
      'HOST_ISOLATION_BOUNDARY_MISMATCH',
      'BROKER_PROTOCOL_ERROR',
    ].includes(response.error?.code), `${testCase.name}: ${JSON.stringify(response)}`);
  }

  const allowed = await brokerRequest(broker.socket, {
    ...base,
    requestId: 'req_nested_allowed',
    input: {
      message: 'safe',
      nested: [{ path: join(workspace, 'new.txt') }, { writePath: join(writeRoot, 'new.txt') }],
    },
  });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));

  const permission = await brokerRequest(broker.socket, {
    ...base,
    requestId: 'req_nested_permission',
    input: { permission: 'required' },
  });
  assert.equal(permission.ok, false, JSON.stringify(permission));
  assert.equal(permission.error.code, PERMISSION_REQUIRED);
});

test('Seatbelt launch spec strips authority and rejects unavailable primitives without ambient spawn', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('actual Seatbelt launch is Darwin-only');
    return;
  }
  const { root, workspace, writeRoot } = makeWorkspace(t, 'spec');
  const spec = buildSeatbeltLaunchSpec({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    cwd: workspace,
    workspace,
    allowedReadRoots: [workspace],
    allowedWriteRoots: [writeRoot],
    baseEnv: {
      WEBMCP_AI_WORKER_CAPABILITY_FILE: join(root, 'capability'),
      WEBMCP_PERMIT: 'permit-value',
      WEBMCP_CLAIM_TOKEN: 'claim-value',
      WEBMCP_PRIVATE_KEY: 'private-value',
      PATH: '/ambient/path',
      LANG: 'C',
    },
  });
  assert.match(spec.command, /(?:^|\/)sandbox-exec$/);
  assert.equal(spec.proof.brokerFd, 3);
  assert.equal(spec.proof.launchBoundary, HOST_ISOLATION_LAUNCH_BOUNDARY);
  assert.match(spec.proof.workspaceReadSetDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(spec.args[1].includes(`(subpath "${workspace}")`), false);
  assert.equal(Object.hasOwn(spec.env, 'WEBMCP_AI_WORKER_CAPABILITY_FILE'), false);
  assert.equal(Object.hasOwn(spec.env, 'WEBMCP_PERMIT'), false);
  assert.equal(Object.hasOwn(spec.env, 'WEBMCP_CLAIM_TOKEN'), false);
  assert.equal(Object.hasOwn(spec.env, 'WEBMCP_PRIVATE_KEY'), false);
  assert.equal(Object.hasOwn(spec.env, 'PATH'), false);
  assert.equal(JSON.stringify(spec.args).includes('capability'), false);
});

test('missing trusted broker fails before supervisor launch and leaves no capability fallback', async (t) => {
  const { root, workspace, writeRoot } = makeWorkspace(t, 'missing-broker');
  const stateDir = mkdtempSync(join(tmpdir(), 'e7-g2-state-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const config = createTrustedCoordinatorConfig({
    stateDir,
    allowFixtureDispatch: true,
    confinement: 'disposable-workspace',
    disposableRoot: root,
    hostIsolation: { mode: HOST_ISOLATION_MODE },
    ownedProcessCommand: { command: process.execPath, args: ['-e', 'process.exit(0)'], env: {} },
  });
  const { sup, call } = await startManagedSupervisor(t, 'missing-broker', { config });
  const created = await call('task.create', { packet: managedPacket(workspace, writeRoot) });
  assert.equal(created.ok, true, JSON.stringify(created.error));
  const started = await call('dispatch.start', { taskId: created.result.taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, false);
  assert.equal(errorCode(started), 'HOST_ISOLATION_BROKER_REQUIRED');
  const dispatch = Object.values(sup.__store.state.dispatches).find((entry) => entry.taskId === created.result.taskId);
  assert.equal(dispatch.state, 'failed');
});

function workerProbeScript({ workspace, writeRoot, writeEscape, outside, resultPath, browserPath }) {
  return `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const net = require('node:net');
    const scope = ${JSON.stringify({ workspace, writeRoot, writeEscape, outside, resultPath, browserPath })};
    const denied = (operation) => { try { operation(); return 'ALLOWED'; } catch (error) { return error.code || error.name; } };
    const exec = (command, args) => { try { const r = cp.spawnSync(command, args, { encoding: 'utf8' }); return r.error?.code || (r.status === 0 ? 'ALLOWED' : 'STATUS_' + r.status); } catch (error) { return error.code || error.name; } };
    const brokerRequest = (socket, tool, input, requestId = 'req_worker_' + tool.replace(/[^a-z0-9]/gi, '')) => new Promise((resolve) => {
      let buffered = '';
      const finish = (value) => { socket.removeAllListeners('data'); resolve(value); };
      socket.on('data', (chunk) => {
        buffered += chunk.toString('utf8');
        const newline = buffered.indexOf('\\n');
        if (newline >= 0) {
          try { finish(JSON.parse(buffered.slice(0, newline))); } catch { finish({ error: 'INVALID_RESPONSE' }); }
        }
      });
      socket.once('error', (error) => finish({ error: error.code || error.name }));
      socket.setTimeout(1500, () => finish({ error: 'TIMEOUT' }));
      socket.write(JSON.stringify({ protocol: 'webmcp-managed-broker/1', requestId, tool, input }) + '\\n');
    });
    const directNetwork = () => new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: 9 });
      socket.setTimeout(1000, () => { socket.destroy(); resolve('TIMEOUT'); });
      socket.once('connect', () => { socket.destroy(); resolve('ALLOWED'); });
      socket.once('error', (error) => { socket.destroy(); resolve(error.code || error.name); });
    });
    (async () => {
      const result = {
        home: process.env.HOME ?? null,
        envKeys: Object.keys(process.env).sort(),
        authorityEnvKeys: Object.keys(process.env).filter((key) => /permit|claim|private.?key|token|capability|credential/i.test(key)).sort(),
        capabilityFile: process.env.WEBMCP_AI_WORKER_CAPABILITY_FILE ?? null,
        allowedWrite: denied(() => fs.writeFileSync(scope.writeRoot + '/allowed.txt', 'allowed')),
        workspaceWrite: denied(() => fs.writeFileSync(scope.workspace + '/blocked.txt', 'blocked')),
        outsideRead: denied(() => fs.readFileSync(scope.outside + '/secret.txt', 'utf8')),
        outsideWrite: denied(() => fs.writeFileSync(scope.outside + '/outside.txt', 'outside')),
        symlinkWrite: denied(() => fs.writeFileSync(scope.workspace + '/escape/escaped.txt', 'escape')),
        writeSymlinkEscape: denied(() => fs.writeFileSync(scope.writeEscape + '/escaped.txt', 'escape')),
        shell: exec('/bin/sh', ['-c', 'printf shell-bypass']),
        alternateBrowser: exec(scope.browserPath, []),
      };
      result.directNetwork = await directNetwork();
      const socket = new net.Socket({ fd: 3, readable: true, writable: true });
      result.allowedTool = await brokerRequest(socket, 'webmcp.echo', { message: 'from-worker' });
      result.unlistedTool = await brokerRequest(socket, 'webmcp.unlisted', { message: 'must-deny' });
      result.relativePath = await brokerRequest(socket, 'webmcp.echo', { filePath: 'relative.txt' });
      result.secretRequestId = await brokerRequest(socket, 'webmcp.echo', { message: 'safe' }, 'sk-abcdefghijk');
      result.secretInput = await brokerRequest(socket, 'webmcp.echo', { claimToken: 'opaque-claim-key-only' });
      socket.end();
      fs.writeFileSync(scope.resultPath, JSON.stringify(result));
    })().catch((error) => {
      fs.writeFileSync(scope.resultPath, JSON.stringify({ fatal: error.code || error.name, message: String(error.message || error) }));
      process.exitCode = 1;
    });
  `;
}

test('actual managed supervisor launch binds Seatbelt owned-process to hidden mediated broker FD 3', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const fixture = makeWorkspace(t, 'positive');
  const browserPath = join(fixture.workspace, 'alternate-browser');
  const escapePath = join(fixture.workspace, 'escape');
  const writeEscape = join(fixture.writeRoot, 'symlink-to-outside');
  const outsideSecret = join(fixture.outside, 'secret.txt');
  const resultPath = join(fixture.writeRoot, 'result.json');
  writeFileSync(outsideSecret, 'OUTSIDE_SECRET_MUST_NOT_CROSS');
  writeFileSync(browserPath, '#!/bin/sh\nprintf browser-bypass\n', { mode: 0o700 });
  symlinkSync(fixture.outside, escapePath, 'dir');
  symlinkSync(fixture.outside, writeEscape, 'dir');

  const stateDir = mkdtempSync(join(tmpdir(), 'e7-g2-positive-state-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const config = createTrustedCoordinatorConfig({
    stateDir,
    allowFixtureDispatch: true,
    confinement: 'disposable-workspace',
    disposableRoot: fixture.root,
    hostIsolation: {
      mode: HOST_ISOLATION_MODE,
      broker: coordinatorBroker(),
    },
    ownedProcessCommand: {
      command: process.execPath,
      args: ['-e', workerProbeScript({
        workspace: fixture.workspace,
        writeRoot: fixture.writeRoot,
        writeEscape,
        outside: fixture.outside,
        resultPath,
        browserPath,
      })],
      env: {
        WEBMCP_PERMIT: 'permit-value',
        WEBMCP_CLAIM_TOKEN: 'claim-token-value',
        WEBMCP_PRIVATE_KEY: 'private-key-value',
        PATH: '/ambient/path',
        LANG: 'C',
      },
    },
  });
  const { sup, call, coordinationId, roots } = await startManagedSupervisor(t, 'positive', { config });
  const created = await call('task.create', { packet: managedPacket(fixture.workspace, fixture.writeRoot) });
  assert.equal(created.ok, true, JSON.stringify(created.error));
  const started = await call('dispatch.start', { taskId: created.result.taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error));
  await waitForFile(resultPath);
  await waitForSettled(sup, started.result.dispatchId);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));

  assert.equal(result.home, realpathSync(fixture.workspace));
  assert.deepEqual(result.authorityEnvKeys, []);
  assert.equal(result.capabilityFile, null);
  assert.equal(result.allowedWrite, 'ALLOWED');
  assert.ok(['EPERM', 'EACCES'].includes(result.workspaceWrite), result.workspaceWrite);
  assert.ok(['EPERM', 'EACCES'].includes(result.outsideRead), result.outsideRead);
  assert.ok(['EPERM', 'EACCES'].includes(result.outsideWrite), result.outsideWrite);
  assert.ok(['EPERM', 'EACCES'].includes(result.symlinkWrite), result.symlinkWrite);
  assert.ok(['EPERM', 'EACCES'].includes(result.writeSymlinkEscape), result.writeSymlinkEscape);
  assert.ok(['EPERM', 'EACCES'].includes(result.shell), result.shell);
  assert.ok(['EPERM', 'EACCES'].includes(result.alternateBrowser), result.alternateBrowser);
  assert.ok(['EPERM', 'EACCES'].includes(result.directNetwork), result.directNetwork);
  assert.deepEqual(result.allowedTool, { protocol: 'webmcp-managed-broker/1', requestId: 'req_worker_webmcpecho', ok: true, result: { echoed: 'from-worker' } });
  assert.equal(result.unlistedTool.error.code, 'UNLISTED_MCP_TOOL_DENIED');
  assert.equal(result.relativePath.error.code, 'HOST_ISOLATION_BOUNDARY_MISMATCH');
  assert.equal(result.secretRequestId.error.code, 'BROKER_PROTOCOL_ERROR');
  assert.equal(result.secretRequestId.requestId, null);
  assert.equal(result.secretInput.error.code, 'BROKER_PROTOCOL_ERROR');
  assert.equal(JSON.stringify(result).includes('sk-abcdefghijk'), false);
  const capabilityDir = join(roots.stateRoot, 'coordinations', coordinationId, 'dispatch-capabilities');
  assert.equal(existsSync(capabilityDir), false);
  const events = readFileSync(join(roots.stateRoot, 'coordinations', coordinationId, 'events.jsonl'), 'utf8');
  assert.equal(events.includes('permit-value'), false);
  assert.equal(events.includes('claim-token-value'), false);
  assert.equal(events.includes('private-key-value'), false);
  assert.deepEqual(sup.__workerBindings(), []);
});

test('actual managed lifecycle rejects pre-existing hardlink before child spawn', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const fixture = makeWorkspace(t, 'hardlink');
  writeFileSync(join(fixture.outside, 'secret.txt'), 'outside-hardlink');
  linkSync(join(fixture.outside, 'secret.txt'), join(fixture.workspace, 'hardlink.txt'));
  const stateDir = mkdtempSync(join(tmpdir(), 'e7-g2-hardlink-state-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const config = createTrustedCoordinatorConfig({
    stateDir,
    allowFixtureDispatch: true,
    confinement: 'disposable-workspace',
    disposableRoot: fixture.root,
    hostIsolation: {
      mode: HOST_ISOLATION_MODE,
      broker: coordinatorBroker(),
    },
    ownedProcessCommand: { command: process.execPath, args: ['-e', 'process.exit(0)'], env: {} },
  });
  const { sup, call } = await startManagedSupervisor(t, 'hardlink', { config });
  const created = await call('task.create', { packet: managedPacket(fixture.workspace, fixture.writeRoot) });
  assert.equal(created.ok, true);
  const started = await call('dispatch.start', { taskId: created.result.taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, false);
  assert.equal(errorCode(started), 'HOST_ISOLATION_UNSAFE_WORKSPACE');
  const dispatch = Object.values(sup.__store.state.dispatches).find((entry) => entry.taskId === created.result.taskId);
  assert.equal(dispatch.state, 'failed');
  assert.deepEqual(sup.__workerBindings(), []);
});

test('supervisor final geometry re-proof rejects a TOCTOU workspace swap before lifecycle launch', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const outsideRoot = mkdtempSync(join(tmpdir(), 'e7-g2-toctou-outside-'));
  const fixture = makeWorkspace(t, 'toctou', { outsideRoot });
  const stateDir = mkdtempSync(join(tmpdir(), 'e7-g2-toctou-state-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let swapped = false;
  const config = createTrustedCoordinatorConfig({
    stateDir,
    allowFixtureDispatch: true,
    confinement: 'disposable-workspace',
    disposableRoot: fixture.root,
    hostIsolation: {
      mode: HOST_ISOLATION_MODE,
      broker: coordinatorBroker(),
    },
    ownedProcessCommand: { command: process.execPath, args: ['-e', 'process.exit(0)'], env: {} },
  });
  const { sup, call } = await startManagedSupervisor(t, 'toctou', {
    config,
    env: {
      WEBMCP_AI_TEST_PRESWAP_HOOK: async () => {
        if (swapped) return;
        renameSync(fixture.workspace, `${fixture.workspace}-safe`);
        symlinkSync(outsideRoot, fixture.workspace, 'dir');
        swapped = true;
      },
    },
  });
  const created = await call('task.create', { packet: managedPacket(fixture.workspace, fixture.writeRoot) });
  assert.equal(created.ok, true);
  const started = await call('dispatch.start', { taskId: created.result.taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, false);
  assert.equal(errorCode(started), 'POLICY_DENIED');
  const dispatch = Object.values(sup.__store.state.dispatches).find((entry) => entry.taskId === created.result.taskId);
  assert.equal(dispatch.state, 'failed');
  assert.equal(swapped, true);
});

test('G2 launch boundary denies a hardlink inserted after the final workspace scan', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'e7-g2-race-'));
  const workspace = join(root, 'workspace');
  const writeRoot = join(workspace, 'out');
  const outside = join(root, 'outside');
  mkdirSync(writeRoot, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const outsideFile = join(outside, 'secret.txt');
  const racedHardlink = join(workspace, 'raced-hardlink.txt');
  const resultPath = join(writeRoot, 'race-result.json');
  writeFileSync(outsideFile, 'race-secret');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  let boundaryHookCalls = 0;
  const stateDir = join(root, 'state');
  const inner = createOwnedProcessAdapter({
    stateDir,
    beforeSpawnHook: () => {
      boundaryHookCalls += 1;
      linkSync(outsideFile, racedHardlink);
    },
  });
  const config = createTrustedCoordinatorConfig({
    stateDir,
    hostIsolation: { mode: HOST_ISOLATION_MODE, broker: coordinatorBroker() },
    ownedProcessCommand: {
      command: process.execPath,
      args: ['-e', [
        "const fs = require('node:fs');",
        `const racedHardlink = ${JSON.stringify(racedHardlink)};`,
        `const resultPath = ${JSON.stringify(resultPath)};`,
        "let hardlinkRead; try { fs.readFileSync(racedHardlink, 'utf8'); hardlinkRead = 'ALLOWED'; } catch (error) { hardlinkRead = error.code || error.name; }",
        "fs.writeFileSync(resultPath, JSON.stringify({ hardlinkRead }));",
      ].join('\n')],
      env: {},
    },
  });
  const lifecycle = createPublicLifecycle('owned-process', inner, config);
  const broker = await createMediatedToolBroker({
    socketRoot: join(root, 'sockets'),
    dispatchId: 'disp_e7_race',
    bindingId: 'worker_e7_race',
    taskId: 'task_e7_race',
    fenceEpoch: 1,
    task: { workspace, allowedReadRoots: [workspace], allowedWriteRoots: [writeRoot], protectedPaths: [] },
    broker: coordinatorBroker(),
  });
  t.after(() => broker.close());

  const started = await lifecycle.launch({
    task: { taskId: 'task_e7_race', workspace, allowedReadRoots: [workspace], allowedWriteRoots: [writeRoot], protectedPaths: [] },
    dispatch: { dispatchId: 'disp_e7_race', bindingId: 'worker_e7_race', capabilityFile: null, mediatedBroker: broker },
    emit() {},
  });
  await waitForFile(resultPath);
  await started.done;
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(boundaryHookCalls, 1);
  assert.equal(existsSync(racedHardlink), true);
  assert.ok(['EACCES', 'EPERM'].includes(result.hardlinkRead), JSON.stringify(result));
});

test('G2 launch boundary rejects a hardlink swapped into an allow-listed filename', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'e7-g2-swapped-hardlink-'));
  const workspace = join(root, 'workspace');
  const writeRoot = join(workspace, 'out');
  const outside = join(root, 'outside');
  mkdirSync(writeRoot, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const allowListedFile = join(workspace, 'allow-listed.txt');
  const outsideFile = join(outside, 'secret.txt');
  const resultPath = join(writeRoot, 'swap-result.json');
  writeFileSync(allowListedFile, 'in-scope');
  writeFileSync(outsideFile, 'swap-secret');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  let boundaryHookCalls = 0;
  const stateDir = join(root, 'state');
  const inner = createOwnedProcessAdapter({
    stateDir,
    beforeSpawnHook: () => {
      boundaryHookCalls += 1;
      rmSync(allowListedFile);
      linkSync(outsideFile, allowListedFile);
    },
  });
  const config = createTrustedCoordinatorConfig({
    stateDir,
    hostIsolation: { mode: HOST_ISOLATION_MODE, broker: coordinatorBroker() },
    ownedProcessCommand: {
      command: process.execPath,
      args: ['-e', [
        "const fs = require('node:fs');",
        `const allowListedFile = ${JSON.stringify(allowListedFile)};`,
        `const resultPath = ${JSON.stringify(resultPath)};`,
        "let hardlinkRead; try { fs.readFileSync(allowListedFile, 'utf8'); hardlinkRead = 'ALLOWED'; } catch (error) { hardlinkRead = error.code || error.name; }",
        "fs.writeFileSync(resultPath, JSON.stringify({ hardlinkRead }));",
      ].join('\n')],
      env: {},
    },
  });
  const lifecycle = createPublicLifecycle('owned-process', inner, config);
  const broker = await createMediatedToolBroker({
    socketRoot: join(root, 'sockets'),
    dispatchId: 'disp_e7_swapped_hardlink',
    bindingId: 'worker_e7_swapped_hardlink',
    taskId: 'task_e7_swapped_hardlink',
    fenceEpoch: 1,
    task: { workspace, allowedReadRoots: [workspace], allowedWriteRoots: [writeRoot], protectedPaths: [] },
    broker: coordinatorBroker(),
  });
  t.after(() => broker.close());

  let started = null;
  let launchError = null;
  try {
    started = await lifecycle.launch({
      task: { taskId: 'task_e7_swapped_hardlink', workspace, allowedReadRoots: [workspace], allowedWriteRoots: [writeRoot], protectedPaths: [] },
      dispatch: { dispatchId: 'disp_e7_swapped_hardlink', bindingId: 'worker_e7_swapped_hardlink', capabilityFile: null, mediatedBroker: broker },
      emit() {},
    });
  } catch (error) {
    launchError = error;
  }
  if (started !== null) {
    await waitForFile(resultPath);
    await started.done;
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.fail(`swapped allow-listed hardlink was readable: ${JSON.stringify(result)}`);
  }
  assert.equal(boundaryHookCalls, 1);
  assert.equal(existsSync(allowListedFile), true);
  assert.equal(launchError?.code, 'HOST_ISOLATION_UNSAFE_WORKSPACE');
  assert.equal(existsSync(resultPath), false);
});

test('broker socket is hidden after FD handoff and rejects unlisted tools without exposing authority', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'e7-g2-broker-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const broker = await createMediatedToolBroker({
    socketRoot: root,
    dispatchId: 'disp_e7_broker',
    bindingId: 'worker_e7_broker',
    taskId: 'task_e7_broker',
    fenceEpoch: 1,
    task: { workspace, allowedReadRoots: [], allowedWriteRoots: [] },
    broker: {
      ...coordinatorBroker(),
    },
  });
  t.after(() => broker.close());
  assert.equal(broker.brokerFd, 3);
  assert.equal(existsSync(broker.socketPath), false);
  assert.equal(JSON.stringify(broker.proof).includes('permit'), false);
  broker.socket.end();
});

test('all public G2 and broker errors are registered in constants and response schema', () => {
  const schema = JSON.parse(readFileSync(new URL('../../src/orchestration/schemas/response.schema.json', import.meta.url), 'utf8'));
  const schemaCodes = new Set(schema.properties.error.properties.code.enum);
  for (const code of PUBLIC_G2_ERROR_CODES) {
    assert.equal(ORCHESTRATION_ERROR_CODES.has(code), true, `constants missing ${code}`);
    assert.equal(schemaCodes.has(code), true, `response schema missing ${code}`);
  }
});
