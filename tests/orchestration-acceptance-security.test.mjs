import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  REDACTED,
  boundText,
  sanitizeValue,
} from '../src/orchestration/redaction.mjs';
import {
  captureWorkspaceBaseline,
  verifyDispatch,
} from '../src/orchestration/verifier.mjs';
import {
  createPublicLifecycle,
  createTrustedCoordinatorConfig,
  asPublicAdapter,
} from '../src/orchestration/public-adapters.mjs';
import { createOwnedProcessAdapter } from '../src/orchestration/adapters/owned-process.mjs';
import { readClientCapability } from '../src/orchestration/authority.mjs';
import { deriveEndpoint, requestIpc } from '../src/orchestration/ipc.mjs';
import { resolveOrchestrationRoots } from '../src/orchestration/paths.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { ORCHESTRATION_PROTOCOL } from '../src/orchestration/constants.mjs';

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r8c-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitWorkspace(t, name) {
  const dir = tempDir(t, name);
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  execFileSync('mkdir', ['-p', join(dir, 'src2')]);
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'Fixture']);
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  writeFileSync(join(dir, 'src2', 'a.txt'), 'alpha\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  return dir;
}

let coordCounter = 0;
const COORD = () => `coord_r8c_${(coordCounter += 1)}`;

const ALL_BOOLEAN_CAPABILITIES = Object.fromEntries([
  'liveEvents', 'explicitResume', 'externalAttach', 'questionChannel', 'permissionControl',
  'sameTurnSteer', 'gracefulInterrupt', 'preToolGate', 'processOwnership', 'fileEvents', 'testEvents',
].map((key) => [key, false]));

function doneAdapter(doneOutcome) {
  const inner = {
    id: 'owned-process',
    maturity: 'fixture-only',
    capabilities: { ...ALL_BOOLEAN_CAPABILITIES },
    probe: async () => ({ adapterId: 'owned-process', available: true, installedVersion: process.version, sdkVersion: null, maturity: 'fixture-only', capabilities: { ...ALL_BOOLEAN_CAPABILITIES } }),
    spawn: async ({ task, dispatch, emit }) => {
      emit('worker_started', { dispatchId: dispatch.dispatchId });
      const binding = {
        sessionId: 'ses_stub',
        processIdentity: { pid: 999_999_042, startIdentity: 'stub:r8c', processGroupId: 999_999_042 },
      };
      return { ok: true, binding, done: Promise.resolve(doneOutcome) };
    },
    attach() { throw new Error('unsupported'); },
    subscribe() { throw new Error('unsupported'); },
    readSession: async () => null,
    sendReply() { throw new Error('unsupported'); },
    sendGuidance() { throw new Error('unsupported'); },
    resolvePermission() { throw new Error('unsupported'); },
    interrupt: async () => ({ ok: true }),
    close: async () => ({ disposition: 'closed' }),
    sanitize: (event) => event,
  };
  const config = createTrustedCoordinatorConfig({
    stateDir: tmpdir(),
    allowFixtureDispatch: true,
    ownedProcessCommand: { command: process.execPath, args: ['-e', ''], env: {} },
  });
  return asPublicAdapter(inner, createPublicLifecycle('owned-process', inner, config));
}

async function startSupervisor(t, name, { adapters = [], trustedConfig = null } = {}) {
  const stateDir = tempDir(t, name);
  const coordinationId = COORD();
  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'create',
    coordinationId,
    ...(adapters.length > 0 ? { adapters, trustedCoordinatorConfig: (trustedConfig && !('confinement' in trustedConfig))
      ? { ...trustedConfig, confinement: 'disposable-workspace', disposableRoot: tmpdir() }
      : trustedConfig } : {}),
  });
  t.after(() => sup.stop());
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  const call = async (operation, input, requestId = `req_${Math.random().toString(36).slice(2, 8)}`) => requestIpc(
    deriveEndpoint({ ipcRoot: join(roots.stateRoot, 'ipc'), coordinationId }),
    {
      protocol: ORCHESTRATION_PROTOCOL,
      requestId,
      coordinationId,
      fenceEpoch: sup.__store.state.fenceEpoch,
      capability: readClientCapability({ coordinationDir: join(roots.stateRoot, 'coordinations', coordinationId) }),
      operation,
      input,
    },
    { timeoutMs: 20_000 },
  );
  return { sup, stateDir, call };
}

async function seedTask(call, packet) {
  const created = await call('task.create', { packet }, `req_task_${Math.random().toString(36).slice(2, 8)}`);
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  return created.result.taskId;
}

const GREEN_CMD = [process.execPath, '-e', 'process.exit(0)'];
const FAIL_CMD = [process.execPath, '-e', 'process.exit(3)'];

async function runSettledDispatch(t, { doneOutcome, packet }) {
  const adapter = doneAdapter(doneOutcome);
  const { sup, stateDir, call } = await startSupervisor(t, `acc-${Math.random().toString(36).slice(2, 6)}`, {
    adapters: [adapter],
    trustedConfig: { allowFixtureDispatch: true, confinement: 'disposable-workspace', disposableRoot: tmpdir() },
  });
  void stateDir;
  const taskId = await seedTask(call, packet);
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));
  const dispatchId = started.result.dispatchId;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && sup.__store.state.dispatches[dispatchId]?.state !== 'settled') {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(sup.__store.state.dispatches[dispatchId]?.state, 'settled');
  return { sup, call, taskId, dispatchId };
}

test('R8C: verify ignores caller-supplied evidence and uses only durable state', async (t) => {
  const workspace = gitWorkspace(t, 'ws-clean');
  const { call, taskId, dispatchId } = await runSettledDispatch(t, {
    doneOutcome: { terminalType: 'worker_done', exitCode: 0, outcome: 'completed' },
    packet: {
      objective: 'Trusted acceptance',
      workspace,
      allowedReadRoots: [],
      allowedWriteRoots: [],
      acceptanceCommands: [GREEN_CMD],
      commandPolicy: { allowedExecutables: [process.execPath] },
    },
  });

  // Caller tries to smuggle a failing command and a fake baseline.
  const tampered = await call('dispatch.verify', {
    taskId,
    dispatchId,
    commands: [FAIL_CMD],
    baseline: { workspaceRoot: '/nowhere' },
    workerOutcome: 'failed',
    workspace: '/nowhere',
  });
  assert.equal(tampered.ok, false, JSON.stringify(tampered));
  assert.equal(tampered.error.code, 'ORCHESTRATION_INVALID_INPUT', 'caller evidence fields are rejected by the strict contract');

  // The clean request runs the TRUSTED packet command only.
  const honest = await call('dispatch.verify', { taskId, dispatchId });
  assert.equal(honest.ok, true, JSON.stringify(honest.error ?? {}));
  assert.equal(honest.result.verdict, 'accepted', 'durable completed outcome + green trusted commands accept');
});

test('R8C: verification requires the referenced settled dispatch of that task', async (t) => {
  const { call, taskId } = await runSettledDispatch(t, {
    doneOutcome: { terminalType: 'worker_done', exitCode: 0, outcome: 'completed' },
    packet: { objective: 'Binding check', workspace: tempDir(t, 'ws-b'), allowedReadRoots: [], allowedWriteRoots: [] },
  });

  const unknown = await call('dispatch.verify', { dispatchId: 'disp_missing000', taskId });
  assert.equal(unknown.ok, false);
  assert.match(String(unknown.error.code), /NOT_FOUND|INVALID_INPUT/);

  const mismatched = await call('task.create', { packet: { objective: 'other', workspace: '/tmp', allowedReadRoots: [], allowedWriteRoots: [] } });
  const otherTaskId = mismatched.result.taskId;
  const crossed = await call('dispatch.verify', { taskId: otherTaskId });
  assert.equal(crossed.ok, false);
  assert.match(String(crossed.error.code), /NOT_FOUND|INVALID_INPUT/);

  void taskId;
});

test('R8C: green commands cannot accept a non-completed durable outcome', async (t) => {
  const workspace = gitWorkspace(t, 'ws-failed');
  const { call, taskId, dispatchId } = await runSettledDispatch(t, {
    doneOutcome: { terminalType: 'worker_failed', exitCode: 1, outcome: 'failed' },
    packet: {
      objective: 'Failed worker',
      workspace,
      allowedReadRoots: [],
      allowedWriteRoots: [],
      acceptanceCommands: [GREEN_CMD],
      commandPolicy: { allowedExecutables: [process.execPath] },
    },
  });

  const verdictResponse = await call('dispatch.verify', { taskId, dispatchId });
  assert.equal(verdictResponse.ok, true, JSON.stringify(verdictResponse.error ?? {}));
  assert.notEqual(verdictResponse.result.verdict, 'accepted', 'a failed worker outcome can never be accepted');
});

test('R8C: nested sensitive structures collapse to REDACTED', () => {
  const sanitized = sanitizeValue({
    credentials: { password: 'super-secret', host: 'db.internal' },
    token: { value: 'nested-secret' },
    authorization: ['Basic dXNlcjpwYXNz', 'Bearer abc.def.ghi'],
    apiKeyObject: { nested: { deep: 'zzz' } },
  });
  assert.equal(sanitized.credentials, REDACTED, 'object value under sensitive key collapses entirely');
  assert.equal(sanitized.token, REDACTED);
  assert.deepEqual(sanitized.authorization, REDACTED);
  assert.equal(sanitized.apiKeyObject, REDACTED);
});

test('R8C: boundText enforces the advertised byte budget including the marker', () => {
  const bounded = boundText('a'.repeat(500), { maxBytes: 160, label: 'unit' });
  const bytes = Buffer.byteLength(bounded.text, 'utf8');
  assert.equal(bounded.truncated, true);
  assert.equal(bytes <= 160, true, `hard byte cap respected, got ${bytes}`);
  assert.match(bounded.text, /\[TRUNCATED unit originalBytes=500 sha256=[0-9a-f]{64}\]/);

  const tight = boundText('b'.repeat(500), { maxBytes: 100, label: 'unit' });
  assert.equal(Buffer.byteLength(tight.text, 'utf8') <= 100, true, 'hard cap respected when the marker barely fits');

  const tiny = boundText('c'.repeat(50), { maxBytes: 16, label: 'tiny' });
  assert.equal(Buffer.byteLength(tiny.text, 'utf8') <= 16, true, 'even tiny budgets are hard-capped');
});

test('R8C: owned-process stderr drains incrementally instead of at close only', async (t) => {
  const outDir = tempDir(t, 'stderr');
  const workerScript = join(outDir, 'writer.mjs');
  writeFileSync(workerScript, [
    "const burst = 'x'.repeat(300 * 1024);",
    "let n = 0;",
    "const timer = setInterval(() => {",
    "  process.stderr.write(burst);",
    "  n += 1;",
    "  if (n >= 4) { clearInterval(timer); process.exit(0); }",
    "}, 60);",
    '',
  ].join('\n'));

  const events = [];
  const adapter = createOwnedProcessAdapter({ stateDir: join(outDir, 'state') });
  const spawned = await adapter.spawn({
    task: { taskId: 'task_err', workspace: outDir },
    dispatch: { dispatchId: 'disp_err', bindingId: 'worker_err' },
    command: process.execPath,
    args: [workerScript],
    env: {},
    emit: (type, payload) => events.push({ type, payload }),
  });
  await spawned.done;

  const stderrSpills = events.filter(
    (event) => event.type === 'progress' && event.payload?.stream === 'stderr' && event.payload?.ref,
  );
  assert.equal(
    stderrSpills.length >= 2,
    true,
    `stderr spills incrementally during the run, got ${stderrSpills.length}`,
  );
});

test('R8C: deleting a tracked file outside the write roots fails verification', async (t) => {
  const dir = gitWorkspace(t, 'delete');
  const task = {
    taskId: 'task_del',
    workspace: dir,
    protectedPaths: [],
    allowedReadRoots: [dir],
    allowedWriteRoots: [join(dir, 'build')],
  };
  // Supervisor-owned baseline is captured BEFORE the worker mutation.
  const baseline = captureWorkspaceBaseline(task);
  rmSync(join(dir, 'src2', 'a.txt'));
  const receipt = await verifyDispatch({
    task,
    baseline,
    commands: [],
    workerOutcome: 'completed',
    coordinationId: 'coord_test',
    fenceEpoch: 1,
    dispatchId: 'disp_del',
    stateDir: tempDir(t, 'del-state'),
    declaredNestedRepositories: [],
  });
  const kinds = receipt.workspace.violations.map((violation) => violation.kind);
  assert.equal(kinds.includes('delete_outside_allowed_roots'), true, JSON.stringify(receipt.workspace.violations));
  assert.equal(receipt.verdict, 'rejected');
});

test('R8C: rename source paths are checked against the write roots too', async (t) => {
  const dir = gitWorkspace(t, 'rename');
  const task = {
    taskId: 'task_mv',
    workspace: dir,
    protectedPaths: [],
    allowedReadRoots: [dir],
    // Only build/ is writable; src2/ (the rename SOURCE) is not.
    allowedWriteRoots: [join(dir, 'build')],
  };
  // Baseline BEFORE the rename; then the worker renames src2/a.txt (OUTSIDE
  // the declared write root) into build/.
  const baseline = captureWorkspaceBaseline(task);
  execFileSync('mkdir', ['-p', join(dir, 'build')]);
  execFileSync('git', ['-C', dir, 'mv', 'src2/a.txt', join('build', 'moved.txt')]);
  const receipt = await verifyDispatch({
    task,
    baseline,
    commands: [],
    workerOutcome: 'completed',
    coordinationId: 'coord_test',
    fenceEpoch: 1,
    dispatchId: 'disp_mv',
    stateDir: tempDir(t, 'mv-state'),
    declaredNestedRepositories: [],
  });
  const violations = receipt.workspace.violations;
  const flaggedOrigins = violations
    .filter((violation) => violation.kind === 'write_outside_allowed_roots')
    .map((violation) => violation.path);
  assert.equal(
    flaggedOrigins.some((pathValue) => String(pathValue).includes('a.txt')),
    true,
    `rename source outside roots is flagged, got ${JSON.stringify(violations)}`,
  );
});

test('R8C: confinement refuses a nonexistent disposable root', async (t) => {
  const adapter = doneAdapter({ terminalType: 'worker_done', exitCode: 0, outcome: 'completed' });
  const disposableRoot = join(tempDir(t, 'never-created-dir'), 'missing');
  const { call } = await startSupervisor(t, 'confinement', {
    adapters: [adapter],
    trustedConfig: {
      allowFixtureDispatch: true,
      confinement: 'disposable-workspace',
      disposableRoot,
    },
  });
  const taskId = await seedTask(call, {
    objective: 'Mutable work',
    workspace: tempDir(t, 'ws-conf'),
    allowedReadRoots: [],
    allowedWriteRoots: [join(disposableRoot, 'scratch')],
  });
  const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });
  assert.equal(started.ok, false, 'nonexistent disposable root cannot confine anything');
  assert.equal(started.error.code, 'POLICY_DENIED');
});
