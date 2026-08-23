import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CANARY_ADAPTER_IDS,
  CANARY_RECEIPT_SCHEMA,
  canaryAdapterDigest,
  canaryReceiptPath,
  evaluateAdapterMaturities,
  recordCanaryReceipt,
} from '../src/orchestration/canary.mjs';
import { computeAdapterDigest } from '../src/orchestration/adapters/index.mjs';
import { getOrchestrationCapabilities } from '../src/orchestration/client.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const canaryScript = fileURLToPath(new URL('../scripts/orchestration-live-canary.mjs', import.meta.url));

function tempStateRoot(t, name = 'canary') {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-t12-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function executablePathDigest() {
  return createHash('sha256').update(realpathSync(process.execPath)).digest('hex');
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

  const receipt = recordCanaryReceipt(stateRoot, {
    adapterId: 'owned-process',
    adapterDigest: canaryAdapterDigest('owned-process'),
    executablePathDigest: executablePathDigest(),
    executablePath: process.execPath,
    executableVersion: process.version,
    runtimeVersion: process.version,
    scenario: 'owned-process',
    evidence: { terminalType: 'worker_done', exitCode: 0 },
  });
  const storedMode = statSync(canaryReceiptPath(stateRoot, 'owned-process')).mode & 0o777;
  assert.equal(storedMode, 0o600, 'receipts stay machine-private');
  assert.equal(receipt.schema, CANARY_RECEIPT_SCHEMA);
  assert.equal(receipt.authorizedBy, 'operator dual opt-in');

  const after = evaluateAdapterMaturities({ stateRoot });
  assert.equal(after.find((entry) => entry.id === 'owned-process').maturity, 'canary-proven');
  assert.deepEqual(
    after.filter((entry) => entry.id !== 'owned-process').map((entry) => entry.maturity),
    ['fixture-only', 'fixture-only', 'fixture-only'],
    'other adapters never inherit a receipt',
  );

  // A receipt whose executable digest cannot match today must not promote.
  recordCanaryReceipt(stateRoot, {
    adapterId: 'claude-stream',
    adapterDigest: canaryAdapterDigest('claude-stream'),
    executablePathDigest: 'deadbeef',
    executablePath: '/nowhere/claude',
    executableVersion: '9.9.9',
    runtimeVersion: process.version,
    scenario: 'claude-stream',
    evidence: {},
  });
  const tampered = evaluateAdapterMaturities({ stateRoot });
  assert.equal(tampered.find((entry) => entry.id === 'claude-stream').maturity, 'fixture-only');
});

test('capabilities surface reflects recorded receipts through the client seam', (t) => {
  const stateRoot = tempStateRoot(t, 'caps');
  const env = { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateRoot };

  const plain = getOrchestrationCapabilities({ env });
  assert.equal(plain.adapters.length, 4);
  assert.equal(plain.adapters.find((entry) => entry.id === 'opencode-server').maturity, 'fixture-only');

  recordCanaryReceipt(stateRoot, {
    adapterId: 'owned-process',
    adapterDigest: canaryAdapterDigest('owned-process'),
    executablePathDigest: executablePathDigest(),
    executablePath: process.execPath,
    executableVersion: process.version,
    runtimeVersion: process.version,
    scenario: 'owned-process',
    evidence: {},
  });

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
