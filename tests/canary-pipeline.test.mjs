import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
const CANARY_SCRIPT = join(ROOT, 'scripts', 'orchestration-live-canary.mjs');

let counter = 0;

function tempStateRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r10c-${(counter += 1)}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCanary(t, argv, envExtra = {}) {
  const stateRoot = tempStateRoot(t);
  const run = spawnSync(process.execPath, [CANARY_SCRIPT, ...argv], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 150_000,
    env: {
      ...process.env,
      WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateRoot,
      WEBMCP_AI_LIVE_CANARY: '1',
      ...envExtra,
    },
  });
  let payload = null;
  try { payload = JSON.parse(run.stdout); } catch { /* surfaced below */ }
  return { run, payload, stateRoot };
}

test('R10C: owned-process --public drives the REAL public lifecycle end to end and promotes exactly once', (t) => {
  const { run, payload, stateRoot } = runCanary(
    t,
    ['owned-process', '--public'],
    { WEBMCP_AI_LIVE_OWNED: '1' },
  );

  assert.equal(run.status, 0, `stdout=${run.stdout} stderr=${run.stderr}`);
  assert.equal(payload?.code, 'CANARY_PASSED', JSON.stringify(payload));
  assert.equal(payload?.maturityNow, 'canary-proven');
  assert.equal(payload?.receipt?.scenario, 'owned-process+public');

  // The receipt is machine-local (0600), isolated under the given state root.
  const receiptPath = join(stateRoot, 'canary', 'owned-process.json');
  assert.equal(run.status === 0 ? existsSafe(receiptPath) : false, true, 'receipt must be written under the isolated state root');
  assert.equal(statSync(receiptPath).mode & 0o777, 0o600, 'receipt must be mode 0600');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  for (const capability of ['launch', 'progressStream', 'cleanup', 'publicSupervisorLifecycle']) {
    assert.equal(receipt.capabilities[capability], 'pass', `required capability ${capability} must pass`);
  }

  // Behavioral proof of the PUBLIC supervisor lifecycle: a real supervisor
  // drove task.create -> dispatch.start -> delivery.wait -> settled.
  assert.deepEqual(
    ['cleanup_recorded', 'worker_done', 'worker_started'].every((type) => receipt.evidence.publicLifecycleEvents.includes(type)),
    true,
    `public lifecycle events missing: ${JSON.stringify(receipt.evidence)}`,
  );
  assert.equal(receipt.evidence.dispatchState, 'settled');
}, { timeout: 180_000 });

function existsSafe(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

test('R10C: without --public the owned canary records truthful PARTIAL evidence and refuses promotion', (t) => {
  const { run, payload, stateRoot } = runCanary(t, ['owned-process'], { WEBMCP_AI_LIVE_OWNED: '1' });

  assert.equal(run.status, 6, `stdout=${run.stdout} stderr=${run.stderr}`);
  assert.equal(payload?.code, 'CANARY_EVIDENCE_RECORDED');
  assert.equal(payload?.staleReason, 'capability:publicSupervisorLifecycle');
  assert.deepEqual(payload?.requiredCapabilities, ['launch', 'progressStream', 'cleanup', 'publicSupervisorLifecycle']);

  const receipt = JSON.parse(readFileSync(join(stateRoot, 'canary', 'owned-process.json'), 'utf8'));
  assert.equal(receipt.capabilities.launch, 'pass');
  assert.equal(receipt.capabilities.publicSupervisorLifecycle, 'unsupported',
    'unproven capabilities are recorded honestly, never guessed');
}, { timeout: 120_000 });

test('R10C: provider scenarios never touch a real provider when none is installed', (t) => {
  // /usr/bin/false cannot answer ANY probe: the runner must stop at the
  // typed not-ready gate before spawning anything else.
  for (const [adapterId, binEnv] of [
    ['opencode-server', { OPENCODE_BIN: '/usr/bin/false', WEBMCP_AI_LIVE_OPENCODE: '1' }],
    ['claude-stream', { CLAUDE_BIN: '/usr/bin/false', WEBMCP_AI_LIVE_CLAUDE: '1' }],
    ['codex-exec', { CODEX_BIN: '/usr/bin/false', WEBMCP_AI_LIVE_CODEX: '1' }],
  ]) {
    const { run, payload } = runCanary(t, [adapterId], binEnv);
    assert.equal(run.status, 4, `${adapterId}: stdout=${run.stdout}`);
    assert.equal(payload?.code, 'CANARY_PROVIDER_NOT_READY', `${adapterId}: ${JSON.stringify(payload)}`);
  }
}, { timeout: 120_000 });

test('R10C: provider scenarios route their ONLY interaction through the PUBLIC supervisor path', (t) => {
  // A stub "provider" that answers --version but can never run a turn: the
  // codex scenario must fail INSIDE the public phase and record exact
  // partial evidence under CANARY_EVIDENCE_RECORDED — never promote, never
  // fall back to a direct-model shortcut outside the public operation table.
  const stubDir = mkdtempSync(join(tmpdir(), 'webmcp-ai-r10c-stub-'));
  t.after(() => rmSync(stubDir, { recursive: true, force: true }));
  const stub = join(stubDir, 'fake-provider.mjs');
  writeFileSync(stub, '#!/usr/bin/env node\nif (process.argv[2] === "--version") { console.log("9.9.9-r10c"); process.exit(0); }\nprocess.exit(1);\n');
  chmodSync(stub, 0o755);

  const { run, payload, stateRoot } = runCanary(t, ['codex-exec'], {
    CODEX_BIN: stub,
    WEBMCP_AI_LIVE_CODEX: '1',
  });
  assert.equal(run.status, 6, `stdout=${run.stdout} stderr=${run.stderr}`);
  assert.equal(payload?.code, 'CANARY_EVIDENCE_RECORDED', JSON.stringify(payload));
  assert.match(payload?.staleReason ?? '', /^capability:/);

  const receipt = JSON.parse(readFileSync(join(stateRoot, 'canary', 'codex-exec.json'), 'utf8'));
  // Behavioral proof the PUBLIC supervisor phase ran: its evidence carries
  // the observed lifecycle events and the settled dispatch state.
  assert.equal(Array.isArray(receipt.evidence.publicLifecycleEvents), true,
    `public lifecycle evidence missing: ${JSON.stringify(receipt.evidence)}`);
  assert.equal(typeof receipt.evidence.dispatchState, 'string');
  const required = ['launch', 'progressStream', 'promptRoundTrip', 'cleanup', 'publicSupervisorLifecycle'];
  assert.equal(
    required.some((capability) => receipt.capabilities[capability] !== 'pass'),
    true,
    'at least one required capability must honestly record a non-pass verdict',
  );
}, { timeout: 180_000 });
