#!/usr/bin/env node
// Separately authorized live canary runner for orchestration adapters.
//
// Authorization model (mirrors tests/live/*): the runner refuses to act
// without BOTH global and per-adapter opt-ins:
//   WEBMCP_AI_LIVE_CANARY=1  AND  WEBMCP_AI_LIVE_<OPENCODE|CLAUDE|CODEX|OWNED>=1
// Without them it exits 3 before touching any executable. The runner never
// logs in, never opens provider credential stores, and never writes secrets;
// scenarios are bounded in time and capture only digests/lengths as evidence.
//
// Usage:
//   node scripts/orchestration-live-canary.mjs <adapter-id> [--prompt] [--public] [--timeout-ms N]
//
// Exit codes: 0 pass (receipt recorded & promoted) · 2 usage ·
// 3 gate closed · 4 provider not ready · 5 scenario failed/timed out ·
// 6 CANARY_EVIDENCE_RECORDED (evidence kept, promotion refused).

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { resolveOrchestrationRoots } = await import(join(root, 'src/orchestration/paths.mjs'));
const canaryMod = await import(join(root, 'src/orchestration/canary.mjs'));

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 1)}\n`);
}

function fail(exitCode, code, message, extra = {}) {
  emitJson({ ok: false, code, message, ...extra });
  process.exit(exitCode);
}

// ---- arguments ---------------------------------------------------------------

const args = process.argv.slice(2);
const adapterId = args.find((arg) => !arg.startsWith('--'));
const timeoutMs = Number.parseInt(
  args.includes('--timeout-ms') ? args[args.indexOf('--timeout-ms') + 1] : '120000',
  10,
);
const withPrompt = args.includes('--prompt');
const withPublicPhase = args.includes('--public');

if (!adapterId || Number.isNaN(timeoutMs) || timeoutMs < 1000) {
  fail(2, 'CANARY_USAGE', 'usage: orchestration-live-canary.mjs <owned-process|opencode-server|claude-stream|codex-exec> [--prompt] [--public] [--timeout-ms N]');
}
if (!canaryMod.CANARY_ADAPTER_IDS.includes(adapterId)) {
  fail(2, 'CANARY_USAGE', `unknown adapter ${adapterId}; known: ${canaryMod.CANARY_ADAPTER_IDS.join(', ')}`);
}

// ---- authorization gate ------------------------------------------------------

const perAdapterEnv = `WEBMCP_AI_LIVE_${adapterId.split('-')[0].toUpperCase()}`;
if (process.env.WEBMCP_AI_LIVE_CANARY !== '1' || process.env[perAdapterEnv] !== '1') {
  fail(3, 'CANARY_GATE_CLOSED', `separate authorization required: set WEBMCP_AI_LIVE_CANARY=1 AND ${perAdapterEnv}=1`);
}

// ---- shared context ------------------------------------------------------------

const env = process.env;
const roots = resolveOrchestrationRoots({ env });
const stateDirBase = join(roots.stateRoot, 'canary-work');
mkdirSync(stateDirBase, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(stateDirBase, `${adapterId}-`));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Cleanup hooks registered by scenarios. On timeout they run to completion —
 * awaited, in reverse order — BEFORE the typed timeout surfaces, so no owned
 * child, server or session outlives the harness decision.
 */
const cleanupHooks = [];
function registerCleanup(label, fn) {
  cleanupHooks.push({ label, fn });
}
async function flushCleanup() {
  for (const { label, fn } of cleanupHooks.reverse()) {
    try {
      await fn();
    } catch (error) {
      emitJson({ ok: false, code: 'CANARY_CLEANUP_ERROR', message: `cleanup '${label}' failed: String(error?.message ?? error)`.slice(0, 300), adapterId });
    }
  }
}

/** Capability map scaffold: everything starts unsupported and gets upgraded. */
function capabilityScaffold() {
  return Object.fromEntries(canaryMod.CANARY_CAPABILITIES.map((capability) => [capability, 'unsupported']));
}

/**
 * EXACT success contract: the scenario passes only when EVERY REQUIRED
 * capability for this adapter reads 'pass'. Capabilities outside the required
 * set may stay 'unsupported' without failing the scenario — but a receipt
 * whose required set is not fully green can never promote (it is recorded as
 * truthful partial evidence instead).
 */
function requiredCapabilitiesSatisfied(capabilities) {
  return canaryMod.requiredCapabilitiesFor(adapterId)
    .every((capability) => capabilities?.[capability] === 'pass');
}

async function boundedVersionProbe(binPath, versionArgs) {
  const run = spawnSync(binPath, versionArgs, {
    cwd: root,
    shell: false,
    encoding: 'utf8',
    timeout: 15_000,
    env,
  });
  if (run.error || run.status !== 0) return null;
  return String(run.stdout ?? '').trim().split(/\r?\n/)[0] ?? null;
}

async function runScenario() {
  switch (adapterId) {
    case 'owned-process':
      return scenarioOwnedProcess();
    case 'opencode-server':
      return scenarioOpenCodeServer();
    case 'claude-stream':
      return scenarioClaudeStream();
    case 'codex-exec':
      return scenarioCodexExec();
    default:
      throw new Error('unreachable');
  }
}

// ---- scenarios ------------------------------------------------------------------

async function scenarioOwnedProcess() {
  const { createOwnedProcessAdapter } = await import(join(root, 'src/orchestration/adapters/owned-process.mjs'));
  const adapter = createOwnedProcessAdapter({ stateDir: scratch });
  const events = [];
  const capabilities = capabilityScaffold();
  const spawned = await adapter.spawn({
    task: { taskId: 'task_canary', workspace: scratch },
    dispatch: { dispatchId: 'disp_canary', bindingId: 'worker_canary' },
    command: process.execPath,
    args: ['-e', 'process.stdout.write("canary-ok\\n"); process.exit(0)'],
    emit: (type, payload) => events.push({ type, blob: JSON.stringify(payload ?? {}).slice(0, 300) }),
  });
  registerCleanup('owned worker stop', async () => {
    if (spawned?.binding) await adapter.close({ binding: spawned.binding }).catch(() => {});
  });

  const terminal = await spawned.done;
  capabilities.launch = spawned.binding?.processIdentity?.startIdentity ? 'pass' : 'fail';
  capabilities.progressStream = events.some((entry) => entry.type === 'progress') ? 'pass' : 'fail';
  // Success is the EXACT required-capability verdict, never a blanket guess.
  let ok = terminal.terminalType === 'worker_done' && terminal.exitCode === 0
    && capabilities.launch === 'pass';
  if (!ok) {
    capabilities.progressStream = terminal.terminalType === 'worker_done' && terminal.exitCode === 0
      ? capabilities.progressStream
      : 'fail';
    return {
      ok,
      evidence: { terminalType: terminal.terminalType, exitCode: terminal.exitCode },
      capabilities,
      executableVersion: process.version,
    };
  }
  let cleanupProven = false;
  try {
    const closed = await adapter.close({ binding: spawned.binding });
    cleanupProven = Boolean(closed);
  } catch {
    cleanupProven = false;
  }
  capabilities.cleanup = cleanupProven ? 'pass' : 'fail';

  if (withPublicPhase) {
    // The public phase MUST target this adapter kind: it drives a REAL
    // supervisor through task.create -> dispatch.start -> delivery.wait ->
    // coordination.inspect for the owned-process fixture.
    const publicPhase = await runPublicSupervisorPhase('owned-process');
    capabilities.publicSupervisorLifecycle = publicPhase.pass ? 'pass' : 'fail';
    return {
      ok: requiredCapabilitiesSatisfied(capabilities),
      evidence: { terminalType: terminal.terminalType, exitCode: terminal.exitCode, ...publicPhase.evidence },
      capabilities,
      executableVersion: process.version,
    };
  }

  return {
    ok: requiredCapabilitiesSatisfied(capabilities),
    evidence: {
      terminalType: terminal.terminalType,
      exitCode: terminal.exitCode,
      identityProven: Boolean(spawned.binding?.processIdentity?.startIdentity),
      eventTypes: [...new Set(events.map((entry) => entry.type))].sort(),
      durationNote: 'bounded trivial worker; no provider dependency',
    },
    capabilities,
    executableVersion: process.version,
  };
}

/**
 * Public supervisor lifecycle proof, GENERIC across adapters: a real
 * supervisor is driven through the PUBLIC operation table — task.create →
 * dispatch.start → delivery.wait → coordination.inspect — and this phase IS
 * the prompt round trip. One bounded model interaction proves launch, SSE/
 * stream progress, the exact reply text and clean settlement simultaneously;
 * no duplicate model prompts are spent elsewhere.
 */
async function runPublicSupervisorPhase(targetKind, { objective = 'Reply with exactly: ok' } = {}) {
  const stateMod = await import(join(root, 'src/orchestration/paths.mjs'));
  const authorityMod = await import(join(root, 'src/orchestration/authority.mjs'));
  const ipcMod = await import(join(root, 'src/orchestration/ipc.mjs'));
  const constantsMod = await import(join(root, 'src/orchestration/constants.mjs'));
  const supervisorMod = await import(join(root, 'src/orchestration/supervisor.mjs'));
  const publicAdaptersMod = await import(join(root, 'src/orchestration/public-adapters.mjs'));

  // macOS sun_path is capped at 104 bytes: the PUBLIC supervisor gets its own
  // SHORT temp state root instead of nesting under the long canary-work dir.
  const publicStateRoot = mkdtempSync(join(tmpdir(), 'w8pub-'));
  registerCleanup('public state cleanup', () => rmSync(publicStateRoot, { recursive: true, force: true }));
  const coordinationId = `coord_canary_${Date.now().toString(36)}`;
  const supEnv = { ...env, WEBMCP_AI_ORCHESTRATION_STATE_DIR: publicStateRoot };
  const rootsLocal = stateMod.resolveOrchestrationRoots({ env: supEnv });
  const isOwnedFixture = targetKind === 'owned-process';
  // The public phase runs under VALID disposable confinement: the whole
  // phase state root IS the disposable workspace and every task workspace
  // lives inside it. Preventive confinement is part of what the canary
  // proves — a dispatch that cannot be confined honestly must fail here.
  const config = publicAdaptersMod.createTrustedCoordinatorConfig({
    stateDir: join(publicStateRoot, 'trusted'),
    allowFixtureDispatch: isOwnedFixture,
    confinement: 'disposable-workspace',
    disposableRoot: publicStateRoot,
    openCodeBin: env.OPENCODE_BIN ?? 'opencode',
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    codexBin: env.CODEX_BIN ?? 'codex',
    ...(isOwnedFixture ? {
      ownedProcessCommand: {
        command: process.execPath,
        args: [join(root, 'tests/fixtures/orchestration/fake-worker.mjs')],
        env: { ...env, FAKE_WORKER_MODE: 'ordered' },
      },
    } : {}),
  });

  let adapter = null;
  if (isOwnedFixture) {
    const ownedMod = await import(join(root, 'src/orchestration/adapters/owned-process.mjs'));
    const inner = ownedMod.createOwnedProcessAdapter({ stateDir: join(publicStateRoot, 'op') });
    adapter = publicAdaptersMod.asPublicAdapter(
      inner,
      publicAdaptersMod.createPublicLifecycle('owned-process', inner, config),
    );
  } else {
    const adapters = publicAdaptersMod.createPublicAdapters(config);
    adapter = adapters.find((entry) => entry.id === targetKind) ?? null;
  }
  if (!adapter) return { pass: false, evidence: { reason: `no public adapter assembled for ${targetKind}` } };

  let workspace = join(publicStateRoot, `ws-${targetKind}`);
  mkdirSync(workspace, { recursive: true });
  if (targetKind === 'codex-exec') {
    workspace = join(publicStateRoot, 'repo');
    const gitInit = spawnSync('git', ['init', '-q', workspace], { shell: false, encoding: 'utf8', env });
    if (gitInit.status !== 0) return { pass: false, evidence: { reason: 'codex public phase could not prepare its git workspace' } };
  }

  let sup = null;
  try {
    sup = await supervisorMod.createSupervisor({
      env: supEnv,
      mode: 'create',
      coordinationId,
      adapters: [adapter],
      trustedCoordinatorConfig: {
        allowFixtureDispatch: isOwnedFixture,
        confinement: 'disposable-workspace',
        disposableRoot: publicStateRoot,
        ...(isOwnedFixture ? {} : { allowUnprovenProviderDispatch: true }),
      },
    });
    registerCleanup('public supervisor stop', () => sup?.stop?.());

    const call = async (operation, input) => ipcMod.requestIpc(
      ipcMod.deriveEndpoint({ ipcRoot: join(rootsLocal.stateRoot, 'ipc'), coordinationId }),
      {
        protocol: constantsMod.ORCHESTRATION_PROTOCOL,
        requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
        coordinationId,
        fenceEpoch: sup.__store.state.fenceEpoch,
        capability: authorityMod.readClientCapability({ coordinationDir: join(rootsLocal.stateRoot, 'coordinations', coordinationId) }),
        operation,
        input,
      },
      { timeoutMs: 20_000 },
    );

    const created = await call('task.create', {
      packet: { objective, workspace, allowedReadRoots: [workspace], allowedWriteRoots: [] },
    });
    if (!created.ok) return { pass: false, evidence: { reason: `task.create failed: ${created.error?.code ?? '?'}` } };
    const taskId = created.result.taskId;
    const startResponse = await call('dispatch.start', { taskId, adapterId: targetKind });
    if (!startResponse.ok) return { pass: false, evidence: { reason: `dispatch.start failed: ${startResponse.error?.code ?? '?'}` } };
    const dispatchId = startResponse.result.dispatchId;

    const seen = new Set();
    let cursor = 0;
    let progressEvents = 0;
    let doneSummary = null;
    let responseText = null;
    const deadline = Date.now() + Math.min(timeoutMs, 90_000);
    for (;;) {
      const wait = await call('delivery.wait', { afterSequence: cursor, timeoutMs: 2_000 });
      if (!wait.ok) break;
      for (const delivery of wait.result.deliveries ?? []) {
        seen.add(delivery.type);
        if (delivery.type === 'progress') progressEvents += 1;
        if (typeof delivery.payload?.responseText === 'string') {
          responseText = delivery.payload.responseText.trim().slice(0, 2000);
        }
        if (delivery.type === 'worker_done') {
          doneSummary = String(delivery.payload?.summary ?? '').trim();
        }
        cursor = Math.max(cursor, delivery.sequence);
      }
      if (
        (seen.has('worker_done') || seen.has('worker_failed') || seen.has('worker_cancelled'))
        && seen.has('cleanup_recorded')
      ) break;
      if (Date.now() > deadline) break;
    }

    const inspect = await call('coordination.inspect', {});
    const state = inspect.ok ? inspect.result.dispatches?.[dispatchId]?.state : null;
    const outcome = inspect.ok ? inspect.result.dispatches?.[dispatchId]?.terminalOutcome : null;
    const settled = state === 'settled';
    const completed = outcome === 'completed';
    const pass = seen.has('worker_started') && seen.has('worker_done') && seen.has('cleanup_recorded') && settled && completed;
    return {
      pass,
      startedOk: true,
      progressEvents,
      doneSummary,
      responseText,
      cleanupDisposition: null,
      sessionId: startResponse.result.sessionId ?? null,
      settled,
      completed,
      evidence: { publicLifecycleEvents: [...seen].sort(), dispatchState: state, terminalOutcome: outcome },
    };
  } finally {
    if (sup) await sup.stop?.().catch(() => {});
  }
}

async function scenarioOpenCodeServer() {
  const serverMod = await import(join(root, 'src/orchestration/adapters/opencode-server.mjs'));
  const binPath = env.OPENCODE_BIN ?? 'opencode';
  const installedVersion = await boundedVersionProbe(binPath, ['--version']);
  if (installedVersion !== '1.18.21') {
    return { notReady: true, reason: `pinned opencode 1.18.21 required, found ${installedVersion ?? 'none'}` };
  }
  const adapter = serverMod.createOpenCodeServerAdapter({
    openCodeBin: binPath,
    stateDir: join(scratch, 'state'),
  });
  const capabilities = capabilityScaffold();

  let started = null;
  try {
    started = await adapter.startRuntimeServer({ workspace: scratch, bindingId: 'worker_canary', fenceEpoch: 1 });
    registerCleanup('opencode server stop', async () => {
      if (started?.runtime) await adapter.stopServer(started.runtime).catch(() => {});
    });

    const health = await adapter.requestJson(started.runtime, 'GET', '/global/health');
    if (!health.ok || !(health.json?.status === 'ok' || health.json?.healthy === true)) {
      throw new Error('global health check failed against the real binary');
    }
    capabilities.launch = 'pass';

    // The PUBLIC supervisor phase IS the prompt round trip: SSE progress and
    // the exact reply text are earned there in a single bounded model call.
    const phase = await runPublicSupervisorPhase('opencode-server');
    capabilities.progressStream = (phase.progressEvents ?? 0) > 0 ? 'pass' : 'fail';
    capabilities.promptRoundTrip = phase.doneSummary?.toLowerCase() === 'ok' ? 'pass' : 'fail';
    capabilities.publicSupervisorLifecycle = phase.pass ? 'pass' : 'fail';

    const dbInsideRuntimeTree = String(started.runtime.dbPath).includes('webmcp-ai-runtime');
    if (!dbInsideRuntimeTree) throw new Error('runtime database escaped the owned tree');
    // The cleanup capability means EXACTLY this contract: an explicit,
    // settled release whose absence is proven over the whole runtime tree.
    const stopReceipt = await adapter.stopServer(started.runtime, { release: true, settled: true });
    if (stopReceipt.disposition !== 'stopped') throw new Error(`unexpected stop disposition ${stopReceipt.disposition}`);
    capabilities.cleanup = stopReceipt.released === true && stopReceipt.absenceProven === true ? 'pass' : 'fail';

    return {
      ok: requiredCapabilitiesSatisfied(capabilities),
      evidence: {
        healthOk: true,
        databaseIdentity: started.runtime.databaseIdentity.slice(0, 16),
        isolatedDb: true,
        stopDisposition: stopReceipt.disposition,
        sseProgressEvents: phase.progressEvents,
        doneSummary: phase.doneSummary,
        ...phase.evidence,
      },
      capabilities,
      executableVersion: installedVersion,
    };
  } finally {
    if (started?.runtime) await adapter.stopServer(started.runtime).catch(() => {});
  }
}

async function scenarioClaudeStream() {
  const claudeMod = await import(join(root, 'src/orchestration/adapters/claude-stream.mjs'));
  const binPath = env.CLAUDE_BIN ?? 'claude';
  const installedVersion = await boundedVersionProbe(binPath, ['--version']);
  if (!installedVersion) {
    return { notReady: true, reason: 'claude binary did not answer a bounded --version probe' };
  }
  // NOTE: there is NO separate model-call authentication precheck. Auth
  // problems surface through the public phase itself and simply fail the
  // scenario; the harness never spends an extra model prompt on probing.
  const adapter = claudeMod.createClaudeStreamAdapter({
    claudeBin: binPath,
    stateDir: join(scratch, 'state'),
  });
  const capabilities = capabilityScaffold();

  // The PUBLIC supervisor phase IS turn one: launch, stream progress and the
  // exact `ok` round trip are all earned there.
  const phase = await runPublicSupervisorPhase('claude-stream');
  capabilities.launch = phase.startedOk ? 'pass' : 'fail';
  capabilities.progressStream = (phase.progressEvents ?? 0) > 0 ? 'pass' : 'fail';
  capabilities.promptRoundTrip = phase.doneSummary?.toLowerCase() === 'ok' ? 'pass' : 'fail';
  capabilities.publicSupervisorLifecycle = phase.pass ? 'pass' : 'fail';
  const sessionId = phase.sessionId ?? null;

  if (!sessionId || capabilities.promptRoundTrip !== 'pass') {
    // Without a proven session id or a correct first answer there is nothing
    // to resume — record honest unsupported instead of pretending.
    capabilities.continuationResume = sessionId ? 'fail' : 'unsupported';
    capabilities.cleanup = capabilities.publicSupervisorLifecycle;
    return {
      ok: false,
      evidence: {
        observedEvents: ['public-phase'],
        resultTexts: [phase.doneSummary],
        sessionId,
      },
      capabilities,
      executableVersion: installedVersion,
    };
  }

  // Turn two: a SECOND process resumed from the recorded session proves
  // continuation as its own distinct capability (one extra model call).
  const secondEvents = [];
  const second = await adapter.spawn({
    task: { taskId: 'task_canary2', workspace: scratch, objective: 'Reply with exactly: ping-pong' },
    dispatch: { dispatchId: 'disp_canary2', bindingId: 'worker_canary2', taskId: 'task_canary2', fenceEpoch: 1 },
    emit: (type, payload) => secondEvents.push({ type, blob: JSON.stringify(payload ?? {}).slice(0, 400) }),
    resumeSessionId: sessionId,
  });
  registerCleanup('claude resume worker stop', async () => {
    second?.binding?.__child?.kill?.('SIGKILL');
  });
  if (second.ok === false) throw new Error(`resume spawn rejected: ${second.error?.code ?? 'unknown'}`);
  const terminal2 = await second.done;
  const secondTexts = secondEvents
    .filter((entry) => entry.type === 'worker_done')
    .map((entry) => {
      try { return String(JSON.parse(entry.blob).summary ?? '').trim(); } catch { return ''; }
    });
  capabilities.continuationResume = secondTexts.includes('ping-pong') ? 'pass' : 'fail';
  capabilities.cleanup = ['worker_done', 'worker_failed'].includes(terminal2.terminalType) ? 'pass' : 'fail';

  return {
    ok: requiredCapabilitiesSatisfied(capabilities),
    evidence: {
      turnOne: { doneSummary: phase.doneSummary, progressEvents: phase.progressEvents },
      turnTwo: { terminalType: terminal2.terminalType, resultTexts: secondTexts },
      modelCallBudgetUsed: 2,
    },
    capabilities,
    executableVersion: installedVersion,
  };
}

async function scenarioCodexExec() {
  const binPath = env.CODEX_BIN ?? 'codex';
  const installedVersion = await boundedVersionProbe(binPath, ['--version']);
  if (!installedVersion) {
    return { notReady: true, reason: 'codex binary did not answer a bounded --version probe' };
  }
  // exec requires a Git workspace; build a disposable one-person repo.
  const workspace = join(scratch, 'repo');
  const gitInit = spawnSync('git', ['init', '-q', workspace], { shell: false, encoding: 'utf8', env });
  if (gitInit.status !== 0) throw new Error('could not prepare a disposable git workspace');

  // The PUBLIC supervisor phase is the ENTIRE codex scenario: one bounded
  // model call proves launch, stream progress, the EXACT reply text and
  // settlement through the public operation table.
  const phase = await runPublicSupervisorPhase('codex-exec');
  const capabilities = capabilityScaffold();
  capabilities.launch = phase.startedOk ? 'pass' : 'fail';
  capabilities.progressStream = (phase.progressEvents ?? 0) > 0 ? 'pass' : 'fail';
  capabilities.promptRoundTrip = phase.responseText?.toLowerCase() === 'ok' ? 'pass' : 'fail';
  capabilities.cleanup = phase.pass ? 'pass' : 'fail';
  capabilities.publicSupervisorLifecycle = phase.pass ? 'pass' : 'fail';

  return {
    ok: requiredCapabilitiesSatisfied(capabilities),
    evidence: {
      doneSummary: phase.doneSummary,
      responseText: phase.responseText,
      progressEvents: phase.progressEvents,
      modelCallBudgetUsed: 1,
      ...phase.evidence,
    },
    capabilities,
    executableVersion: installedVersion,
  };
}

// ---- execution -------------------------------------------------------------------

let scenario;
try {
  scenario = await canaryMod.runBoundedScenario(adapterId, timeoutMs, runScenario, {
    onCancel: flushCleanup,
  });
} catch (error) {
  const timedOut = error?.code === 'CANARY_TIMEOUT';
  if (!timedOut) fail(5, 'CANARY_SCENARIO_FAILED', String(error?.message ?? error).slice(0, 500), { adapterId });
  // A timeout already awaited every registered cleanup hook.
  fail(5, 'CANARY_TIMEOUT', String(error?.message ?? error).slice(0, 500), { adapterId });
}
if (scenario.notReady) {
  await flushCleanup();
  fail(4, 'CANARY_PROVIDER_NOT_READY', scenario.reason, { adapterId });
}
if (!scenario.capabilities || typeof scenario.capabilities !== 'object') {
  await flushCleanup();
  fail(5, 'CANARY_SCENARIO_FAILED', 'scenario finished without a capability verdict map', { adapterId, evidence: scenario.evidence });
}
// A scenario that finished but did not satisfy EVERY required capability
// still produced honest evidence: it is RECORDED truthfully and promotion is
// refused below (exit 6) — never silently discarded as a hard failure.
if (!scenario.ok) {
  await flushCleanup();
}

const resolvedExecutable = canaryMod.resolveExecutableDigest(adapterId, { env });
if (!resolvedExecutable) {
  fail(4, 'CANARY_PROVIDER_NOT_READY', `resolved executable not found: ${canaryMod.resolveAdapterExecutablePath(adapterId, { env })}`, { adapterId });
}
const executablePathDigest = resolvedExecutable.digest;
const executablePath = resolvedExecutable.path;

const receipt = canaryMod.recordCanaryReceipt(roots.stateRoot, {
  adapterId,
  adapterDigest: canaryMod.canaryAdapterDigest(adapterId),
  executablePathDigest,
  executablePath,
  executableVersion: scenario.executableVersion,
  runtimeVersion: process.version,
  platformIdentity: `${process.platform}/${process.arch}`,
  contractVersion: canaryMod.CANARY_CONTRACT_VERSION,
  capabilities: scenario.capabilities,
  expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  scenario: adapterId
    + (withPrompt && adapterId === 'opencode-server' ? '+prompt' : '')
    + (withPublicPhase ? '+public' : ''),
  evidence: scenario.evidence,
});

// Promotion decision is PURE and exact: the just-written receipt must
// re-evaluate as canary-proven in THIS environment right now (adapter
// digest, canonical executable path + content digest, version, runtime AND
// every required per-adapter capability). Anything less stays recorded
// evidence under a DIFFERENT code and never claims passed/promoted.
const decision = canaryMod.decideCanaryOutcome({
  receipt,
  binding: {
    adapterDigest: receipt.adapterDigest,
    executablePathDigest: receipt.executablePathDigest,
    executablePath: receipt.executablePath,
    installedVersion: receipt.executableVersion,
    runtimeVersion: receipt.runtimeVersion,
    requiredCapabilities: canaryMod.requiredCapabilitiesFor(adapterId),
  },
});

if (!decision.promoted) {
  emitJson({
    ok: false,
    code: 'CANARY_EVIDENCE_RECORDED',
    message: `evidence recorded; promotion refused (${decision.staleReason})`,
    adapterId,
    staleReason: decision.staleReason,
    requiredCapabilities: canaryMod.requiredCapabilitiesFor(adapterId),
    receiptPath: canaryMod.canaryReceiptPath(roots.stateRoot, adapterId),
  });
  process.exit(6);
}

emitJson({
  ok: true,
  code: 'CANARY_PASSED',
  adapterId,
  maturityNow: 'canary-proven',
  receiptPath: canaryMod.canaryReceiptPath(roots.stateRoot, adapterId),
  receipt: {
    createdAt: receipt.createdAt,
    executableVersion: receipt.executableVersion,
    runtimeVersion: receipt.runtimeVersion,
    scenario: receipt.scenario,
  },
});
