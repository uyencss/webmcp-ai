import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  canonicalizeWorkspacePath,
  captureWorkspaceBaseline,
  verifyDispatch,
} from '../src/orchestration/verifier.mjs';

function gitRepo(t, name = 'ws', { commit = true, parent = null } = {}) {
  const dir = parent
    ? join(parent, name)
    : mkdtempSync(join(tmpdir(), `webmcp-ai-r9a-${name}-`));
  if (!parent) t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
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
    taskId: 'task_r9a',
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
  coordinationId: 'coord_r9a',
  taskId: 'task_r9a',
  dispatchId: 'disp_r9a',
  fenceEpoch: 1,
};

function greenCommand() {
  return [[process.execPath, '-e', 'process.exit(0)']];
}

test('R9A: a vanished .git makes verification indeterminate even with GREEN acceptance', async (t) => {
  const { dir } = gitRepo(t, 'missing-git');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'ok.ts'), 'export {};\n');
  const task = baseTask(dir);
  const baseline = captureWorkspaceBaseline(task);

  // The worker (or an attacker) hides the repository metadata after the
  // baseline; the acceptance command still exits 0.
  renameSync(join(dir, '.git'), join(dir, '.git-hidden'));

  const receipt = await verifyDispatch({
    ...baseContext,
    task,
    baseline,
    workerOutcome: 'completed',
    commands: greenCommand(),
    now: Date.now(),
  });

  assert.equal(
    receipt.verdict,
    'indeterminate',
    'missing repository metadata must fail closed to indeterminate, never accepted',
  );
});

test('R9A: replacing the workspace with a foreign repository is rejected', async (t) => {
  // The OUTER repo is real, so removing the inner .git re-homes the canonical
  // top-level onto a DIFFERENT repository instead of leaving no repo at all.
  const { dir: outerRoot } = gitRepo(t, 'foreign');
  const { dir } = gitRepo(t, 'ws-inner', { commit: false, parent: outerRoot });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'keep.txt'), 'seed\n');
  execFileSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'inner seed'], { encoding: 'utf8' });
  const task = baseTask(dir);
  const baseline = captureWorkspaceBaseline(task);

  // Foreign replacement: the inner repository disappears so the canonical
  // top-level jumps to the OUTER repository.
  rmSync(join(dir, '.git'), { recursive: true, force: true });

  const receipt = await verifyDispatch({
    ...baseContext,
    task,
    baseline,
    workerOutcome: 'completed',
    commands: greenCommand(),
    now: Date.now(),
  });

  assert.notEqual(receipt.verdict, 'accepted', 'a changed repository identity can never accept');
  assert.equal(receipt.verdict, 'rejected');
});

test('R9A: corrupt Git metadata makes every required probe fail closed', async (t) => {
  const { dir } = gitRepo(t, 'corrupt-git');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'ok.ts'), 'export {};\n');
  const task = baseTask(dir);
  const baseline = captureWorkspaceBaseline(task);
  // Corrupt the repository metadata: rev-parse AND status must both fail.
  rmSync(join(dir, '.git'), { recursive: true, force: true });
  writeFileSync(join(dir, '.git'), 'not a git directory at all\n');

  const receipt = await verifyDispatch({
    ...baseContext,
    task,
    baseline,
    workerOutcome: 'completed',
    commands: greenCommand(),
    now: Date.now(),
  });

  assert.equal(receipt.verdict, 'indeterminate', 'failed Git probes must never yield accepted');
  assert.equal(receipt.workspace.gitEvidence, 'unavailable');
});

test('R9A: protected/write overlap is refused in BOTH directions before any write', async (t) => {
  const { dir } = gitRepo(t, 'overlap-a');
  // Direction 1: protected path sits INSIDE a writable root.
  const taskA = baseTask(dir, {
    allowedWriteRoots: [dir],
    protectedPaths: [join(dir, 'package.json')],
  });
  const receiptA = await verifyDispatch({
    ...baseContext,
    task: taskA,
    baseline: captureWorkspaceBaseline(taskA),
    workerOutcome: 'completed',
    commands: greenCommand(),
    now: Date.now(),
  });
  assert.equal(receiptA.verdict, 'rejected', 'writable root swallowing a protected path is a policy contradiction');
  assert.ok(
    receiptA.workspace.violations.some((violation) => violation.kind === 'protected_write_overlap'),
    JSON.stringify(receiptA.workspace.violations),
  );

  // Direction 2: writable root sits INSIDE a protected path.
  const { dir: dirB } = gitRepo(t, 'overlap-b');
  const taskB = baseTask(dirB, {
    allowedWriteRoots: [join(dirB, 'vendor')],
    protectedPaths: [dirB],
  });
  const receiptB = await verifyDispatch({
    ...baseContext,
    task: taskB,
    baseline: captureWorkspaceBaseline(taskB),
    workerOutcome: 'completed',
    commands: greenCommand(),
    now: Date.now(),
  });
  assert.equal(receiptB.verdict, 'rejected');
  assert.ok(
    receiptB.workspace.violations.some((violation) => violation.kind === 'protected_write_overlap'),
    JSON.stringify(receiptB.workspace.violations),
  );
});

test('R9A: missing-tail canonicalization appends the tail exactly once', (t) => {
  const { dir } = gitRepo(t, 'tail');
  // The canonical root is the REAL path of the workspace; a not-yet-existing
  // tail is appended lexically, exactly once.
  const canonical = canonicalizeWorkspacePath(dir, join(dir, 'deep', 'tail.txt'));
  assert.equal(canonical, join(realpathSync(dir), 'deep', 'tail.txt'));
  assert.ok(!canonical.includes('tail.txt/deep'), canonical);

  // Existing-path behavior is unchanged and escapes still throw.
  const existing = canonicalizeWorkspacePath(dir, join(dir, 'README.md'));
  assert.equal(existing, realpathSync(join(dir, 'README.md')));
  assert.throws(
    () => canonicalizeWorkspacePath(dir, '/etc/passwd'),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});

test('R9A: repository identity is re-proven against the baseline at verify time', async (t) => {
  const { dir } = gitRepo(t, 'reproven');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'ok.ts'), 'export {};\n');
  const task = baseTask(dir);
  const baseline = captureWorkspaceBaseline(task);
  assert.ok(baseline.repository?.startsWith('sha256:'));

  const receipt = await verifyDispatch({
    ...baseContext,
    task,
    baseline,
    workerOutcome: 'completed',
    commands: greenCommand(),
    now: Date.now(),
  });

  assert.equal(receipt.verdict, 'accepted');
  assert.equal(receipt.workspace.repositoryIdentityReproven, true);
  assert.ok(existsSync(dir));
});
