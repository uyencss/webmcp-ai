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
// Exit codes: 0 pass (receipt recorded) · 2 usage · 3 gate closed ·
// 4 provider not ready · 5 scenario failed.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { resolveOrchestrationRoots } = await import(join(root, 'src/orchestration/paths.mjs'));
const canaryMod = await import(join(root, 'src/orchestration/canary.mjs'));
const adaptersIndex = await import(join(root, 'src/orchestration/adapters/index.mjs'));

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
  // A trivial canary cannot honestly claim interactive control evidence.
  const ok = terminal.terminalType === 'worker_done' && terminal.exitCode === 0;
  if (!ok) {
    capabilities.progressStream = 'fail';
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
    const publicPhase = await runPublicSupervisorPhase();
    capabilities.publicSupervisorLifecycle = publicPhase.pass ? 'pass' : 'fail';
    return {
      ok: publicPhase.pass,
      evidence: { terminalType: terminal.terminalType, exitCode: terminal.exitCode, ...publicPhase.evidence },
      capabilities,
      executableVersion: process.version,
    };
  }

  return {
    ok: true,
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
 * Public supervisor lifecycle proof for the owned-process canary: a real
 * supervisor is started against a scratch state root and the fixture worker
 * runs through the PUBLIC operation table — task.create → dispatch.start →
 * delivery.wait → coordination.inspect — never through direct adapter calls.
 * Generic across adapters: provider kinds assemble their REAL trusted config
 * (binaries from env) through createPublicAdapters.
 */
async function runPublicSupervisorPhase(targetKind = 'owned-process') {
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
  const config = publicAdaptersMod.createTrustedCoordinatorConfig({
    stateDir: join(publicStateRoot, 'trusted'),
    allowFixtureDispatch: isOwnedFixture,
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
      packet: { objective: 'Reply with exactly: ok', workspace, allowedReadRoots: [workspace], allowedWriteRoots: [] },
    });
    if (!created.ok) return { pass: false, evidence: { reason: `task.create failed: ${created.error?.code ?? '?'}` } };
    const taskId = created.result.taskId;
    const startResponse = await call('dispatch.start', { taskId, adapterId: targetKind });
    if (!startResponse.ok) return { pass: false, evidence: { reason: `dispatch.start failed: ${startResponse.error?.code ?? '?'}` } };
    const dispatchId = startResponse.result.dispatchId;

    const seen = new Set();
    let cursor = 0;
    const deadline = Date.now() + Math.min(timeoutMs, 30_000);
    for (;;) {
      const wait = await call('delivery.wait', { afterSequence: cursor, timeoutMs: 2_000 });
      if (!wait.ok) break;
      for (const delivery of wait.result.deliveries ?? []) {
        seen.add(delivery.type);
        cursor = Math.max(cursor, delivery.sequence);
      }
      if (seen.has('worker_done') && seen.has('cleanup_recorded')) break;
      if (Date.now() > deadline) break;
    }

    const inspect = await call('coordination.inspect', {});
    const state = inspect.ok ? inspect.result.dispatches?.[dispatchId]?.state : null;
    const outcome = inspect.ok ? inspect.result.dispatches?.[dispatchId]?.terminalOutcome : null;
    const pass = seen.has('worker_started') && seen.has('worker_done') && seen.has('cleanup_recorded') && state === 'settled' && outcome === 'completed';
    return { pass, evidence: { publicLifecycleEvents: [...seen].sort(), dispatchState: state, terminalOutcome: outcome } };
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

    const session = await adapter.createSession(started.runtime);
    const deleted = await adapter.requestJson(
      started.runtime,
      'DELETE',
      `/session/${encodeURIComponent(session.sessionId)}`,
    );
    if (!deleted.ok) throw new Error('session delete failed over the documented surface');
    capabilities.progressStream = 'unsupported';

    if (withPrompt) {
      try {
        const created = await adapter.createSession(started.runtime);
        await adapter.promptAsync(started.runtime, created.sessionId, 'Reply with exactly: ok');
        const deadline = Date.now() + Math.min(timeoutMs, 90_000);
        let finalText = null;
        while (Date.now() < deadline) {
          const view = await adapter.readSession(started.runtime, created.sessionId);
          const status = view?.status ?? (Array.isArray(view?.messages) && view.messages.length > 0 ? 'idle' : null);
          if (status === 'idle') {
            finalText = JSON.stringify(view ?? {}).slice(0, 200_000);
            break;
          }
          await new Promise((resolveTick) => setTimeout(resolveTick, 500));
        }
        if (finalText === null) throw new Error('prompt round trip did not settle before the bound');
        capabilities.promptRoundTrip = /ok/i.test(finalText) ? 'pass' : 'fail';
      } catch {
        capabilities.promptRoundTrip = 'fail';
      }
    }

    const dbInsideRuntimeTree = String(started.runtime.dbPath).includes('webmcp-ai-runtime');
    if (!dbInsideRuntimeTree) throw new Error('runtime database escaped the owned tree');
    const stopReceipt = await adapter.stopServer(started.runtime);
    if (stopReceipt.disposition !== 'stopped') throw new Error(`unexpected stop disposition ${stopReceipt.disposition}`);
    capabilities.cleanup = stopReceipt.released ? 'pass' : 'fail';

    if (withPublicPhase) {
      const publicPhase = await runPublicSupervisorPhase('opencode-server');
      capabilities.publicSupervisorLifecycle = publicPhase.pass ? 'pass' : 'fail';
      return {
        ok: publicPhase.pass,
        evidence: {
          healthOk: true,
          sessionLifecycleOk: true,
          databaseIdentity: started.runtime.databaseIdentity.slice(0, 16),
          isolatedDb: true,
          stopDisposition: stopReceipt.disposition,
          promptRoundTrip: withPrompt ? capabilities.promptRoundTrip : 'unsupported',
          ...publicPhase.evidence,
        },
        capabilities,
        executableVersion: installedVersion,
      };
    }

    return {
      ok: Object.entries(capabilities).every(([name, verdict]) => name === 'publicSupervisorLifecycle' || verdict !== 'fail'),
      evidence: {
        healthOk: true,
        sessionLifecycleOk: true,
        databaseIdentity: started.runtime.databaseIdentity.slice(0, 16),
        isolatedDb: true,
        stopDisposition: stopReceipt.disposition,
        promptRoundTrip: withPrompt ? capabilities.promptRoundTrip : 'unsupported',
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
  // Auth pre-check: a tiny direct -p turn surfaces expired OAuth without any
  // login attempt; the harness never refreshes credentials itself.
  const authProbe = spawnSync(binPath, ['-p', '--output-format', 'json', 'Reply with exactly: ok'], {
    cwd: scratch,
    shell: false,
    encoding: 'utf8',
    timeout: 60_000,
    env,
    input: '',
  });
  const probeOut = String(authProbe.stdout ?? '');
  if (/failed to authenticate|authentication_failed|oauth session expired/i.test(probeOut)) {
    return {
      notReady: true,
      reason: 'claude authentication is expired or missing; refresh it yourself outside this harness',
    };
  }
  const adapter = claudeMod.createClaudeStreamAdapter({
    claudeBin: binPath,
    stateDir: join(scratch, 'state'),
  });
  const capabilities = capabilityScaffold();

  // Two-prompt SESSION-RESUME protocol (contract v1): turn one runs in its
  // own process and must return EXACTLY `ok`; turn two starts a SECOND
  // process resumed with --resume <sessionId> and must return EXACTLY
  // `ping-pong`. Anything else fails its specific capability.
  function collectResultTexts(eventLog) {
    return eventLog
      .filter((entry) => entry.type === 'worker_done')
      .map((entry) => {
        try {
          const payload = JSON.parse(entry.blob);
          return String(payload.summary ?? '').trim();
        } catch {
          return '';
        }
      });
  }

  const firstEvents = [];
  let spawned = await adapter.spawn({
    task: { taskId: 'task_canary', workspace: scratch, objective: 'Reply with exactly: ok' },
    dispatch: { dispatchId: 'disp_canary', bindingId: 'worker_canary', taskId: 'task_canary', fenceEpoch: 1 },
    emit: (type, payload) => firstEvents.push({ type, blob: JSON.stringify(payload ?? {}).slice(0, 400) }),
  });
  registerCleanup('claude worker stop', async () => {
    spawned?.binding?.__child?.kill?.('SIGKILL');
  });
  if (spawned.ok === false) throw new Error(`spawn rejected: ${spawned.error?.code ?? 'unknown'}`);
  capabilities.launch = 'pass';
  // The adapter writes the objective to stdin and closes it; the real `-p`
  // process settles on its own.
  const terminal1 = await spawned.done;
  const blobs1 = firstEvents.map((entry) => entry.blob).join(' ');
  if (/Failed to authenticate|authentication_failed|oauth session expired/i.test(blobs1)) {
    return {
      notReady: true,
      reason: 'claude authentication is expired or missing; refresh it yourself outside this harness',
    };
  }
  capabilities.progressStream = firstEvents.some((entry) => entry.type === 'progress') ? 'pass' : 'fail';
  const firstTexts = collectResultTexts(firstEvents);
  capabilities.promptRoundTrip = firstTexts.includes('ok') ? 'pass' : 'fail';
  const sessionId = spawned.binding?.sessionId ?? terminal1?.sessionId ?? null;

  if (!sessionId || capabilities.promptRoundTrip !== 'pass') {
    // Without a proven session id or a correct first answer there is nothing
    // to resume — record honest unsupported instead of pretending.
    capabilities.continuationResume = sessionId ? 'fail' : 'unsupported';
    capabilities.cleanup = ['worker_done', 'worker_failed'].includes(terminal1.terminalType) ? 'pass' : 'fail';
    return {
      ok: false,
      evidence: {
        terminalType: terminal1.terminalType,
        exitCode: terminal1.exitCode ?? null,
        observedEvents: [...new Set(firstEvents.map((entry) => entry.type))].sort(),
        resultTexts: firstTexts,
        sessionId,
      },
      capabilities,
      executableVersion: installedVersion,
    };
  }

  // Turn two: a SECOND process, resumed from the recorded session.
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
  const blobs2 = secondEvents.map((entry) => entry.blob).join(' ');
  if (/Failed to authenticate|authentication_failed|oauth session expired/i.test(blobs2)) {
    return {
      notReady: true,
      reason: 'claude authentication expired between turns; refresh it yourself outside this harness',
    };
  }
  const secondTexts = collectResultTexts(secondEvents);
  capabilities.continuationResume = secondTexts.includes('ping-pong') ? 'pass' : 'fail';
  capabilities.cleanup = ['worker_done', 'worker_failed'].includes(terminal1.terminalType)
    && ['worker_done', 'worker_failed'].includes(terminal2.terminalType)
    ? 'pass'
    : 'fail';
  const ok = capabilities.promptRoundTrip === 'pass'
    && capabilities.continuationResume === 'pass'
    && capabilities.cleanup === 'pass';

  if (withPublicPhase) {
    const publicPhase = await runPublicSupervisorPhase('claude-stream');
    capabilities.publicSupervisorLifecycle = publicPhase.pass ? 'pass' : 'fail';
    return {
      ok: ok && publicPhase.pass,
      evidence: {
        turnOne: { terminalType: terminal1.terminalType, resultTexts: firstTexts },
        turnTwo: { terminalType: terminal2.terminalType, resultTexts: secondTexts },
        observedEvents: [...new Set([...firstEvents, ...secondEvents].map((entry) => entry.type))].sort(),
        ...publicPhase.evidence,
      },
      capabilities,
      executableVersion: installedVersion,
    };
  }

  return {
    ok,
    evidence: {
      turnOne: { terminalType: terminal1.terminalType, resultTexts: firstTexts },
      turnTwo: { terminalType: terminal2.terminalType, resultTexts: secondTexts },
      observedEvents: [...new Set([...firstEvents, ...secondEvents].map((entry) => entry.type))].sort(),
    },
    capabilities,
    executableVersion: installedVersion,
  };
}

async function scenarioCodexExec() {
  const codexMod = await import(join(root, 'src/orchestration/adapters/codex-exec.mjs'));
  const binPath = env.CODEX_BIN ?? 'codex';
  const installedVersion = await boundedVersionProbe(binPath, ['--version']);
  if (!installedVersion) {
    return { notReady: true, reason: 'codex binary did not answer a bounded --version probe' };
  }
  // exec requires a Git workspace; build a disposable one-person repo.
  const workspace = join(scratch, 'repo');
  const gitInit = spawnSync('git', ['init', '-q', workspace], { shell: false, encoding: 'utf8', env });
  if (gitInit.status !== 0) throw new Error('could not prepare a disposable git workspace');
  const adapter = codexMod.createCodexExecAdapter({
    codexBin: binPath,
    stateDir: join(scratch, 'state'),
  });
  const events = [];
  const capabilities = capabilityScaffold();
  const spawned = await adapter.spawn({
    task: { taskId: 'task_canary', workspace, objective: 'Reply with exactly: ok' },
    dispatch: { dispatchId: 'disp_canary', bindingId: 'worker_canary', taskId: 'task_canary', fenceEpoch: 1 },
    emit: (type) => events.push(type),
  });
  registerCleanup('codex worker stop', async () => {
    spawned?.binding?.__child?.kill?.('SIGKILL');
  });
  if (spawned.ok === false) throw new Error(`spawn rejected: ${spawned.error?.code ?? 'unknown'}`);
  capabilities.launch = 'pass';
  const terminal = await spawned.done;
  capabilities.progressStream = events.some((entry) => entry === 'progress') ? 'pass' : 'fail';
  capabilities.cleanup = ['worker_done', 'worker_failed'].includes(terminal.terminalType) ? 'pass' : 'fail';

  if (withPublicPhase) {
    const publicPhase = await runPublicSupervisorPhase('codex-exec');
    capabilities.publicSupervisorLifecycle = publicPhase.pass ? 'pass' : 'fail';
    return {
      ok: publicPhase.pass && terminal.terminalType === 'worker_done',
      evidence: {
        terminalType: terminal.terminalType,
        exitCode: terminal.exitCode ?? null,
        observedEvents: [...new Set(events)].sort(),
        ...publicPhase.evidence,
      },
      capabilities,
      executableVersion: installedVersion,
    };
  }

  return {
    ok: terminal.terminalType === 'worker_done',
    evidence: {
      terminalType: terminal.terminalType,
      exitCode: terminal.exitCode ?? null,
      observedEvents: [...new Set(events)].sort(),
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
if (!scenario.ok || !scenario.capabilities) {
  await flushCleanup();
  fail(5, 'CANARY_SCENARIO_FAILED', 'scenario finished without its success invariant', { adapterId, evidence: scenario.evidence });
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

emitJson({
  ok: true,
  code: 'CANARY_PASSED',
  adapterId,
  receiptPath: canaryMod.canaryReceiptPath(roots.stateRoot, adapterId),
  receipt: {
    createdAt: receipt.createdAt,
    executableVersion: receipt.executableVersion,
    runtimeVersion: receipt.runtimeVersion,
    scenario: receipt.scenario,
  },
  maturityNow: adaptersIndex.computeAdapterMaturity(
    { id: adapterId, maturity: 'fixture-only' },
    {
      canaryReceipts: [receipt],
      adapterDigest: receipt.adapterDigest,
      executablePathDigest: receipt.executablePathDigest,
      installedVersion: receipt.executableVersion,
      runtimeVersion: receipt.runtimeVersion,
    },
  ),
});
