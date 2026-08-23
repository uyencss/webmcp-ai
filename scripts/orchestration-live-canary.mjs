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
//   node scripts/orchestration-live-canary.mjs <adapter-id> [--prompt] [--timeout-ms N]
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

if (!adapterId || Number.isNaN(timeoutMs) || timeoutMs < 1000) {
  fail(2, 'CANARY_USAGE', 'usage: orchestration-live-canary.mjs <owned-process|opencode-server|claude-stream|codex-exec> [--prompt] [--timeout-ms N]');
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

function boundedVersionProbe(binPath, versionArgs) {
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

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout({ __canaryTimeout: true, label }), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
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
  const spawned = await adapter.spawn({
    task: { taskId: 'task_canary', workspace: scratch },
    dispatch: { dispatchId: 'disp_canary', bindingId: 'worker_canary' },
    command: process.execPath,
    args: ['-e', 'process.stdout.write("canary-ok\\n"); process.exit(0)'],
    emit: (type, payload) => events.push({ type }),
  });
  const terminal = await withTimeout(spawned.done, 'worker terminal');
  if (terminal?.__canaryTimeout) throw new Error(`owned-process worker never settled (${terminal.label})`);
  const ok = terminal.terminalType === 'worker_done' && terminal.exitCode === 0;
  return {
    ok,
    evidence: {
      terminalType: terminal.terminalType,
      exitCode: terminal.exitCode,
      identityProven: Boolean(spawned.binding?.processIdentity?.startIdentity),
      eventTypes: [...new Set(events)].sort(),
      durationNote: 'bounded trivial worker; no provider dependency',
    },
    executableVersion: process.version,
  };
}

async function scenarioOpenCodeServer() {
  const serverMod = await import(join(root, 'src/orchestration/adapters/opencode-server.mjs'));
  const binPath = env.OPENCODE_BIN ?? 'opencode';
  const installedVersion = boundedVersionProbe(binPath, ['--version']);
  if (installedVersion !== '1.18.21') {
    return { notReady: true, reason: `pinned opencode 1.18.21 required, found ${installedVersion ?? 'none'}` };
  }
  const adapter = serverMod.createOpenCodeServerAdapter({
    openCodeBin: binPath,
    stateDir: join(scratch, 'state'),
  });

  let started = null;
  try {
    started = await withTimeout(
      adapter.startRuntimeServer({ workspace: scratch, bindingId: 'worker_canary', fenceEpoch: 1 }),
      'server bootstrap',
    );
    if (started?.__canaryTimeout) throw new Error(`server bootstrap timed out (${started.label})`);
    const health = await adapter.requestJson(started.runtime, 'GET', '/global/health');
    if (!health.ok || !(health.json?.status === 'ok' || health.json?.healthy === true)) {
      throw new Error('global health check failed against the real binary');
    }
    const session = await adapter.createSession(started.runtime);
    const deleted = await adapter.requestJson(
      started.runtime,
      'DELETE',
      `/session/${encodeURIComponent(session.sessionId)}`,
    );
    if (!deleted.ok) throw new Error('session delete failed over the documented surface');

    let promptEvidence = { promptRoundTrip: false };
    if (withPrompt) {
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
      promptEvidence = { promptRoundTrip: true, outputSha256Prefix: sha256Text(finalText).slice(0, 16) };
    }

    const dbInsideRuntimeTree = String(started.runtime.dbPath).includes('webmcp-ai-runtime');
    if (!dbInsideRuntimeTree) throw new Error('runtime database escaped the owned tree');
    const stopReceipt = await adapter.stopServer(started.runtime);
    if (stopReceipt.disposition !== 'stopped') throw new Error(`unexpected stop disposition ${stopReceipt.disposition}`);

    return {
      ok: true,
      evidence: {
        healthOk: true,
        sessionLifecycleOk: true,
        databaseIdentity: started.runtime.databaseIdentity.slice(0, 16),
        isolatedDb: true,
        stopDisposition: stopReceipt.disposition,
        ...promptEvidence,
      },
      executableVersion: installedVersion,
    };
  } finally {
    if (started?.runtime) await adapter.stopServer(started.runtime).catch(() => {});
  }
}

async function scenarioClaudeStream() {
  const claudeMod = await import(join(root, 'src/orchestration/adapters/claude-stream.mjs'));
  const binPath = env.CLAUDE_BIN ?? 'claude';
  const installedVersion = boundedVersionProbe(binPath, ['--version']);
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
  const events = [];
  const spawned = await adapter.spawn({
    task: { taskId: 'task_canary', workspace: scratch },
    dispatch: { dispatchId: 'disp_canary', bindingId: 'worker_canary', taskId: 'task_canary', fenceEpoch: 1 },
    emit: (type, payload) => events.push({
      type,
      blob: JSON.stringify(payload ?? {}).slice(0, 400),
    }),
  });
  if (spawned.ok === false) throw new Error(`spawn rejected: ${spawned.error?.code ?? 'unknown'}`);
  const queued = await spawned.sendFollowUp('Reply with exactly: ok');
  if (!queued.ok) throw new Error('prompt hand-off to stdin failed');
  // Real `-p` runs consume stdin until EOF; the queued-followup seam keeps the
  // pipe open by design, so the canary closes it to let the turn settle.
  spawned.binding?.__child?.stdin?.end();
  const terminal = await withTimeout(spawned.done, 'claude terminal result');
  if (terminal?.__canaryTimeout) throw new Error(`claude stream never settled (${terminal.label})`);
  const blobs = events.map((entry) => entry.blob).join(' ');
  if (/Failed to authenticate|authentication_failed|oauth session expired/i.test(blobs)) {
    return {
      notReady: true,
      reason: 'claude authentication is expired or missing; refresh it yourself outside this harness',
    };
  }
  const sawResultEvent = events.some((entry) => entry.type === 'worker_done' || entry.type === 'progress');
  return {
    ok: terminal.terminalType === 'worker_done' && sawResultEvent,
    evidence: {
      terminalType: terminal.terminalType,
      exitCode: terminal.exitCode ?? null,
      observedEvents: [...new Set(events.map((entry) => entry.type))].sort(),
      ...(sawResultEvent ? {} : { lastEventBlobs: events.slice(-4).map((entry) => entry.blob) }),
    },
    executableVersion: installedVersion,
  };
}

async function scenarioCodexExec() {
  const codexMod = await import(join(root, 'src/orchestration/adapters/codex-exec.mjs'));
  const binPath = env.CODEX_BIN ?? 'codex';
  const installedVersion = boundedVersionProbe(binPath, ['--version']);
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
  const spawned = await adapter.spawn({
    task: { taskId: 'task_canary', workspace, objective: 'Reply with exactly: ok' },
    dispatch: { dispatchId: 'disp_canary', bindingId: 'worker_canary', taskId: 'task_canary', fenceEpoch: 1 },
    emit: (type) => events.push(type),
  });
  if (spawned.ok === false) throw new Error(`spawn rejected: ${spawned.error?.code ?? 'unknown'}`);
  const terminal = await withTimeout(spawned.done, 'codex terminal result');
  if (terminal?.__canaryTimeout) throw new Error(`codex stream never settled (${terminal.label})`);
  return {
    ok: terminal.terminalType === 'worker_done',
    evidence: {
      terminalType: terminal.terminalType,
      exitCode: terminal.exitCode ?? null,
      observedEvents: [...new Set(events)].sort(),
    },
    executableVersion: installedVersion,
  };
}

// ---- execution -------------------------------------------------------------------

let scenario;
try {
  scenario = await withTimeout(runScenario(), 'scenario');
} catch (error) {
  fail(5, 'CANARY_SCENARIO_FAILED', String(error?.message ?? error).slice(0, 500), { adapterId });
}
if (scenario?.__canaryTimeout) {
  fail(5, 'CANARY_TIMEOUT', `scenario exceeded ${timeoutMs}ms (${scenario.label})`, { adapterId });
}
if (scenario.notReady) {
  fail(4, 'CANARY_PROVIDER_NOT_READY', scenario.reason, { adapterId });
}
if (!scenario.ok) {
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
  scenario: adapterId + (withPrompt && adapterId === 'opencode-server' ? '+prompt' : ''),
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
