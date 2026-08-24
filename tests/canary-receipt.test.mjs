import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CANARY_ADAPTER_IDS,
  CANARY_CONTRACT_VERSION,
  CANARY_RECEIPT_SCHEMA,
  canaryAdapterDigest,
  canaryReceiptPath,
  evaluateAdapterMaturities,
  probeExecutableVersion,
  recordCanaryReceipt,
  runBoundedScenario,
} from '../src/orchestration/canary.mjs';
import { computeAdapterDigest, computeAdapterMaturity } from '../src/orchestration/adapters/index.mjs';
import { getOrchestrationCapabilities } from '../src/orchestration/client.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const canaryScript = fileURLToPath(new URL('../scripts/orchestration-live-canary.mjs', import.meta.url));

function tempStateRoot(t, name = 'canary') {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-t12-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function contentDigest(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** The full provider dispatch capability set — everything proven. */
function fullCapabilities(overrides = {}) {
  return {
    launch: 'pass',
    progressStream: 'pass',
    promptRoundTrip: 'pass',
    continuationResume: 'pass',
    gracefulStop: 'pass',
    forceStop: 'pass',
    cleanup: 'pass',
    publicSupervisorLifecycle: 'pass',
    ...overrides,
  };
}

function baseReceipt(overrides = {}) {
  return {
    adapterId: 'owned-process',
    executablePathDigest: contentDigest(process.execPath),
    executablePath: process.execPath,
    executableVersion: process.version,
    runtimeVersion: process.version,
    platformIdentity: `${process.platform}/${process.arch}`,
    scenario: 'owned-process',
    contractVersion: CANARY_CONTRACT_VERSION,
    capabilities: fullCapabilities(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    evidence: {},
    ...overrides,
  };
}

test('the canary runner refuses to act without the dual opt-in', (t) => {
  tempStateRoot(t, 'gate');
  const run = spawnSync(process.execPath, [canaryScript, 'owned-process'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(run.status, 3, run.stdout);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'CANARY_GATE_CLOSED');
  assert.match(payload.message, /separate authorization required/);

  // Half a gate is still a closed gate.
  const halfGate = spawnSync(process.execPath, [canaryScript, 'owned-process'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, WEBMCP_AI_LIVE_CANARY: '1' },
  });
  assert.equal(halfGate.status, 3);
});

test('canary runner rejects unknown or missing adapters with usage errors', () => {
  for (const argv of [[], ['mystery-adapter']]) {
    const run = spawnSync(process.execPath, [canaryScript, ...argv], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.equal(JSON.parse(run.stdout).code, 'CANARY_USAGE');
  }
});

test('receipts promote exactly one adapter and survive only matching environments', (t) => {
  const stateRoot = tempStateRoot(t, 'promote');

  assert.deepEqual(CANARY_ADAPTER_IDS, ['owned-process', 'opencode-server', 'claude-stream', 'codex-exec']);
  const before = evaluateAdapterMaturities({ stateRoot });
  assert.deepEqual([...new Set(before.map((entry) => entry.maturity))], ['fixture-only']);

  // Digest convention matches computeAdapterDigest without instantiation.
  assert.equal(
    canaryAdapterDigest('owned-process'),
    computeAdapterDigest({ id: 'owned-process', maturity: 'fixture-only' }),
  );

  const receipt = recordCanaryReceipt(stateRoot, baseReceipt({ adapterDigest: canaryAdapterDigest('owned-process') }));
  const storedMode = statSync(canaryReceiptPath(stateRoot, 'owned-process')).mode & 0o777;
  assert.equal(storedMode, 0o600, 'receipts stay machine-private');
  assert.equal(receipt.schema, CANARY_RECEIPT_SCHEMA);
  assert.equal(receipt.authorizedBy, 'operator dual opt-in');
  assert.equal(receipt.contractVersion, CANARY_CONTRACT_VERSION);

  const after = evaluateAdapterMaturities({ stateRoot });
  assert.equal(after.find((entry) => entry.id === 'owned-process').maturity, 'canary-proven');
  assert.deepEqual(
    after.filter((entry) => entry.id !== 'owned-process').map((entry) => entry.maturity),
    ['fixture-only', 'fixture-only', 'fixture-only'],
    'other adapters never inherit a receipt',
  );

  // A receipt whose executable digest cannot match today must not promote.
  recordCanaryReceipt(stateRoot, baseReceipt({
    adapterId: 'claude-stream',
    adapterDigest: canaryAdapterDigest('claude-stream'),
    executablePathDigest: 'deadbeef',
    executablePath: '/nowhere/claude',
  }));
  const tampered = evaluateAdapterMaturities({ stateRoot });
  assert.equal(tampered.find((entry) => entry.id === 'claude-stream').maturity, 'fixture-only');
});

test('R6: replacing executable content at the same path invalidates maturity', (t) => {
  const stateRoot = tempStateRoot(t, 'content');
  const exeDir = tempStateRoot(t, 'exe');
  const fakeBin = join(exeDir, 'fake-provider.mjs');
  writeFileSync(fakeBin, '#!/usr/bin/env node\nconsole.log("1.0.0");\n');
  chmodSync(fakeBin, 0o755);

  recordCanaryReceipt(stateRoot, baseReceipt({
    adapterId: 'opencode-server',
    adapterDigest: canaryAdapterDigest('opencode-server'),
    executablePathDigest: contentDigest(fakeBin),
    executablePath: fakeBin,
    executableVersion: '1.0.0',
  }));
  const promoted = evaluateAdapterMaturities({
    stateRoot,
    env: { OPENCODE_BIN: fakeBin },
    runtimeVersion: process.version,
  });
  assert.equal(promoted.find((entry) => entry.id === 'opencode-server').maturity, 'canary-proven');

  // Same path, DIFFERENT bytes: a replaced binary must invalidate the receipt.
  writeFileSync(fakeBin, '#!/usr/bin/env node\nconsole.log("9.9.9");\n');
  const stale = evaluateAdapterMaturities({
    stateRoot,
    env: { OPENCODE_BIN: fakeBin },
    runtimeVersion: process.version,
  });
  const entry = stale.find((item) => item.id === 'opencode-server');
  assert.equal(entry.maturity, 'fixture-only', 'content replacement invalidates maturity');
  assert.match(String(entry.receipt?.staleReason ?? ''), /executable/i);
});

test('R6: runtime version drift invalidates maturity', (t) => {
  const stateRoot = tempStateRoot(t, 'runtime-drift');
  recordCanaryReceipt(stateRoot, baseReceipt({}));
  const drifted = evaluateAdapterMaturities({ stateRoot, runtimeVersion: 'v99.99.99' });
  const entry = drifted.find((item) => item.id === 'owned-process');
  assert.equal(entry.maturity, 'fixture-only');
  assert.match(String(entry.receipt?.staleReason ?? ''), /runtime|version/i);
});

test('R6: behaviorally relevant adapter/helper code changes invalidate maturity', (t) => {
  const stateRoot = tempStateRoot(t, 'behavior');
  const modulesA = tempStateRoot(t, 'mod-a');
  const moduleA = join(modulesA, 'adapter-impl.mjs');
  writeFileSync(moduleA, 'export const behavior = "v1";\n');

  const recorded = recordCanaryReceipt(stateRoot, baseReceipt({
    adapterDigest: canaryAdapterDigest('owned-process', { behaviorModules: [moduleA] }),
  }));
  const matching = evaluateAdapterMaturities({
    stateRoot,
    behaviorModulesForAdapter: { 'owned-process': [moduleA] },
  });
  assert.equal(matching.find((entry) => entry.id === 'owned-process').maturity, 'canary-proven');
  assert.equal(recorded.adapterDigest, canaryAdapterDigest('owned-process', { behaviorModules: [moduleA] }));

  // A behavior-relevant source change (same file, new bytes) is stale.
  writeFileSync(moduleA, 'export const behavior = "v2-fixed-bug";\n');
  const stale = evaluateAdapterMaturities({
    stateRoot,
    behaviorModulesForAdapter: { 'owned-process': [moduleA] },
  });
  const entry = stale.find((item) => item.id === 'owned-process');
  assert.equal(entry.maturity, 'fixture-only', 'adapter code changes invalidate maturity');
  assert.match(String(entry.receipt?.staleReason ?? ''), /adapter/i);
});

test('R6: receipt expiry invalidates maturity with an explicit stale reason', (t) => {
  const stateRoot = tempStateRoot(t, 'expiry');
  // Expired receipts are a legitimate on-disk state the evaluator must catch
  // even though the WRITER refuses to create them; write one directly.
  mkdirSync(join(stateRoot, 'canary'), { recursive: true, mode: 0o700 });
  const expired = {
    schema: CANARY_RECEIPT_SCHEMA,
    authorizedBy: 'operator dual opt-in',
    createdAt: new Date(Date.now() - 172_800_000).toISOString(),
    ...baseReceipt({}),
    adapterDigest: canaryAdapterDigest('owned-process'),
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  };
  writeFileSync(canaryReceiptPath(stateRoot, 'owned-process'), `${JSON.stringify(expired, null, 1)}\n`);
  const report = evaluateAdapterMaturities({ stateRoot });
  const entry = report.find((item) => item.id === 'owned-process');
  assert.equal(entry.maturity, 'fixture-only');
  assert.match(String(entry.receipt?.staleReason ?? ''), /expir/i);
});

test('R6: a launch-only receipt cannot authorize prompt or resume dispatch', (t) => {
  const stateRoot = tempStateRoot(t, 'launchonly');
  const receipt = recordCanaryReceipt(stateRoot, baseReceipt({
    adapterId: 'opencode-server',
    adapterDigest: canaryAdapterDigest('opencode-server'),
    capabilities: {
      launch: 'pass',
      progressStream: 'pass',
      cleanup: 'pass',
      promptRoundTrip: 'unsupported',
      continuationResume: 'unsupported',
      gracefulStop: 'unsupported',
      forceStop: 'unsupported',
      publicSupervisorLifecycle: 'unsupported',
    },
  }));

  const adapter = { id: 'opencode-server', maturity: 'fixture-only' };
  const evidence = {
    canaryReceipts: [receipt],
    adapterDigest: receipt.adapterDigest,
    executablePathDigest: receipt.executablePathDigest,
    installedVersion: receipt.executableVersion,
    runtimeVersion: process.version,
  };
  assert.equal(computeAdapterMaturity(adapter, evidence), 'fixture-only', 'prompt dispatch stays blocked');
});

test('R6: promptRoundTrip:false can never authorize prompting', (t) => {
  const stateRoot = tempStateRoot(t, 'promptfail');
  const receipt = recordCanaryReceipt(stateRoot, baseReceipt({
    adapterId: 'opencode-server',
    adapterDigest: canaryAdapterDigest('opencode-server'),
    capabilities: fullCapabilities({ promptRoundTrip: 'fail' }),
  }));
  const adapter = { id: 'opencode-server', maturity: 'fixture-only' };
  assert.equal(
    computeAdapterMaturity(adapter, {
      canaryReceipts: [receipt],
      adapterDigest: receipt.adapterDigest,
      executablePathDigest: receipt.executablePathDigest,
      installedVersion: receipt.executableVersion,
      runtimeVersion: process.version,
    }),
    'fixture-only',
  );
  const report = evaluateAdapterMaturities({ stateRoot, env: { OPENCODE_BIN: process.execPath } });
  const entry = report.find((item) => item.id === 'opencode-server');
  assert.equal(entry.capabilities?.promptRoundTrip, 'fail', 'the failing capability is surfaced verbatim');
  assert.equal(entry.maturity, 'fixture-only');
});

test('R6: claude one-prompt evidence cannot authorize resume', (t) => {
  const stateRoot = tempStateRoot(t, 'oneprompt');
  const receipt = recordCanaryReceipt(stateRoot, baseReceipt({
    adapterId: 'claude-stream',
    adapterDigest: canaryAdapterDigest('claude-stream'),
    capabilities: fullCapabilities({ continuationResume: 'unsupported' }),
  }));
  const adapter = { id: 'claude-stream', maturity: 'fixture-only' };
  const binding = {
    canaryReceipts: [receipt],
    adapterDigest: receipt.adapterDigest,
    executablePathDigest: receipt.executablePathDigest,
    installedVersion: receipt.executableVersion,
    runtimeVersion: process.version,
  };
  // A resume-capable dispatch must demand continuationResume evidence.
  assert.equal(
    computeAdapterMaturity(adapter, {
      ...binding,
      requiredCapabilities: ['launch', 'progressStream', 'promptRoundTrip', 'continuationResume', 'cleanup'],
    }),
    'fixture-only',
    'resume requires continuationResume evidence',
  );
});

test('R6: unproven public lifecycle keeps the blanket label conservative', (t) => {
  const stateRoot = tempStateRoot(t, 'publiclife');
  const receipt = recordCanaryReceipt(stateRoot, baseReceipt({
    capabilities: fullCapabilities({ publicSupervisorLifecycle: 'unsupported' }),
  }));
  const report = evaluateAdapterMaturities({ stateRoot });
  const entry = report.find((item) => item.id === 'owned-process');
  assert.equal(entry.capabilities?.publicSupervisorLifecycle, 'unsupported');
  assert.equal(entry.maturity, 'fixture-only', 'direct adapter passes never collapse into a blanket green');

  const adapter = { id: 'owned-process', maturity: 'fixture-only' };
  assert.equal(
    computeAdapterMaturity(adapter, {
      canaryReceipts: [receipt],
      adapterDigest: receipt.adapterDigest,
      executablePathDigest: receipt.executablePathDigest,
      installedVersion: receipt.executableVersion,
      runtimeVersion: process.version,
    }),
    'fixture-only',
  );
});

test('R6: receipt overwrite of a pre-existing 0644 sidecar ends at 0600', (t) => {
  const stateRoot = tempStateRoot(t, 'overwrite');
  mkdirSync(join(stateRoot, 'canary'), { recursive: true, mode: 0o700 });
  const target = canaryReceiptPath(stateRoot, 'owned-process');
  writeFileSync(target, '{"stale":true}\n', { mode: 0o644 });
  chmodSync(target, 0o644);

  recordCanaryReceipt(stateRoot, baseReceipt());
  assert.equal(statSync(target).mode & 0o777, 0o600, 'overwrite restores machine-private mode');
});

test('R6: scenario timeout cancels underlying work and awaits cleanup first', async () => {
  const order = [];
  let released = false;
  const hangingWork = () => new Promise(() => {
    order.push('work-started');
  });

  await assert.rejects(
    () => runBoundedScenario('unit-hang', 50, hangingWork, {
      onCancel: async () => {
        await new Promise((resolveTick) => setTimeout(resolveTick, 20));
        released = true;
        order.push('cleanup-done');
      },
    }),
    (error) => {
      assert.match(String(error?.code ?? ''), /TIMEOUT|PROTOCOL/);
      return true;
    },
  );
  assert.equal(released, true, 'cancel hook completed before the timeout surfaced');
  assert.deepEqual(order.filter((step) => step !== 'work-started'), ['cleanup-done']);
  assert.ok(order.indexOf('cleanup-done') < order.length, 'cleanup ran inside the bounded window');
});

test('R6: probed executable versions come from the binary itself or the runtime', (t) => {
  // owned-process runs on THIS node: its version is process.version.
  assert.equal(probeExecutableVersion('owned-process', {}), process.version);

  const exeDir = tempStateRoot(t, 'probe-bin');
  const versioned = join(exeDir, 'versioned-provider.mjs');
  writeFileSync(versioned, '#!/usr/bin/env node\nconsole.log("7.7.7");\n');
  chmodSync(versioned, 0o755);
  assert.equal(probeExecutableVersion('opencode-server', { env: { OPENCODE_BIN: versioned } }), '7.7.7');

  const missing = join(exeDir, 'does-not-exist.bin');
  assert.equal(probeExecutableVersion('opencode-server', { env: { OPENCODE_BIN: missing } }), null);
});

test('capabilities surface reflects recorded receipts through the client seam', (t) => {
  const stateRoot = tempStateRoot(t, 'caps');
  const env = { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateRoot };

  const plain = getOrchestrationCapabilities({ env });
  assert.equal(plain.adapters.length, 4);
  assert.equal(plain.adapters.find((entry) => entry.id === 'opencode-server').maturity, 'fixture-only');

  recordCanaryReceipt(stateRoot, baseReceipt({
    adapterId: 'owned-process',
    adapterDigest: canaryAdapterDigest('owned-process'),
  }));

  const promoted = getOrchestrationCapabilities({ env });
  assert.equal(promoted.adapters.find((entry) => entry.id === 'owned-process').maturity, 'canary-proven');
  assert.equal(promoted.adapters.find((entry) => entry.id === 'codex-exec').maturity, 'fixture-only');
});

test('corrupt canary sidecars are skipped instead of blocking the report', (t) => {
  const stateRoot = tempStateRoot(t, 'corrupt');
  mkdirSync(join(stateRoot, 'canary'), { recursive: true });
  writeFileSync(join(stateRoot, 'canary', 'garbage.json'), '{nope');
  const report = evaluateAdapterMaturities({ stateRoot });
  assert.equal(report.every((entry) => entry.maturity === 'fixture-only'), true);
  assert.equal(readFileSync(join(stateRoot, 'canary', 'garbage.json'), 'utf8'), '{nope');
});
