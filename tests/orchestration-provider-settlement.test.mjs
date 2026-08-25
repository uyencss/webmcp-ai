import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createPublicLifecycle,
  createTrustedCoordinatorConfig,
} from '../src/orchestration/public-adapters.mjs';
import { createClaudeStreamAdapter } from '../src/orchestration/adapters/claude-stream.mjs';
import { createCodexExecAdapter } from '../src/orchestration/adapters/codex-exec.mjs';
import { ORCHESTRATION_PROTOCOL } from '../src/orchestration/constants.mjs';
import { readClientCapability } from '../src/orchestration/authority.mjs';
import { deriveEndpoint, requestIpc } from '../src/orchestration/ipc.mjs';
import {
  resolveOrchestrationRoots,
  createCoordinationLayout,
} from '../src/orchestration/paths.mjs';
import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import {
  normalizeSettlementReceipt,
  SETTLEMENT_PROOF,
} from '../src/orchestration/settlement.mjs';

const FIXTURES = new URL('./fixtures/orchestration/', import.meta.url).pathname;

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r12a-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitWorkspace(t, name) {
  const dir = tempDir(t, name);
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'Fixture']);
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  return dir;
}

let coordCounter = 0;
const COORD = () => `coord_r12a_${(coordCounter += 1)}`;

async function startSupervisor(t, name, { adapters = [] } = {}) {
  const stateDir = tempDir(t, name);
  const coordinationId = COORD();
  const sup = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    mode: 'create',
    coordinationId,
    ...(adapters.length > 0
      ? {
        adapters,
        trustedCoordinatorConfig: {
          allowFixtureDispatch: true,
          confinement: 'disposable-workspace',
          disposableRoot: tmpdir(),
        },
      }
      : {}),
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
  return { sup, stateDir, coordinationId, roots, call };
}

async function seedTask(call, packet) {
  const created = await call('task.create', { packet });
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
  return created.result.taskId;
}

function bindingsRecordPath(roots, coordinationId) {
  return join(roots.stateRoot, 'coordinations', coordinationId, 'runtime-bindings.json');
}

function readBindings(roots, coordinationId) {
  const path = bindingsRecordPath(roots, coordinationId);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')).bindings ?? {};
}

async function waitUntil(call, predicate, timeoutMs = 15_000) {
  let cursor = 0;
  const seen = new Set();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const wait = await call('delivery.wait', { afterSequence: cursor, timeoutMs: 2_000 });
    assert.equal(wait.ok, true, JSON.stringify(wait.error ?? {}));
    for (const delivery of wait.result.deliveries) {
      seen.add(delivery.type);
      cursor = Math.max(cursor, delivery.sequence);
    }
    if (predicate({ seen })) return { seen };
    if (Date.now() > deadline) return { seen, timedOut: true };
  }
}

/* ------------------------------------------------------------------ */
/* R12A unit-level: legacy signal-sent labels are never absence proofs */
/* ------------------------------------------------------------------ */

test('R12A: "stopped" and "killed" adapter dispositions are classified FAILED_UNPROVEN, never absence', () => {
  for (const disposition of ['stopped', 'killed', 'interrupted']) {
    const settlement = normalizeSettlementReceipt({ ok: true, disposition });
    assert.equal(settlement.proof, SETTLEMENT_PROOF.FAILED_UNPROVEN, `${disposition} must not settle`);
    assert.equal(
      [SETTLEMENT_PROOF.PROVEN_EXIT, SETTLEMENT_PROOF.PROVEN_ABSENT].includes(settlement.proof),
      false,
    );
  }
  // Signal-sent receipts keep the fail-closed park semantics.
  assert.equal(normalizeSettlementReceipt({ ok: true, disposition: 'group-signalled' }).proof, SETTLEMENT_PROOF.PENDING_RETRY);
});

/* ------------------------------------------------------------------ */
/* R12A close() honesty: exit proof or explicit non-proof              */
/* ------------------------------------------------------------------ */

function stubbornChild() {
  // Never exits; kill() is swallowed. Simulates a worker surviving signals.
  return {
    exitCode: null,
    signalCode: null,
    pid: process.pid + 100_000,
    once() {},
    off() {},
    on() {},
    kill() { /* survives every signal */ },
  };
}
function dyingChild() {
  let handler = null;
  const child = {
    exitCode: null,
    signalCode: null,
    pid: process.pid + 101_000,
    once(event, fn) { if (event === 'exit') handler = fn; },
    off() { handler = null; },
    on() {},
    kill() {
      child.exitCode = 0;
      if (handler) { const h = handler; handler = null; h(); }
    },
  };
  return child;
}

test('R12A: claude close() claims group-stopped ONLY with exit proof and group-signalled otherwise', async (t) => {
  const stateDir = tempDir(t, 'claude-close');
  const adapter = createClaudeStreamAdapter({
    stateDir,
    claudeBin: process.execPath,
    claudeArgs: ['-e', 'process.exit(0)'],
    closeGraceMsForTest: 40,
    forceCloseGraceMsForTest: 60,
  });

  const survived = await adapter.close({ binding: { __child: stubbornChild() } });
  assert.equal(survived.ok, true);
  assert.equal(survived.disposition, 'group-signalled', 'a surviving worker must NEVER be reported stopped');
  assert.equal(survived.exitProven, undefined, 'no exit proof may be claimed without an exit');

  const exited = await adapter.close({ binding: { __child: dyingChild() } });
  assert.equal(exited.disposition, 'group-stopped');
  assert.equal(exited.exitProven, true, 'group-stopped must carry exit proof');

  const preExited = await adapter.close({ binding: { __child: { exitCode: 0, signalCode: null } } });
  assert.equal(preExited.disposition, 'already-exited');
});

test('R12A: codex close() waits for real exit instead of declaring killed', async (t) => {
  const stateDir = tempDir(t, 'codex-close');
  const adapter = createCodexExecAdapter({
    stateDir,
    codexBin: process.execPath,
    codexArgs: ['-e', 'process.exit(0)'],
    forceCloseGraceMsForTest: 60,
  });

  const survived = await adapter.close({ binding: { __child: stubbornChild() } });
  assert.equal(survived.disposition, 'group-signalled', 'SIGKILL sent but unproven must not read as killed/absent');
  assert.notEqual(survived.disposition, 'killed');

  const exited = await adapter.close({ binding: { __child: dyingChild() } });
  assert.equal(exited.disposition, 'group-stopped');
  assert.equal(exited.exitProven, true);
});

/* ------------------------------------------------------------------ */
/* R12A public lifecycle: Claude/Codex dispatches settle               */
/* ------------------------------------------------------------------ */

function claudeAdapterPair(t, { fakeMode = 'assert-args' } = {}) {
  const stateDir = tempDir(t, 'claude');
  const inner = createClaudeStreamAdapter({
    stateDir,
    claudeBin: process.execPath,
    claudeArgs: [join(FIXTURES, 'fake-claude.mjs')],
    fakeModeEnv: { FAKE_CLAUDE_MODE: fakeMode },
  });
  return { ...inner, lifecycle: createPublicLifecycle('claude-stream', inner, createTrustedCoordinatorConfig({ stateDir, allowFixtureDispatch: true })) };
}

function codexAdapterPair(t, { fakeMode = 'assert-args' } = {}) {
  const stateDir = tempDir(t, 'codex');
  const inner = createCodexExecAdapter({
    stateDir,
    codexBin: process.execPath,
    codexArgs: [join(FIXTURES, 'fake-codex.mjs')],
    fakeModeEnv: { FAKE_CODEX_MODE: fakeMode },
  });
  return { ...inner, lifecycle: createPublicLifecycle('codex-exec', inner, createTrustedCoordinatorConfig({ stateDir, allowFixtureDispatch: true })) };
}

test('R12A: a claude-stream public dispatch settles durably with cleanup evidence and released binding', async (t) => {
  const adapter = claudeAdapterPair(t);
  const workspace = tempDir(t, 'ws-claude');
  const { sup, call, roots, coordinationId } = await startSupervisor(t, 'settle-claude', { adapters: [adapter] });
  const taskId = await seedTask(call, { objective: 'Reply with args-ok', workspace });
  const start = await call('dispatch.start', { taskId, adapterId: 'claude-stream' });
  assert.equal(start.ok, true, JSON.stringify(start.error ?? {}));
  const dispatchId = start.result.dispatchId;

  const { seen, timedOut } = await waitUntil(call, ({ seen }) => seen.has('worker_done') && seen.has('cleanup_recorded'));
  assert.equal(timedOut, undefined, `terminal+cleanup missing; saw ${[...seen].join(',')}`);

  const inspect = await call('coordination.inspect', {});
  assert.equal(inspect.result.dispatches[dispatchId].state, 'settled',
    `dispatch must leave settling on proven release (got ${JSON.stringify(inspect.result.dispatches[dispatchId])})`);
  assert.equal(inspect.result.tasks[taskId].state, 'awaiting_acceptance');
  assert.equal(readBindings(roots, coordinationId)[dispatchId], undefined, 'settled binding must be released durably');
  void sup;
});

test('R12A: a codex-exec public dispatch settles durably after a PROVEN exit', async (t) => {
  const adapter = codexAdapterPair(t);
  const workspace = gitWorkspace(t, 'ws-codex');
  const { sup, call, roots, coordinationId } = await startSupervisor(t, 'settle-codex', { adapters: [adapter] });
  const taskId = await seedTask(call, { objective: 'Reply ok', workspace });
  const start = await call('dispatch.start', { taskId, adapterId: 'codex-exec' });
  assert.equal(start.ok, true, JSON.stringify(start.error ?? {}));
  const dispatchId = start.result.dispatchId;

  const { seen, timedOut } = await waitUntil(call, ({ seen }) => seen.has('worker_done'));
  assert.equal(timedOut, undefined, `terminal missing; saw ${[...seen].join(',')}`);
  const { timedOut: settleTimeout } = await waitUntil(call, () => true, 4_000);

  const inspect = await call('coordination.inspect', {});
  assert.equal(inspect.result.dispatches[dispatchId].state, 'settled',
    `codex dispatch must settle (got ${JSON.stringify(inspect.result.dispatches[dispatchId])})`);
  assert.equal(inspect.result.tasks[taskId].state, 'awaiting_acceptance');
  assert.equal(readBindings(roots, coordinationId)[dispatchId], undefined);
  assert.equal(settleTimeout, undefined);
  void sup;
});

/* ------------------------------------------------------------------ */
/* R12A launch identity: owned provider launches record real identity  */
/* ------------------------------------------------------------------ */

async function collectActiveBinding(call, roots, coordinationId, dispatchId, deadlineMs = 10_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const bindings = readBindings(roots, coordinationId);
    const record = bindings[dispatchId];
    if (record) return record;
    const inspect = await call('coordination.inspect', {});
    if (!inspect.result.dispatches[dispatchId]) throw new Error('dispatch vanished');
    if (['settled', 'lost'].includes(inspect.result.dispatches[dispatchId].state)) return record ?? null;
    if (Date.now() > deadline) return record ?? null;
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));
  }
}

test('R12A: claude/codex launches persist REAL pid + proven start identity, never controlOnly placeholders', { timeout: 30_000 }, async (t) => {
  // trap-signals keeps the worker alive so the durable sidecar is readable
  // while the dispatch is genuinely active.
  const claudeCtx = await startSupervisor(t, 'id-claude', { adapters: [claudeAdapterPair(t, { fakeMode: 'trap-signals' })] });
  const workspaceClaude = tempDir(t, 'ws-idc');
  const claudeTaskId = await seedTask(claudeCtx.call, { objective: 'x', workspace: workspaceClaude });

  const startedClaude = await claudeCtx.call('dispatch.start', { taskId: claudeTaskId, adapterId: 'claude-stream' });
  assert.equal(startedClaude.ok, true, JSON.stringify(startedClaude.error ?? {}));
  const claudeRecord = await collectActiveBinding(claudeCtx.call, claudeCtx.roots, claudeCtx.coordinationId, startedClaude.result.dispatchId);
  assert.ok(claudeRecord, 'claude binding must be recorded while active');
  assert.equal(claudeRecord.controlOnly, false, 'an owned claude launch is NOT control-only');
  assert.ok(Number.isInteger(claudeRecord.processIdentity?.pid) && claudeRecord.processIdentity.pid > 0, 'real pid required');
  assert.equal(claudeRecord.processIdentity.identityProven, true, 'start identity must be honestly proven at launch');
  assert.ok(typeof claudeRecord.processIdentity?.startIdentity === 'string' && claudeRecord.processIdentity.startIdentity.length > 0);
  assert.match(claudeRecord.processIdentity.startIdentity, /^(darwin|linux|win32):/,
    'identity must come from the platform probe, never an indeterminate placeholder');
  assert.doesNotMatch(claudeRecord.processIdentity.startIdentity, /indeterminate/, 'fabricated identities are forbidden');
  try {
    process.kill(-claudeRecord.processIdentity.pid, 'SIGKILL');
  } catch { /* already gone */ }
  await claudeCtx.sup.stop();

  const workspaceCodex = gitWorkspace(t, 'ws-idx');
  const codexCtx = await startSupervisor(t, 'id-codex', { adapters: [codexAdapterPair(t, { fakeMode: 'hold' })] });
  const codexTaskId = await seedTask(codexCtx.call, { objective: 'ok', workspace: workspaceCodex });
  const startedCodex = await codexCtx.call('dispatch.start', { taskId: codexTaskId, adapterId: 'codex-exec' });
  assert.equal(startedCodex.ok, true, JSON.stringify(startedCodex.error ?? {}));
  const codexRecord = await collectActiveBinding(codexCtx.call, codexCtx.roots, codexCtx.coordinationId, startedCodex.result.dispatchId);
  assert.ok(codexRecord, 'codex binding must have been recorded');
  assert.equal(codexRecord.controlOnly, false);
  assert.ok(Number.isInteger(codexRecord.processIdentity?.pid));
  assert.equal(codexRecord.processIdentity.identityProven, true);
  assert.ok(typeof codexRecord.processIdentity.startIdentity === 'string');
  assert.doesNotMatch(codexRecord.processIdentity.startIdentity, /indeterminate/);
  try {
    process.kill(-codexRecord.processIdentity.pid, 'SIGKILL');
  } catch { /* already gone */ }
  await codexCtx.sup.stop();
});

/* ------------------------------------------------------------------ */
/* R12A interrupt honesty: no stopped claim over an unproven stop      */
/* ------------------------------------------------------------------ */

test('R12A: interrupting a surviving claude worker refuses typed WITHOUT claiming stopped', { timeout: 30_000 }, async (t) => {
  const adapter = claudeAdapterPair(t, { fakeMode: 'trap-signals' });
  const workspace = tempDir(t, 'ws-trap');
  const { sup, call, roots, coordinationId } = await startSupervisor(t, 'trap-interrupt', { adapters: [adapter] });
  const taskId = await seedTask(call, { objective: 'trap', workspace });
  const start = await call('dispatch.start', { taskId, adapterId: 'claude-stream' });
  assert.equal(start.ok, true, JSON.stringify(start.error ?? {}));
  const dispatchId = start.result.dispatchId;
  const record = await collectActiveBinding(call, roots, coordinationId, dispatchId);
  assert.ok(record, 'binding must exist before interrupt');
  assert.equal(record.controlOnly, false);

  const stop = await call('dispatch.interrupt', { dispatchId, reason: 'r12a-trap' });
  // The worker traps INT/TERM and survives the whole proof window.
  if (stop.ok === true) {
    assert.notEqual(stop.result.stopped, true, 'interrupt must NEVER claim stopped:true for a surviving worker');
    assert.fail(`surviving worker was reported stopped: ${JSON.stringify(stop.result)}`);
  }
  assert.equal(stop.ok, false);
  assert.equal(stop.error?.code, 'WORKER_STOP_UNPROVEN', JSON.stringify(stop.error ?? {}));

  const inspect = await call('coordination.inspect', {});
  const state = inspect.result.dispatches[dispatchId];
  assert.equal(['active', 'waiting'].includes(state.state), true, `worker still alive; state must stay live (${JSON.stringify(state)})`);

  // Cleanup: force-kill the trapped fixture group so nothing outlives the test.
  try {
    process.kill(-record.processIdentity.pid, 'SIGKILL');
  } catch { /* already gone */ }
  await sup.stop();
});

/* ------------------------------------------------------------------ */
/* R12A indeterminate fabrication ban across production surfaces       */
/* ------------------------------------------------------------------ */

test('R12A: production launch paths contain no fabricated indeterminate identities', async () => {
  const sources = [
    new URL('../src/orchestration/adapters/owned-process.mjs', import.meta.url),
    new URL('../src/orchestration/adapters/opencode-server.mjs', import.meta.url),
    new URL('../src/orchestration/adapters/claude-stream.mjs', import.meta.url),
    new URL('../src/orchestration/adapters/codex-exec.mjs', import.meta.url),
    new URL('../src/orchestration/supervisor.mjs', import.meta.url),
  ];
  for (const url of sources) {
    const text = readFileSync(url, 'utf8');
    // The FORBIDDEN shape is the fabrication itself: interpolating a pid into
    // an "indeterminate" identity placeholder. Detection patterns that merely
    // reference the concept stay legal.
    assert.doesNotMatch(text, /indeterminate-\$\{/, `${url.pathname} fabricates indeterminate identities`);
    assert.doesNotMatch(text, /indeterminate-\d/, `${url.pathname} hardcodes an indeterminate identity`);
  }
});
