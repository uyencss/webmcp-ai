import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/*
 * R13 BUG 1 (blocking): `group-stopped` + `exitProven: true` must ONLY be
 * claimed once the WHOLE process group is proven empty (`kill(-pgid, 0)` ->
 * ESRCH) — never merely because the group LEADER's own `exit` event fired.
 *
 * DISCIPLINE (per the R13 handoff, because a prior remediation round wrote
 * tests that missed this exact bug):
 *   - NO monkeypatching `process.kill`.
 *   - NO stub child objects (`{ exitCode: null, once() {}, kill() {} }`).
 *   - Every fixture here is a REAL spawned process. The leader COMPLIES
 *     with the terminating signal (dies) while a grandchild in the same
 *     process group explicitly IGNORES it and tries to survive.
 *   - Assertion shape: close() must return EITHER 'group-signalled' OR
 *     'group-stopped' with the grandchild verifiably dead (via a real
 *     `process.kill(pid, 0)` probe) — NEVER 'group-stopped' while the
 *     grandchild is still alive.
 */

function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `webmcp-ai-r13b1-${name}-`));
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

/**
 * Assert the acceptance shape required by the R13 handoff: `group-stopped`
 * is legal ONLY when the grandchild is verifiably dead; any other outcome
 * (signals sent, grandchild survives) must self-report as pending-retry,
 * never as a proven exit.
 */
function assertNeverFalseGroupStopped(receipt, kidPid, label) {
  const kidAlive = isAlive(kidPid);
  if (receipt.disposition === 'group-stopped') {
    // THE core invariant comes first: this is the exact symptom BUG1
    // describes (an orphan left running after a "proven" close). The
    // exitProven honesty check is secondary and would otherwise mask this
    // behind a less informative failure message.
    assert.equal(kidAlive, false,
      `${label}: THE BUG — group-stopped claimed while the grandchild (pid ${kidPid}) is still alive`);
    assert.equal(receipt.exitProven, true, `${label}: group-stopped must carry exitProven`);
  } else {
    assert.equal(receipt.disposition, 'group-signalled',
      `${label}: a surviving group must self-report group-signalled, got ${receipt.disposition}`);
  }
}

/** A leader that COMPLIES with SIGTERM (and SIGINT) but spawns one
 * grandchild, in the same process group, that IGNORES both and keeps
 * running via a busy interval. This is the exact intersection the R13
 * handoff identifies as uncovered: "leader tuân thủ + grandchild ignore". */
function writeCompliantLeaderFixture(dir, { emitClaudeInit = false } = {}) {
  const kidFile = join(dir, 'kid.pid');
  const leaderFixture = join(dir, 'leader.mjs');
  // The grandchild writes ITS OWN pid file, and only AFTER it has installed
  // its SIGTERM/SIGINT handlers. Writing the pid file from the LEADER
  // immediately after spawn() (before the new node process has even parsed
  // its own script) is a real race: a signal can arrive before the handler
  // is registered, killing the "stubborn" grandchild via default
  // disposition and producing a false negative that looks like a pass.
  // JSON.stringify embeds the child script as a safe, unambiguous string
  // literal — no hand-escaped quoting to get wrong.
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
    lines.push("process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'r13b1' }) + '\\n');");
  }
  lines.push(
    "process.on('SIGTERM', () => process.exit(0));",
    "process.on('SIGINT', () => process.exit(0));",
    "setInterval(() => {}, 1000);",
  );
  writeFileSync(leaderFixture, lines.join('\n'));
  return { kidFile, leaderFixture };
}

function killQuiet(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

/* ------------------------------------------------------------------ */
/* owned-process                                                       */
/* ------------------------------------------------------------------ */

test('R13-BUG1 owned-process: close() never claims group-stopped while a SIGTERM-ignoring grandchild survives', { timeout: 15_000 }, async (t) => {
  const op = await import('../src/orchestration/adapters/owned-process.mjs');
  const dir = tempDir('op');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { kidFile, leaderFixture } = writeCompliantLeaderFixture(dir);

  const adapter = op.createOwnedProcessAdapter({ stateDir: dir, signalGraceMs: 250 });
  const spawned = await adapter.spawn({
    task: { taskId: 'task_r13op', workspace: dir },
    dispatch: { dispatchId: 'disp_r13op', bindingId: 'worker_r13op' },
    command: process.execPath,
    args: [leaderFixture],
    env: { ...process.env, KID_FILE: kidFile },
    emit: () => {},
  });

  const kidPid = await waitForGrandchildPid(kidFile);
  t.after(() => { killQuiet(kidPid); killQuiet(spawned.binding?.processIdentity?.pid); });

  const closed = await adapter.close({ binding: spawned.binding });
  assertNeverFalseGroupStopped(closed, kidPid, 'owned-process');

  // Regardless of which branch fired, the leader itself must be gone.
  await waitFor(() => !isAlive(spawned.binding.processIdentity.pid), 3000, 'leader to be gone');
});

/* ------------------------------------------------------------------ */
/* claude-stream                                                       */
/* ------------------------------------------------------------------ */

test('R13-BUG1 claude-stream: close() never claims group-stopped while a SIGTERM-ignoring grandchild survives', { timeout: 15_000 }, async (t) => {
  const claudeMod = await import('../src/orchestration/adapters/claude-stream.mjs');
  const dir = tempDir('cs');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { kidFile, leaderFixture } = writeCompliantLeaderFixture(dir, { emitClaudeInit: true });

  const adapter = claudeMod.createClaudeStreamAdapter({
    stateDir: dir,
    claudeBin: process.execPath,
    claudeArgs: [leaderFixture],
    fakeModeEnv: { KID_FILE: kidFile },
    closeGraceMsForTest: 250,
    forceCloseGraceMsForTest: 250,
  });

  const spawned = await adapter.spawn({
    task: { taskId: 'task_r13cs', workspace: dir, objective: 'noop' },
    dispatch: { dispatchId: 'disp_r13cs', bindingId: 'worker_r13cs' },
    emit: () => {},
  });
  assert.equal(spawned.ok, true, 'spawn must succeed');

  const kidPid = await waitForGrandchildPid(kidFile);
  t.after(() => { killQuiet(kidPid); killQuiet(spawned.binding?.processIdentity?.pid); });

  const closed = await adapter.close({ binding: spawned.binding });
  assertNeverFalseGroupStopped(closed, kidPid, 'claude-stream');

  await waitFor(() => !isAlive(spawned.binding.processIdentity.pid), 3000, 'leader to be gone');
});

/* ------------------------------------------------------------------ */
/* codex-exec                                                          */
/* ------------------------------------------------------------------ */

function gitWorkspace() {
  const dir = tempDir('codex-ws');
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'r13@example.com']);
  git(['config', 'user.name', 'R13']);
  writeFileSync(join(dir, 'README.md'), '# r13 fixture\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  return dir;
}

test('R13-BUG1 codex-exec: close() never claims group-stopped while a SIGTERM-ignoring grandchild survives', { timeout: 15_000 }, async (t) => {
  const codexMod = await import('../src/orchestration/adapters/codex-exec.mjs');
  const stateDir = tempDir('codex-state');
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const workspace = gitWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const { kidFile, leaderFixture } = writeCompliantLeaderFixture(stateDir);

  const adapter = codexMod.createCodexExecAdapter({
    stateDir,
    codexBin: process.execPath,
    codexArgs: [leaderFixture],
    env: { ...process.env, KID_FILE: kidFile },
  });

  const spawned = await adapter.spawn({
    task: { taskId: 'task_r13codex', workspace, objective: 'noop' },
    dispatch: { dispatchId: 'disp_r13codex', bindingId: 'worker_r13codex' },
    emit: () => {},
  });
  assert.equal(spawned.ok, true, `spawn must succeed: ${JSON.stringify(spawned.error ?? {})}`);

  const kidPid = await waitForGrandchildPid(kidFile);
  t.after(() => { killQuiet(kidPid); killQuiet(spawned.binding?.processIdentity?.pid); });

  // codex-exec's close() SIGKILLs directly (no SIGTERM step) — the leader's
  // own compliance handler is irrelevant here since SIGKILL cannot be
  // trapped, but the grandchild must still be reachable through the SAME
  // group signal, not merely inferred from the leader dying.
  const closed = await adapter.close({ binding: spawned.binding });
  assertNeverFalseGroupStopped(closed, kidPid, 'codex-exec');

  await waitFor(() => !isAlive(spawned.binding.processIdentity.pid), 3000, 'leader to be gone');
});

/* ------------------------------------------------------------------ */
/* opencode-server                                                      */
/* ------------------------------------------------------------------ */

test('R13-BUG1 opencode-server: stopServer() never claims exitProven while a SIGTERM-ignoring grandchild survives', { timeout: 20_000 }, async (t) => {
  const serverMod = await import('../src/orchestration/adapters/opencode-server.mjs');
  const stateDir = tempDir('oc-state');
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const workspace = tempDir('oc-ws');
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const kidFile = join(stateDir, 'kid.pid');
  const serveFixture = join(stateDir, 'serve-stubborn-kid.mjs');
  // The grandchild writes its OWN pid file, only AFTER installing its
  // SIGTERM/SIGINT handlers — see writeCompliantLeaderFixture above for why
  // a parent-writes-immediately pid file is a real race that produces false
  // negatives (the signal can arrive before the handler is registered).
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
    "  // The leader installs NO SIGTERM handler: it dies from the very",
    "  // first signal's default disposition, exactly like a compliant real",
    "  // worker would. Only the grandchild is deliberately stubborn.",
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
    '  });',
    '}',
    '',
  ].join('\n'));

  // Sandbox HOME so the runtime database lands under this test's own temp
  // tree, never the real ~/Library/Application Support/opencode/ data root
  // (same isolation pattern as tests/orchestration-db-confinement.test.mjs).
  const sandboxHome = tempDir('oc-home');
  t.after(() => rmSync(sandboxHome, { recursive: true, force: true }));
  const adapter = serverMod.createOpenCodeServerAdapter({
    openCodeBin: process.execPath,
    openCodeArgs: [serveFixture],
    stateDir,
    env: { HOME: sandboxHome },
  });

  const started = await adapter.startRuntimeServer({ workspace, bindingId: 'worker_r13oc', fenceEpoch: 1 });
  const kidPid = await waitForGrandchildPid(kidFile);
  t.after(() => { killQuiet(kidPid); killQuiet(started.runtime?.__serverChild?.pid); });

  const receipt = await adapter.stopServer(started.runtime);

  const kidAlive = isAlive(kidPid);
  if (receipt.exitProven) {
    assert.equal(kidAlive, false,
      `THE BUG — stopServer claimed exitProven while the grandchild (pid ${kidPid}) is still alive`);
  }
  // The leader (server) itself must always be gone once stopServer returns:
  // it is either reaped by the ladder or was already dead.
  assert.equal(isAlive(started.runtime.__serverChild?.pid), false, 'server leader must not survive stopServer()');
});
