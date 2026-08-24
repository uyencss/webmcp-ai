import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ADAPTER_BEHAVIOR_MODULES_FOR_TEST,
  ADAPTER_REQUIRED_CAPABILITIES,
  CANARY_CONTRACT_VERSION,
  decideCanaryOutcome,
  evaluateReceiptFreshness,
  requiredCapabilitiesFor,
  sharedBehaviorModulesForTest,
} from '../src/orchestration/canary.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function validReceipt(adapterId, overrides = {}) {
  return {
    schema: 'webmcp.ai-canary-receipt/v1',
    authorizedBy: 'test',
    createdAt: new Date().toISOString(),
    adapterId,
    adapterDigest: 'digest-current',
    executablePathDigest: 'exec-digest',
    executablePath: '/opt/bin/tool',
    executableVersion: '1.0',
    runtimeVersion: process.version,
    platformIdentity: `${process.platform}/${process.arch}`,
    contractVersion: CANARY_CONTRACT_VERSION,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    capabilities: {},
    ...overrides,
  };
}

function currentBinding(adapterId, overrides = {}) {
  const required = requiredCapabilitiesFor(adapterId);
  return {
    adapterDigest: 'digest-current',
    executablePathDigest: 'exec-digest',
    executablePath: '/opt/bin/tool',
    installedVersion: '1.0',
    runtimeVersion: process.version,
    requiredCapabilities: required,
    ...overrides,
  };
}

test('R9E: every adapter declares an explicit required capability set', () => {
  assert.deepEqual(requiredCapabilitiesFor('owned-process'), [
    'launch', 'progressStream', 'cleanup', 'publicSupervisorLifecycle',
  ]);
  assert.deepEqual(requiredCapabilitiesFor('opencode-server'), [
    'launch', 'progressStream', 'promptRoundTrip', 'cleanup', 'publicSupervisorLifecycle',
  ]);
  assert.deepEqual(requiredCapabilitiesFor('claude-stream'), [
    'launch', 'progressStream', 'promptRoundTrip', 'continuationResume', 'cleanup', 'publicSupervisorLifecycle',
  ]);
  assert.deepEqual(requiredCapabilitiesFor('codex-exec'), [
    'launch', 'progressStream', 'promptRoundTrip', 'cleanup', 'publicSupervisorLifecycle',
  ]);
  assert.equal(ADAPTER_REQUIRED_CAPABILITIES['opencode-server'].includes('progressStream'), true);
});

test('R9E: a receipt lacking any required capability can never promote its adapter', () => {
  // OpenCode receipt WITHOUT a proven SSE progress stream or prompt round trip.
  const receipt = validReceipt('opencode-server', {
    capabilities: { launch: 'pass', cleanup: 'pass', publicSupervisorLifecycle: 'pass' },
  });
  const binding = currentBinding('opencode-server');
  const stale = evaluateReceiptFreshness(receipt, { ...binding });
  assert.match(String(stale), /progressStream|promptRoundTrip/, `stale reason: ${stale}`);

  const decision = decideCanaryOutcome({ receipt, binding });
  assert.equal(decision.promoted, false);
  assert.equal(decision.code, 'CANARY_EVIDENCE_RECORDED');
});

test('R9E: executable PATH drift invalidates an otherwise perfect receipt', () => {
  const receipt = validReceipt('codex-exec', {
    capabilities: Object.fromEntries(
      requiredCapabilitiesFor('codex-exec').map((c) => [c, 'pass']),
    ),
  });
  const sameSpot = currentBinding('codex-exec');
  assert.equal(evaluateReceiptFreshness(receipt, { ...sameSpot }), null);

  const movedBinary = currentBinding('codex-exec', { executablePath: '/opt/bin/tool-next' });
  assert.equal(evaluateReceiptFreshness(receipt, { ...movedBinary }), 'executable-path');
});

test('R9E: behavior digests cover IPC, callback transport and process control modules', () => {
  const shared = sharedBehaviorModulesForTest();
  for (const required of ['ipc.mjs', 'worker-callback.mjs', 'process-identity.mjs', 'journal.mjs']) {
    assert.ok(shared.some((modulePath) => modulePath.endsWith(required)), `shared modules must cover ${required}: ${JSON.stringify(shared)}`);
  }
  const owned = ADAPTER_BEHAVIOR_MODULES_FOR_TEST['owned-process'];
  assert.ok(owned.every((modulePath) => modulePath.endsWith('.mjs')));
});

test('R9E: complete fresh receipts promote; partial ones never claim CANARY_PASSED', () => {
  const good = validReceipt('claude-stream', {
    capabilities: Object.fromEntries(
      requiredCapabilitiesFor('claude-stream').map((c) => [c, 'pass']),
    ),
  });
  const binding = currentBinding('claude-stream');
  const promoted = decideCanaryOutcome({ receipt: good, binding });
  assert.deepEqual(promoted, { code: 'CANARY_PASSED', promoted: true });

  const partial = validReceipt('claude-stream', {
    capabilities: Object.fromEntries(
      requiredCapabilitiesFor('claude-stream').map((c) => [c, c === 'continuationResume' ? 'unsupported' : 'pass']),
    ),
  });
  const recordedOnly = decideCanaryOutcome({ receipt: partial, binding });
  assert.equal(recordedOnly.code, 'CANARY_EVIDENCE_RECORDED');
  assert.equal(recordedOnly.promoted, false);
});

test('R9E: live canary script earns progressStream and never hardcodes unsupported', () => {
  const script = readFileSync(join(ROOT, 'scripts/orchestration-live-canary.mjs'), 'utf8');
  assert.equal(
    /progressStream\s*=\s*['"]unsupported['"]/.test(script),
    false,
    'the OpenCode scenario may never hardcode progressStream as unsupported',
  );
  assert.ok(script.includes('CANARY_EVIDENCE_RECORDED'), 'script must distinguish recorded-only evidence');
  assert.ok(script.includes('decideCanaryOutcome'), 'script emission must go through the pure decision function');
  // The Claude model-call authentication probe is removed entirely.
  assert.equal(
    /authProbe/.test(script),
    false,
    'the separate model-call auth precheck must be gone',
  );
});
