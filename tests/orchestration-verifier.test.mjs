import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  canonicalizeWorkspacePath,
  captureWorkspaceBaseline,
  runAcceptanceCommand,
  verifyDispatch,
} from '../src/orchestration/verifier.mjs';

function gitRepo(t, name = 'ws', { commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-t8-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@local');
  git('config', 'user.name', 'tester');
  writeFileSync(join(dir, 'README.md'), '# seed\n');
  if (commit) {
    git('add', '-A');
    git('commit', '-qm', 'seed');
  }
  return { dir, git };
}

function baseTask(workspace, overrides = {}) {
  return {
    taskId: 'task_v',
    objective: 'Bounded verified work',
    workspace,
    allowedReadRoots: [workspace],
    allowedWriteRoots: [join(workspace, 'src')],
    protectedPaths: [join(workspace, 'package.json')],
    dependencies: [],
    acceptanceCommands: [],
    commandPolicy: { allowedExecutables: [process.execPath] },
    delegationDepth: 1,
    initialRevision: null,
    ...overrides,
  };
}

const baseContext = {
  coordinationId: 'coord_v',
  taskId: 'task_v',
  dispatchId: 'disp_v',
  fenceEpoch: 1,
};

test('clean baseline plus one allowed change is eligible for acceptance', async (t) => {
  const { dir } = gitRepo(t);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'new.ts'), 'export {};\n');
  const task = baseTask(dir);
  const baseline = captureWorkspaceBaseline(task);

  const receipt = await verifyDispatch({
    ...baseContext,
    task,
    baseline,
    workerOutcome: 'completed',
    commands: [[process.execPath, '-e', 'process.exit(0)']],
    now: Date.now(),
  });

  assert.equal(receipt.schema, 'webmcp.ai-acceptance-receipt/v0');
  assert.equal(receipt.workspace.protectedPathViolations.length, 0);
  assert.deepEqual(receipt.workspace.changedPaths, ['src/new.ts']);
  assert.equal(receipt.workerClaimMatched, true);
  assert.equal(receipt.verdict, 'accepted');
});

test('pre-existing dirty protected file survives when untouched', async (t) => {
  const { dir } = gitRepo(t);
  mkdirGuard(dir);
  writeFileSync(join(dir, 'package.json'), '{"dirty":"pre-existing"}\n');
  const task = baseTask(dir);
  const baseline = captureWorkspaceBaseline(task);

  const receipt = await verifyDispatch({
    ...baseContext,
    task,
    baseline,
    workerOutcome: 'completed',
    commands: [[process.execPath, '-e', 'process.exit(0)']],
    now: Date.now(),
  });
  assert.equal(receipt.verdict, 'accepted');
  assert.equal(existsSync(join(dir, 'package.json')), true);
});

function mkdirGuard(dir) {
  // package.json sits at the root; nothing extra needed. Helper keeps intent explicit.
}

test('a worker that modifies a pre-existing dirty protected file is rejected', async (t) => {
  const { dir } = gitRepo(t);
  writeFileSync(join(dir, 'package.json'), '{"dirty":"pre-existing"}\n');
  const task = baseTask(dir);
  const baseline = captureWorkspaceBaseline(task);
  // Worker mutates the protected dirty file after the baseline.
  writeFileSync(join(dir, 'package.json'), '{"dirty":"mutated"}\n');

  const receipt = await verifyDispatch({
    ...baseContext,
    task,
    baseline,
    workerOutcome: 'completed',
    commands: [[process.execPath, '-e', 'process.exit(0)']],
    now: Date.now(),
  });
  assert.equal(receipt.verdict, 'rejected');
  assert.equal(receipt.workspace.protectedPathViolations.length >= 1, true);
});

test('new files outside allowed write roots are rejected', async (t) => {
  const { dir } = gitRepo(t);
  const task = baseTask(dir);
  const baseline = captureWorkspaceBaseline(task);
  writeFileSync(join(dir, 'outside.txt'), 'nope\n');

  const receipt = await verifyDispatch({
    ...baseContext,
    task,
    baseline,
    workerOutcome: 'completed',
    commands: [],
    now: Date.now(),
  });
  assert.equal(receipt.verdict, 'rejected');
});

test('symlinks inside allowed roots that escape the workspace are rejected', async (t) => {
  const { dir } = gitRepo(t);
  const outside = tmpdir();
  mkdirSync(join(dir, 'src'), { recursive: true });
  const task = baseTask(dir);
  const baseline = captureWorkspaceBaseline(task);
  symlinkSync(outside, join(dir, 'src', 'escape'));

  const receipt = await verifyDispatch({
    ...baseContext,
    task,
    baseline,
    workerOutcome: 'completed',
    commands: [],
    now: Date.now(),
  });
  assert.equal(receipt.verdict, 'rejected');
});

test('undeclared nested repositories reject verification', async (t) => {
  const { dir, git } = gitRepo(t);
  const task = baseTask(dir);
  const baseline = captureWorkspaceBaseline(task);
  // Worker creates a nested repo and commits inside it.
  mkdirSync(join(dir, 'src'), { recursive: true });
  execFileSync('git', ['-C', join(dir, 'src'), 'init', '-q']);
  writeFileSync(join(dir, 'src', 'nested.txt'), 'x\n');
  try {
    git('status', '--porcelain=v2');
  } catch {
    // status still works with an untracked nested repo directory.
  }

  const receipt = await verifyDispatch({
    ...baseContext,
    task,
    baseline,
    workerOutcome: 'completed',
    commands: [],
    now: Date.now(),
    declaredNestedRepositories: [],
  });
  assert.equal(receipt.verdict, 'rejected');
});

test('worker commits that move the revision without authority are rejected', async (t) => {
  const { dir, git } = gitRepo(t);
  const task = baseTask(dir, { allowedCommitAuthority: false });
  mkdirSync(join(dir, 'src'), { recursive: true });
  const baseline = captureWorkspaceBaseline(task);
  writeFileSync(join(dir, 'src', 'c.ts'), 'export x;\n');
  git('add', '-A');
  git('commit', '-qm', 'worker commit without authority');

  const receipt = await verifyDispatch({
    ...baseContext,
    task,
    baseline,
    workerOutcome: 'completed',
    commands: [],
    now: Date.now(),
  });
  assert.equal(receipt.verdict, 'rejected');
  assert.match(JSON.stringify(receipt), /revision/i);
});

test('worker done plus a red focused test is rejected with matched claim false', async (t) => {
  const { dir } = gitRepo(t);
  const task = baseTask(dir);
  const baseline = captureWorkspaceBaseline(task);

  const receipt = await verifyDispatch({
    ...baseContext,
    task,
    baseline,
    workerOutcome: 'completed',
    commands: [[process.execPath, '-e', 'process.exit(7)']],
    now: Date.now(),
    stateDir: dir,
  });
  assert.equal(receipt.verdict, 'rejected');
  assert.equal(receipt.tests[0].exitCode, 7);
  assert.equal(receipt.tests[0].verdict, 'failed');
  assert.equal(receipt.workerClaimMatched, false);
});

test('timeouts, signals, output spill and executable denial are typed evidence', async (t) => {
  const { dir } = gitRepo(t);
  const task = baseTask(dir);
  const stateDir = join(dir, 'refs-state');

  const timedOut = await runAcceptanceCommand({
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
    cwd: dir,
    timeoutMs: 300,
    stateDir,
  });
  assert.equal(timedOut.timedOut, true);
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);

  const signaled = await runAcceptanceCommand({
    argv: [process.execPath, '-e', 'setTimeout(() => process.kill(process.pid, "SIGTERM"), 50)'],
    cwd: dir,
    timeoutMs: 5000,
    stateDir,
  });
  assert.equal(signaled.signal, 'SIGTERM');

  const bigOutput = await runAcceptanceCommand({
    argv: [process.execPath, '-e', `process.stdout.write('y'.repeat(${300 * 1024}))`],
    cwd: dir,
    timeoutMs: 10_000,
    stateDir,
  });
  assert.match(bigOutput.outputRef ?? '', /ref/, 'oversized output spilled to a ref');

  const denial = await verifyDispatch({
    ...baseContext,
    task,
    baseline: captureWorkspaceBaseline(task),
    workerOutcome: 'completed',
    commands: [['definitely-not-allowed-bin', '--version']],
    now: Date.now(),
    stateDir,
  });
  assert.equal(denial.verdict, 'rejected');
  assert.equal(denial.tests[0].denied, true);
});

test('intended_RED is evidence only and can never accept final work', async (t) => {
  const { dir } = gitRepo(t);
  const task = baseTask(dir);

  const receipt = await verifyDispatch({
    ...baseContext,
    task,
    baseline: captureWorkspaceBaseline(task),
    workerOutcome: 'completed',
    commands: [{
      argv: [process.execPath, '-e', 'process.exit(1)'],
      intendedRed: true,
      cwd: dir,
      timeoutMs: 5000,
    }],
    now: Date.now(),
    stateDir: dir,
  });
  assert.notEqual(receipt.verdict, 'accepted', 'intended_RED alone never accepts');
  assert.equal(receipt.tests[0].verdict, 'intended_RED');
  assert.equal(receipt.workerClaimMatched, false);
});

test('workspace paths are canonicalized segment by segment against escapes', async (t) => {
  const { dir } = gitRepo(t);
  const ok = canonicalizeWorkspacePath(dir, join(dir, 'src', 'a.ts'));
  assert.match(ok, /^\/.*src\/a\.ts$/);
  assert.throws(
    () => canonicalizeWorkspacePath(dir, '/etc/passwd'),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});
