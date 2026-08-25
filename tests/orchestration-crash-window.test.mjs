import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';

import { createSupervisor } from '../src/orchestration/supervisor.mjs';
import { createPlatformIdentityDeps } from '../src/orchestration/process-identity.mjs';
import { releaseRecoveredRuntimeDatabase } from '../src/orchestration/adapters/opencode-server.mjs';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
const DRIVER = join(ROOT, 'scripts', 'orchestration-crash-owner-driver.mjs');
const FIXTURES = new URL('./fixtures/orchestration/', import.meta.url).pathname;

const CLOSERS = [];
after(async () => {
  for (const closer of CLOSERS.splice(0)) {
    try { await closer(); } catch { /* best effort */ }
  }
});

function tempStateDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r12b-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition, deadlineMs, label) {
  const startedAt = Date.now();
  for (;;) {
    let result = false;
    try { result = await condition(); } catch { result = false; }
    if (result) return result;
    if (Date.now() - startedAt > deadlineMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
}

function gitWorkspace(t, name) {
  const dir = tempStateDir(t, name);
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

/**
 * Launch the crash driver for one fixture kind and wait for it to be
 * SIGKILLed inside the post-spawn handshake window. Returns the durable
 * state the crashed owner left behind.
 */
async function runCrashingOwner(t, kind, { workspace }) {
  const stateDir = tempStateDir(t, `${kind}-owner`);
  const coordinationId = `coord_r12b_${kind}_${(coordCounter += 1)}`;
  const driver = spawn(process.execPath, [
    DRIVER,
    '--state-dir', stateDir,
    '--coordination-id', coordinationId,
    '--fixture', kind,
    '--workspace', workspace,
  ], {
    env: { ...process.env, WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdoutText = '';
  let stderrText = '';
  driver.stdout.on('data', (chunk) => { stdoutText += chunk.toString('utf8'); });
  driver.stderr.on('data', (chunk) => { stderrText += chunk.toString('utf8'); });
  const hardKill = () => {
    try {
      if (driver.exitCode === null && driver.signalCode === null) driver.kill('SIGKILL');
    } catch { /* gone */ }
  };
  t.after(hardKill);
  CLOSERS.push(hardKill);

  await waitFor(() => stdoutText.includes('"ready":true'), 15_000,
    `driver ready (${kind}); stderr=${stderrText.slice(0, 300)}`);
  const taskIdLine = await waitFor(() => {
    const match = stdoutText.match(/\{"taskId":"task_[^"]+"\}/);
    return match ? match[0] : null;
  }, 15_000, `task creation (${kind})`);
  const taskId = JSON.parse(taskIdLine).taskId;

  // The dispatch.start call never returns: the hook SIGKILLs the driver.
  await waitFor(() => driver.exitCode !== null || driver.signalCode !== null, 15_000,
    `driver crash (${kind}); stderr=${stderrText.slice(0, 300)}`);

  const coordinationDir = join(stateDir, 'coordinations', coordinationId);
  const intentsDir = join(coordinationDir, 'launch-intents');
  await waitFor(() => {
    try {
      return readdirSync(intentsDir).some((name) => name.endsWith('.json'));
    } catch {
      return false;
    }
  }, 5_000, `bound launch intent (${kind})`);
  const intentPath = join(intentsDir, readdirSync(intentsDir).find((name) => name.endsWith('.json')));
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  assert.equal(intent.taskId, taskId);
  const journalPath = join(coordinationDir, 'events.jsonl');
  const journalRecords = () => readFileSync(journalPath, 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));

  return {
    stateDir,
    coordinationId,
    taskId,
    intentPath,
    intent,
    journalRecords,
    orphanPid: intent.processIdentity.pid,
    cleanup: () => {
      try { process.kill(-intent.processIdentity.pid, 'SIGKILL'); } catch { /* gone */ }
      try { process.kill(intent.processIdentity.pid, 'SIGKILL'); } catch { /* gone */ }
    },
  };
}

/** Start an in-process RECOVERY supervisor over a crashed owner's state. */
async function recover(t, crash, { hideIdentityForPid = null } = {}) {
  let identityDepsFactory;
  if (hideIdentityForPid !== null) {
    identityDepsFactory = () => {
      const real = createPlatformIdentityDeps();
      return {
        platform: real.platform,
        getStartIdentity: async (pid) => (pid === hideIdentityForPid ? null : real.getStartIdentity(pid)),
        getProcessGroupId: async (pid) => real.getProcessGroupId(pid),
        getRuntimeNonce: () => null,
      };
    };
  }
  const recovered = await createSupervisor({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: crash.stateDir },
    mode: 'recover',
    coordinationId: crash.coordinationId,
    ...(identityDepsFactory ? { identityDepsFactory } : {}),
  });
  t.after(() => recovered.stop());
  return recovered;
}

function findRecord(records, type, predicate = () => true) {
  return records.filter((record) => record.type === type && predicate(record));
}

/* ------------------------------------------------------------------ */

test('R12B: owned-process crash after spawn leaves a bound lease recovery can settle', async (t) => {
  const workspace = tempStateDir(t, 'ws-owned');
  const crash = await runCrashingOwner(t, 'owned', { workspace });

  assert.equal(crash.intent.state, 'bound');
  assert.equal(crash.intent.processIdentity.identityProven, true);
  assert.ok(Number.isInteger(crash.orphanPid) && crash.orphanPid > 0);
  assert.equal(pidAlive(crash.orphanPid), true, 'the spawned worker must still be alive after the owner crash');

  await recover(t, crash);

  const records = crash.journalRecords();
  assert.ok(findRecord(records, 'dispatch_reconciled', (r) => r.payload?.outcome === 'lost'
    && r.payload?.reason === 'launch-intent-orphan-stopped-after-crash-window').length > 0,
  `expected orphan-stopped reconciliation; got ${JSON.stringify(records.map((r) => [r.type, r.payload?.reason]))}`);
  assert.ok(findRecord(records, 'cleanup_recorded', (r) => r.payload?.disposition === 'launch-intent-orphan-stopped').length > 0);
  assert.equal(existsSync(crash.intentPath), false, 'the consumed lease must be removed after a proven stop');
  assert.equal(pidAlive(crash.orphanPid), false, 'recovery must have stopped the orphan through proven identity');
});

test('R12B: claude-stream crash after spawn is recovered via its bound lease', async (t) => {
  const workspace = tempStateDir(t, 'ws-claude');
  const crash = await runCrashingOwner(t, 'claude', { workspace });

  assert.equal(crash.intent.state, 'bound');
  assert.equal(crash.intent.processIdentity.identityProven, true);
  assert.equal(crash.intent.adapterId, 'claude-stream');
  assert.equal(pidAlive(crash.orphanPid), true);

  await recover(t, crash);

  const records = crash.journalRecords();
  assert.ok(findRecord(records, 'dispatch_reconciled', (r) => r.payload?.outcome === 'lost'
    && r.payload?.reason === 'launch-intent-orphan-stopped-after-crash-window').length > 0);
  assert.ok(findRecord(records, 'cleanup_recorded', (r) => r.payload?.disposition === 'launch-intent-orphan-stopped').length > 0);
  assert.equal(existsSync(crash.intentPath), false);
  assert.equal(pidAlive(crash.orphanPid), false, 'the trapped claude fixture must die by the SIGKILL ladder step');
});

test('R12B: codex-exec crash after spawn is recovered via its bound lease', async (t) => {
  const workspace = gitWorkspace(t, 'ws-codex');
  const crash = await runCrashingOwner(t, 'codex', { workspace });

  assert.equal(crash.intent.state, 'bound');
  assert.equal(crash.intent.processIdentity.identityProven, true);
  assert.equal(crash.intent.adapterId, 'codex-exec');
  assert.equal(pidAlive(crash.orphanPid), true);

  await recover(t, crash);

  const records = crash.journalRecords();
  assert.ok(findRecord(records, 'dispatch_reconciled', (r) => r.payload?.outcome === 'lost'
    && r.payload?.reason === 'launch-intent-orphan-stopped-after-crash-window').length > 0);
  assert.equal(existsSync(crash.intentPath), false);
  assert.equal(pidAlive(crash.orphanPid), false);
});

test('R12B: opencode crash BEFORE readiness keeps the DB lease and recovery releases the tree', async (t) => {
  const workspace = tempStateDir(t, 'ws-oc');
  const crash = await runCrashingOwner(t, 'opencode', { workspace });

  assert.equal(crash.intent.state, 'bound');
  assert.equal(crash.intent.processIdentity.identityProven, true);
  const lease = crash.intent.cleanupLease;
  assert.ok(lease, 'the opencode handshake must persist the runtime DB cleanup lease');
  assert.equal(lease.ownershipMode, 'runtime-owned');
  assert.equal(lease.databaseIdentity, createHash('sha256').update(lease.canonicalRuntimeDbPath).digest('hex'));
  // The reserved database tree EXISTS while the crashed server holds it.
  assert.equal(existsSync(join(lease.canonicalRuntimeDbDir, 'opencode.db')), true, 'reserved db must exist pre-recovery');

  await recover(t, crash);

  const records = crash.journalRecords();
  assert.ok(findRecord(records, 'cleanup_recorded', (r) => r.payload?.disposition === 'launch-intent-orphan-stopped').length > 0);
  assert.ok(findRecord(records, 'cleanup_recorded', (r) => r.payload?.disposition === 'recovered-runtime-database-released').length > 0,
    'recovery must release the leased runtime database after the proven stop');
  assert.equal(existsSync(crash.intentPath), false);
  assert.equal(pidAlive(crash.orphanPid), false);
  assert.equal(existsSync(lease.canonicalRuntimeDbDir), false, 'the isolated database tree must be gone');
});

test('R12B: an unproven crash-window worker is RETAINED with its lease — never signalled, never swept', async (t) => {
  const workspace = tempStateDir(t, 'ws-unproven');
  const crash = await runCrashingOwner(t, 'opencode', { workspace });

  // Recovery boots with identity probes HIDDEN for exactly this pid.
  await recover(t, crash, { hideIdentityForPid: crash.orphanPid });

  const records = crash.journalRecords();
  assert.equal(
    findRecord(records, 'cleanup_recorded', (r) => String(r.payload?.disposition ?? '').includes('runtime-database')).length,
    0,
    'an unproven attempt must not consume the one-shot DB release receipt',
  );
  assert.ok(
    findRecord(records, 'dispatch_reconciled', (r) => r.payload?.outcome === 'lost'
      && r.payload?.reason === 'launch-intent-stop-unproven-retained-after-crash-window').length > 0,
    `unexpected reconciliation reasons: ${JSON.stringify(records.map((r) => [r.type, r.payload?.reason]))}`,
  );
  assert.equal(existsSync(crash.intentPath), true, 'the bound lease must survive when absence is unproven');
  const retainedIntent = JSON.parse(readFileSync(crash.intentPath, 'utf8'));
  assert.ok(retainedIntent.cleanupLease, 'the DB lease must remain available for a later retry');
  assert.equal(pidAlive(crash.orphanPid), true, 'an unproven pid must NEVER be signalled by recovery');

  // Later proof path: prove death ourselves, then the SAME retained lease
  // releases the tree successfully.
  try { process.kill(-crash.orphanPid, 'SIGKILL'); } catch { /* gone */ }
  await waitFor(() => !pidAlive(crash.orphanPid), 5_000, 'manual orphan stop');
  const outcome = await releaseRecoveredRuntimeDatabase({ cleanupLease: retainedIntent.cleanupLease }, {});
  assert.equal(outcome.released, true, `retained lease must stay usable: ${JSON.stringify(outcome)}`);
  assert.equal(outcome.absenceProven, true);
});
