import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  COORDINATOR_DISPATCHER_IMPLEMENTATION,
  COORDINATOR_DISPATCHER_MARKER,
  COORDINATOR_DISPATCHER_SCHEMA,
  COORDINATOR_DISPATCH_REQUEST_SCHEMA,
  HOST_ISOLATION_BROKER_IMPLEMENTATION,
  HOST_ISOLATION_DISPATCHER_REQUIRED,
  HOST_ISOLATION_DISPATCHER_UNTRUSTED,
  HOST_ISOLATION_MODE,
  BROKER_PROTOCOL_ERROR,
  UNLISTED_MCP_TOOL_DENIED,
  createMediatedToolBroker,
} from '../../src/orchestration/managed-host/host-isolation.mjs';
import {
  asPublicAdapter,
  createPublicLifecycle,
  createTrustedCoordinatorConfig,
} from '../../src/orchestration/public-adapters.mjs';
import { createOwnedProcessAdapter } from '../../src/orchestration/adapters/owned-process.mjs';
import { createSupervisor } from '../../src/orchestration/supervisor.mjs';
import { readClientCapability } from '../../src/orchestration/authority.mjs';
import { deriveEndpoint, requestIpc } from '../../src/orchestration/ipc.mjs';
import { ORCHESTRATION_PROTOCOL } from '../../src/orchestration/constants.mjs';
import { resolveOrchestrationRoots } from '../../src/orchestration/paths.mjs';

function coordinatorBroker(allowedTools) {
  return {
    implementation: HOST_ISOLATION_BROKER_IMPLEMENTATION,
    allowedTools,
  };
}

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

function brokerRequest(socket, request) {
  return new Promise((resolve, reject) => {
    let buffered = '';
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
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

function brokerScope(root) {
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  return {
    workspace,
    allowedReadRoots: [workspace],
    allowedWriteRoots: [],
    protectedPaths: [],
  };
}

async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForSettled(supervisor, dispatchId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (supervisor.__store.state.dispatches[dispatchId]?.state === 'settled') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`dispatch ${dispatchId} did not settle`);
}

test('mediated coordinator dispatcher exposes only the typed WebMCP tools', async (t) => {
  const root = mkdtempSync('/tmp/webmcp-cd-');
  const scope = brokerScope(root);
  const seen = [];
  const broker = await createMediatedToolBroker({
    socketRoot: join(root, 'sockets'),
    dispatchId: 'disp_dispatcher_test',
    bindingId: 'worker_dispatcher_test',
    taskId: 'task_dispatcher_test',
    fenceEpoch: 3,
    task: scope,
    broker: coordinatorBroker(['webmcp.echo', 'webmcp.listTools', 'webmcp.invokeTool']),
    dispatcher: markCoordinatorDispatcher(async (request) => {
      seen.push(request);
      return { accepted: true };
    }),
  });
  t.after(async () => {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  });

  const listed = await brokerRequest(broker.socket, {
    protocol: 'webmcp-managed-broker/1',
    requestId: 'req_list_tools',
    tool: 'webmcp.listTools',
    input: { tabId: 7 },
  });
  assert.deepEqual(listed.result, { accepted: true });

  const echoed = await brokerRequest(broker.socket, {
    protocol: 'webmcp-managed-broker/1',
    requestId: 'req_echo_compatibility',
    tool: 'webmcp.echo',
    input: { message: 'echo-compatible' },
  });
  assert.deepEqual(echoed.result, { echoed: 'echo-compatible' });

  const invoked = await brokerRequest(broker.socket, {
    protocol: 'webmcp-managed-broker/1',
    requestId: 'req_invoke_tool',
    tool: 'webmcp.invokeTool',
    input: { toolName: 'read_summary', input: { tabId: 7 } },
  });
  assert.deepEqual(invoked.result, { accepted: true });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].schema, COORDINATOR_DISPATCH_REQUEST_SCHEMA);
  assert.equal(seen[0].dispatchId, 'disp_dispatcher_test');
  assert.equal(seen[0].taskId, 'task_dispatcher_test');
  assert.equal(seen[0].fenceEpoch, 3);
  assert.equal(Object.hasOwn(seen[0], 'workspace'), false);
  assert.equal(Object.hasOwn(seen[0], 'permit'), false);
  assert.deepEqual(seen[1].input, { toolName: 'read_summary', input: { tabId: 7 } });

  const unlisted = await brokerRequest(broker.socket, {
    protocol: 'webmcp-managed-broker/1',
    requestId: 'req_direct_navigate',
    tool: 'webmcp.navigate',
    input: {},
  });
  assert.equal(unlisted.ok, false);
  assert.equal(unlisted.error.code, UNLISTED_MCP_TOOL_DENIED);
});

test('browser dispatcher tools require a non-serializable coordinator callback', async () => {
  const root = mkdtempSync('/tmp/webmcp-cd-missing-');
  const scope = brokerScope(root);
  await assert.rejects(
    () => createMediatedToolBroker({
      socketRoot: join(root, 'sockets'),
      dispatchId: 'disp_missing_dispatcher',
      bindingId: 'worker_missing_dispatcher',
      taskId: 'task_missing_dispatcher',
      fenceEpoch: 1,
      task: scope,
      broker: coordinatorBroker(['webmcp.invokeTool']),
    }),
    (error) => error.code === HOST_ISOLATION_DISPATCHER_REQUIRED,
  );
  rmSync(root, { recursive: true, force: true });
});

test('dispatcher-shaped data and authority-bearing worker input fail closed', async (t) => {
  const root = mkdtempSync('/tmp/webmcp-cd-invalid-');
  const scope = brokerScope(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    () => createMediatedToolBroker({
      socketRoot: join(root, 'untrusted-sockets'),
      dispatchId: 'disp_untrusted_dispatcher',
      bindingId: 'worker_untrusted_dispatcher',
      taskId: 'task_untrusted_dispatcher',
      fenceEpoch: 1,
      task: scope,
      broker: coordinatorBroker(['webmcp.invokeTool']),
      dispatcher: { dispatch() {} },
    }),
    (error) => error.code === HOST_ISOLATION_DISPATCHER_UNTRUSTED,
  );

  await assert.rejects(
    () => createMediatedToolBroker({
      socketRoot: join(root, 'unmarked-sockets'),
      dispatchId: 'disp_unmarked_dispatcher',
      bindingId: 'worker_unmarked_dispatcher',
      taskId: 'task_unmarked_dispatcher',
      fenceEpoch: 1,
      task: scope,
      broker: coordinatorBroker(['webmcp.invokeTool']),
      dispatcher: async () => ({ shouldNot: 'run' }),
    }),
    (error) => error.code === HOST_ISOLATION_DISPATCHER_UNTRUSTED,
  );

  const broker = await createMediatedToolBroker({
    socketRoot: join(root, 'sockets'),
    dispatchId: 'disp_invalid_input',
    bindingId: 'worker_invalid_input',
    taskId: 'task_invalid_input',
    fenceEpoch: 1,
    task: scope,
    broker: coordinatorBroker(['webmcp.invokeTool']),
    dispatcher: markCoordinatorDispatcher(async () => ({ shouldNot: 'run' })),
  });
  t.after(() => broker.close());

  const authority = await brokerRequest(broker.socket, {
    protocol: 'webmcp-managed-broker/1',
    requestId: 'req_authority_input',
    tool: 'webmcp.invokeTool',
    input: { toolName: 'read_summary', profileId: 'physical-profile' },
  });
  assert.equal(authority.ok, false);
  assert.ok([
    BROKER_PROTOCOL_ERROR,
    'HOST_ISOLATION_BOUNDARY_MISMATCH',
  ].includes(authority.error.code));

  for (const [requestId, input, codes] of [
    ['req_shell_input', { toolName: 'read_summary', input: { command: 'node' } }, [BROKER_PROTOCOL_ERROR]],
    ['req_network_input', { toolName: 'read_summary', input: { url: 'https://example.invalid' } }, [BROKER_PROTOCOL_ERROR, 'HOST_ISOLATION_BOUNDARY_MISMATCH']],
    ['req_unknown_field', { toolName: 'read_summary', unexpected: true }, [BROKER_PROTOCOL_ERROR]],
  ]) {
    const denied = await brokerRequest(broker.socket, {
      protocol: 'webmcp-managed-broker/1',
      requestId,
      tool: 'webmcp.invokeTool',
      input,
    });
    assert.equal(denied.ok, false);
    assert.ok(codes.includes(denied.error.code));
  }

  const secretResultBroker = await createMediatedToolBroker({
    socketRoot: join(root, 'secret-sockets'),
    dispatchId: 'disp_secret_result',
    bindingId: 'worker_secret_result',
    taskId: 'task_secret_result',
    fenceEpoch: 1,
    task: scope,
    broker: coordinatorBroker(['webmcp.invokeTool']),
    dispatcher: markCoordinatorDispatcher(async () => ({ permitId: 'permit-must-not-cross' })),
  });
  t.after(() => secretResultBroker.close());
  const secretResult = await brokerRequest(secretResultBroker.socket, {
    protocol: 'webmcp-managed-broker/1',
    requestId: 'req_secret_result',
    tool: 'webmcp.invokeTool',
    input: { toolName: 'read_summary' },
  });
  assert.equal(secretResult.ok, false);
  assert.equal(secretResult.error.code, BROKER_PROTOCOL_ERROR);

  const throwingBroker = await createMediatedToolBroker({
    socketRoot: join(root, 'throwing-sockets'),
    dispatchId: 'disp_throwing_dispatcher',
    bindingId: 'worker_throwing_dispatcher',
    taskId: 'task_throwing_dispatcher',
    fenceEpoch: 1,
    task: scope,
    broker: coordinatorBroker(['webmcp.invokeTool']),
    dispatcher: markCoordinatorDispatcher(async () => {
      throw new Error('permit token should never cross the worker boundary');
    }),
  });
  t.after(() => throwingBroker.close());
  const callbackError = await brokerRequest(throwingBroker.socket, {
    protocol: 'webmcp-managed-broker/1',
    requestId: 'req_callback_error',
    tool: 'webmcp.invokeTool',
    input: { toolName: 'read_summary' },
  });
  assert.equal(callbackError.ok, false);
  assert.equal(callbackError.error.code, BROKER_PROTOCOL_ERROR);
  assert.equal(callbackError.error.message, 'mediated broker request denied');
  assert.equal(callbackError.error.message.includes('permit'), false);
});

test('supervisor carries marked coordinator dispatch through inherited FD3', {
  skip: process.platform !== 'darwin',
  timeout: 120_000,
}, async (t) => {
  const root = mkdtempSync('/tmp/webmcp-cd-supervisor-');
  const stateDir = mkdtempSync('/tmp/webmcp-cd-state-');
  const workspace = join(root, 'workspace');
  const writeRoot = join(workspace, 'out');
  const resultPath = join(writeRoot, 'invoke-result.json');
  mkdirSync(writeRoot, { recursive: true });
  t.after(async () => {
    await rmSync(root, { recursive: true, force: true });
    await rmSync(stateDir, { recursive: true, force: true });
  });

  const workerScript = [
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    `const resultPath = ${JSON.stringify(resultPath)};`,
    "const socket = new net.Socket({ fd: 3, readable: true, writable: true });",
    "let buffered = '';",
    "const finish = (value, code = 0) => { fs.writeFileSync(resultPath, JSON.stringify(value)); socket.destroy(); process.exitCode = code; };",
    "socket.on('data', (chunk) => { buffered += chunk.toString('utf8'); const newline = buffered.indexOf('\\n'); if (newline < 0) return; try { finish(JSON.parse(buffered.slice(0, newline))); } catch (error) { finish({ fatal: error.code || error.name }, 1); } });",
    "socket.once('error', (error) => finish({ fatal: error.code || error.name }, 1));",
    "socket.write(JSON.stringify({ protocol: 'webmcp-managed-broker/1', requestId: 'req_worker_invoke', tool: 'webmcp.invokeTool', input: { toolName: 'read_summary', input: { tabId: 7 } } }) + '\\n');",
  ].join('\n');
  const config = createTrustedCoordinatorConfig({
    stateDir,
    confinement: 'disposable-workspace',
    disposableRoot: root,
    hostIsolation: {
      mode: HOST_ISOLATION_MODE,
      broker: coordinatorBroker(['webmcp.invokeTool']),
    },
    ownedProcessCommand: {
      command: process.execPath,
      args: ['-e', workerScript],
      env: { LANG: 'C' },
    },
  });
  const inner = createOwnedProcessAdapter({ stateDir });
  const adapter = asPublicAdapter(inner, createPublicLifecycle('owned-process', inner, config));
  const coordinationId = `coord_webmcp_cd_${Date.now()}`;
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const seen = [];
  const dispatcher = markCoordinatorDispatcher(async (request) => {
    seen.push(request);
    return { accepted: true };
  });
  const supervisor = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'create',
    coordinationId,
    adapters: [adapter],
    trustedCoordinatorConfig: config,
    coordinatorDispatcher: dispatcher,
  });
  t.after(() => supervisor.stop());

  const call = (operation, input) => requestIpc(
    deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId }),
    {
      protocol: ORCHESTRATION_PROTOCOL,
      requestId: `req_${operation}_${Date.now()}`,
      coordinationId,
      fenceEpoch: supervisor.__store.state.fenceEpoch,
      capability: readClientCapability({
        coordinationDir: join(roots.stateRoot, 'coordinations', coordinationId),
      }),
      operation,
      input,
    },
    { timeoutMs: 20_000 },
  );

  const created = await call('task.create', {
    packet: {
      objective: 'coordinator dispatcher FD3 seam probe',
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
  await waitForSettled(supervisor, started.result.dispatchId);
  assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), {
    protocol: 'webmcp-managed-broker/1',
    requestId: 'req_worker_invoke',
    ok: true,
    result: { accepted: true },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].schema, COORDINATOR_DISPATCH_REQUEST_SCHEMA);
  assert.equal(seen[0].tool, 'webmcp.invokeTool');
  assert.equal(seen[0].input.toolName, 'read_summary');
  assert.equal(Object.hasOwn(seen[0], 'permit'), false);
  assert.equal(Object.hasOwn(seen[0], 'workspace'), false);
});
