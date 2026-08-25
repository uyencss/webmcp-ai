import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/*
 * R13 BUG 1b: a companion gap to BUG1, found by independent verification.
 *
 * BUG1's fix put the group-emptiness probe INSIDE the "child still alive"
 * branch of every close()/stopServer(). The "child ALREADY exited before
 * close() was even called" fast path (`if (gone()) return
 * {disposition:'already-exited', ...}` / `exitProven = !isChildLive(child)`)
 * still short-circuits straight to a proven-absence disposition WITHOUT
 * ever probing the group. This is the MORE common trigger than BUG1's
 * "leader complies with SIGTERM" case: it fires for any worker that simply
 * finishes its own work and exits normally while a background child it
 * spawned is still running — no signal ladder involved at all, since
 * close() is called well after the leader is already gone.
 *
 * DISCIPLINE (same as BUG1): real spawned processes only, no
 * process.kill monkeypatch, no stub child objects.
 */

function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `webmcp-ai-r13b1b-${name}-`));
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
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
    if (result) return;
    if (Date.now() - startedAt > deadlineMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
}

async function waitForGrandchildPid(kidFile) {
  await waitFor(() => existsSync(kidFile) && readFileSync(kidFile, 'utf8').trim().length > 0, 5000, 'grandchild pid file');
  const kidPid = Number.parseInt(readFileSync(kidFile, 'utf8').trim(), 10);
  await waitFor(() => isAlive(kidPid), 3000, 'grandchild to actually be alive');
  return kidPid;
}

function killQuiet(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

/**
 * A leader that spawns one grandchild (which ignores SIGTERM/SIGINT and
 * self-reports its own pid only once its handlers are installed — see the
 * r13-bug1 test file for why a parent-writes-immediately pid file races),
 * then exits NORMALLY on its own shortly after — exactly like any worker
 * CLI that finishes its job while a detached/background child lingers.
 * There is no signal involved in the leader's own exit at all.
 */
function writeSelfExitingLeaderFixture(dir, { emitClaudeInit = false } = {}) {
  const kidFile = join(dir, 'kid.pid');
  const leaderFixture = join(dir, 'leader.mjs');
  const kidScript = [
    "process.on('SIGTERM', () => {});",
    "process.on('SIGINT', () => {});",
    'require("fs").writeFileSync(process.env.KID_FILE, String(process.pid));',
    'setInterval(() => {}, 1000);',
  ].join(' ');
  const lines = [
    "import { spawn } from 'node:child_process';",
    `const kid = spawn(process.execPath, ['-e', ${JSON.stringify(kidScript)}], { stdio: 'ignore' });`,
    'void kid;',
  ];
  if (emitClaudeInit) {
    lines.push("process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'r13b1b' }) + '\\n');");
  }
  lines.push(
    '// The leader exits NORMALLY on its own well before close() is ever',
    '// called -- no signal involved -- exactly like a worker that finished',
    '// its job while a background child it spawned lingers.',
    'setTimeout(() => process.exit(0), 250);',
  );
  writeFileSync(leaderFixture, lines.join('\n'));
  return { kidFile, leaderFixture };
}

/** Asserts the BUG1b acceptance shape: a proven-absence-flavoured
 * disposition/exitProven is legal ONLY when the grandchild is verifiably
 * dead; otherwise it must self-report pending-retry. */
function assertNeverFalseProvenAbsence(receipt, kidPid, label) {
  const kidAlive = isAlive(kidPid);
  const provenLike = receipt.disposition === 'group-stopped'
    || receipt.disposition === 'already-exited'
    || receipt.disposition === 'no-op';
  if (provenLike) {
    assert.equal(kidAlive, false,
      `${label}: THE BUG — disposition=${receipt.disposition} claimed while the grandchild (pid ${kidPid}) is still alive`);
  } else {
    assert.equal(receipt.disposition, 'group-signalled',
      `${label}: a surviving group must self-report group-signalled, got ${receipt.disposition}`);
  }
}

/* ------------------------------------------------------------------ */
/* owned-process                                                       */
/* ------------------------------------------------------------------ */

test('R13-BUG1b owned-process: close() never claims already-exited/proven while a grandchild of an already-dead leader survives', { timeout: 15_000 }, async (t) => {
  const op = await import('../src/orchestration/adapters/owned-process.mjs');
  const dir = tempDir('op');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { kidFile, leaderFixture } = writeSelfExitingLeaderFixture(dir);

  const adapter = op.createOwnedProcessAdapter({ stateDir: dir, signalGraceMs: 250 });
  const spawned = await adapter.spawn({
    task: { taskId: 'task_r13op_b', workspace: dir },
    dispatch: { dispatchId: 'disp_r13op_b', bindingId: 'worker_r13op_b' },
    command: process.execPath,
    args: [leaderFixture],
    env: { ...process.env, KID_FILE: kidFile },
    emit: () => {},
  });

  const kidPid = await waitForGrandchildPid(kidFile);
  t.after(() => { killQuiet(kidPid); killQuiet(spawned.binding?.processIdentity?.pid); });

  // Prove the leader is ALREADY gone -- on its own, no signal involved --
  // well before close() is ever invoked, then wait a bit longer so this is
  // not merely a tight timing coincidence.
  await waitFor(() => !isAlive(spawned.binding.processIdentity.pid), 3000, 'leader to self-exit');
  await new Promise((resolveTick) => setTimeout(resolveTick, 300));
  assert.equal(isAlive(kidPid), true, 'setup: grandchild must still be alive when close() is invoked');

  const closed = await adapter.close({ binding: spawned.binding });
  assertNeverFalseProvenAbsence(closed, kidPid, 'owned-process');
});

/* ------------------------------------------------------------------ */
/* claude-stream                                                       */
/* ------------------------------------------------------------------ */

test('R13-BUG1b claude-stream: close() never claims already-exited while a grandchild of an already-dead leader survives', { timeout: 15_000 }, async (t) => {
  const claudeMod = await import('../src/orchestration/adapters/claude-stream.mjs');
  const dir = tempDir('cs');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { kidFile, leaderFixture } = writeSelfExitingLeaderFixture(dir, { emitClaudeInit: true });

  const adapter = claudeMod.createClaudeStreamAdapter({
    stateDir: dir,
    claudeBin: process.execPath,
    claudeArgs: [leaderFixture],
    fakeModeEnv: { KID_FILE: kidFile },
    closeGraceMsForTest: 250,
    forceCloseGraceMsForTest: 250,
  });

  const spawned = await adapter.spawn({
    task: { taskId: 'task_r13cs_b', workspace: dir, objective: 'noop' },
    dispatch: { dispatchId: 'disp_r13cs_b', bindingId: 'worker_r13cs_b' },
    emit: () => {},
  });
  assert.equal(spawned.ok, true, 'spawn must succeed');

  const kidPid = await waitForGrandchildPid(kidFile);
  t.after(() => { killQuiet(kidPid); killQuiet(spawned.binding?.processIdentity?.pid); });

  await waitFor(() => !isAlive(spawned.binding.processIdentity.pid), 3000, 'leader to self-exit');
  await new Promise((resolveTick) => setTimeout(resolveTick, 300));
  assert.equal(isAlive(kidPid), true, 'setup: grandchild must still be alive when close() is invoked');

  const closed = await adapter.close({ binding: spawned.binding });
  assertNeverFalseProvenAbsence(closed, kidPid, 'claude-stream');
});

/* ------------------------------------------------------------------ */
/* codex-exec                                                          */
/* ------------------------------------------------------------------ */

function gitWorkspace() {
  const dir = tempDir('codex-ws');
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'r13b1b@example.com']);
  git(['config', 'user.name', 'R13B1B']);
  writeFileSync(join(dir, 'README.md'), '# r13b1b fixture\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  return dir;
}

test('R13-BUG1b codex-exec: close() never claims already-exited while a grandchild of an already-dead leader survives', { timeout: 15_000 }, async (t) => {
  const codexMod = await import('../src/orchestration/adapters/codex-exec.mjs');
  const stateDir = tempDir('codex-state');
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const workspace = gitWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const { kidFile, leaderFixture } = writeSelfExitingLeaderFixture(stateDir);

  const adapter = codexMod.createCodexExecAdapter({
    stateDir,
    codexBin: process.execPath,
    codexArgs: [leaderFixture],
    env: { ...process.env, KID_FILE: kidFile },
  });

  const spawned = await adapter.spawn({
    task: { taskId: 'task_r13codex_b', workspace, objective: 'noop' },
    dispatch: { dispatchId: 'disp_r13codex_b', bindingId: 'worker_r13codex_b' },
    emit: () => {},
  });
  assert.equal(spawned.ok, true, `spawn must succeed: ${JSON.stringify(spawned.error ?? {})}`);

  const kidPid = await waitForGrandchildPid(kidFile);
  t.after(() => { killQuiet(kidPid); killQuiet(spawned.binding?.processIdentity?.pid); });

  await waitFor(() => !isAlive(spawned.binding.processIdentity.pid), 3000, 'leader to self-exit');
  await new Promise((resolveTick) => setTimeout(resolveTick, 300));
  assert.equal(isAlive(kidPid), true, 'setup: grandchild must still be alive when close() is invoked');

  const closed = await adapter.close({ binding: spawned.binding });
  assertNeverFalseProvenAbsence(closed, kidPid, 'codex-exec');
});

/* ------------------------------------------------------------------ */
/* opencode-server                                                      */
/* ------------------------------------------------------------------ */

test('R13-BUG1b opencode-server: stopServer() never claims exitProven while a grandchild of an already-dead leader survives', { timeout: 20_000 }, async (t) => {
  const serverMod = await import('../src/orchestration/adapters/opencode-server.mjs');
  const stateDir = tempDir('oc-state');
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const workspace = tempDir('oc-ws');
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const sandboxHome = tempDir('oc-home');
  t.after(() => rmSync(sandboxHome, { recursive: true, force: true }));
  const kidFile = join(stateDir, 'kid.pid');
  const serveFixture = join(stateDir, 'serve-stubborn-kid-selfexit.mjs');
  const kidScript = [
    "process.on('SIGTERM', () => {});",
    "process.on('SIGINT', () => {});",
    `require("fs").writeFileSync(${JSON.stringify(kidFile)}, String(process.pid));`,
    'setInterval(() => {}, 1000);',
  ].join(' ');
  writeFileSync(serveFixture, [
    "import { createServer } from 'node:http';",
    "import { spawn } from 'node:child_process';",
    'const mode = process.argv[2];',
    "if (mode === '--version') { console.log('1.18.21'); process.exit(0); }",
    "if (mode === 'debug') { console.log('{}'); process.exit(0); }",
    "if (mode === 'db') { console.log(process.env.OPENCODE_DB ?? ''); process.exit(0); }",
    "if (mode === 'serve') {",
    `  spawn(process.execPath, ['-e', ${JSON.stringify(kidScript)}], { stdio: 'ignore' });`,
    "  const pass = process.env.WEBMCP_FAKE_SERVER_PASSWORD ?? '';",
    '  const http = createServer((req, res) => {',
    "    if ((req.headers.authorization ?? '') !== ('Basic ' + Buffer.from('opencode:' + pass).toString('base64'))) {",
    '      res.writeHead(401); res.end(); return;',
    '    }',
    "    res.writeHead(200, { 'content-type': 'application/json' });",
    "    res.end(JSON.stringify({ status: 'ok' }));",
    '  });',
    "  http.listen(Number(process.env.WEBMCP_FAKE_PORT) || 0, '127.0.0.1', () => {",
    "    process.stdout.write('opencode server listening on http://127.0.0.1:' + http.address().port + '\\n');",
    "    // The server LEADER exits NORMALLY on its own shortly after ready --",
    "    // no signal involved -- exactly like a worker that finished and",
    "    // exited while its background child lingers.",
    '    setTimeout(() => process.exit(0), 250);',
    '  });',
    '}',
    '',
  ].join('\n'));

  const adapter = serverMod.createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [serveFixture],
    stateDir,
    env: { HOME: sandboxHome },
  });

  const started = await adapter.startRuntimeServer({ workspace, bindingId: 'worker_r13oc_b', fenceEpoch: 1 });
  const kidPid = await waitForGrandchildPid(kidFile);
  t.after(() => { killQuiet(kidPid); killQuiet(started.runtime?.__serverChild?.pid); });

  await waitFor(() => !isAlive(started.runtime.__serverChild?.pid), 3000, 'server leader to self-exit');
  await new Promise((resolveTick) => setTimeout(resolveTick, 300));
  assert.equal(isAlive(kidPid), true, 'setup: grandchild must still be alive when stopServer() is invoked');

  const receipt = await adapter.stopServer(started.runtime);
  const kidAlive = isAlive(kidPid);
  if (receipt.exitProven) {
    assert.equal(kidAlive, false,
      `THE BUG — stopServer claimed exitProven while the grandchild (pid ${kidPid}) is still alive`);
  }
});

/* ------------------------------------------------------------------ */
/* pid-reuse guard (requirement #3 from the coordinator's follow-up)   */
/* ------------------------------------------------------------------ */

test('R13-BUG1b pid-reuse guard: close() never signals a recorded groupId whose literal pid is now occupied by an unrelated live process', { timeout: 15_000 }, async (t) => {
  const op = await import('../src/orchestration/adapters/owned-process.mjs');
  const dir = tempDir('pidreuse');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const leaderFixture = join(dir, 'leader.mjs');
  writeFileSync(leaderFixture, 'setTimeout(() => process.exit(0), 200);\n');

  const adapter = op.createOwnedProcessAdapter({ stateDir: dir, signalGraceMs: 200 });
  const spawned = await adapter.spawn({
    task: { taskId: 'task_r13pidreuse', workspace: dir },
    dispatch: { dispatchId: 'disp_r13pidreuse', bindingId: 'worker_r13pidreuse' },
    command: process.execPath,
    args: [leaderFixture],
    env: { ...process.env },
    emit: () => {},
  });
  const leaderPid = spawned.binding.processIdentity.pid;

  await waitFor(() => !isAlive(leaderPid), 3000, 'leader to self-exit');

  // Simulate "the OS recycled this exact pid number for an unrelated live
  // process" WITHOUT needing to actually win the OS pid-allocator race:
  // forge the recorded groupId onto a real, unrelated, definitely-alive
  // pid (our own test process). If the guard is working, close() must
  // treat this as an untrustworthy group and send ZERO signals anywhere
  // near it -- our own process pid is the sentinel: it must survive
  // completely untouched (no signal delivery attempted against it at all).
  const forgedBinding = {
    ...spawned.binding,
    processIdentity: { ...spawned.binding.processIdentity, processGroupId: process.pid },
  };

  const closed = await adapter.close({ binding: forgedBinding });

  assert.equal(closed.disposition, 'group-signalled',
    `a groupId whose literal pid is occupied by an unrelated live process must never settle proven, got ${closed.disposition}`);
  assert.deepEqual(closed.signalsAttempted, [],
    'no signal may be sent at all once the literal groupId pid is proven occupied by someone else');
  assert.equal(isAlive(process.pid), true, 'sentinel: our own unrelated process must never be touched');
});
