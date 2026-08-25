import assert from 'node:assert/strict';
import { mkdirSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRefsQuota, reserveRefsBytes } from '../src/orchestration/refs-quota.mjs';
import { writeAtomicJson } from '../src/orchestration/atomic-file.mjs';
import { ORCHESTRATION_ERROR_CODES, ORCHESTRATION_LIMITS } from '../src/orchestration/constants.mjs';

// ---- unit harness -----------------------------------------------------------

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `r11e-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const refsBytes = (dir) => {
  let total = 0;
  try {
    for (const name of readdirSync(dir)) total += 1; // presence count only
  } catch { /* absent */ }
  return total;
};

test('R11E-U: quota primitive arithmetic, typed overflow and disk rebuild', (t) => {
  const refsDir = join(tempDir(t, 'unit'), 'refs');
  mkdirSync(refsDir, { recursive: true });
  const quota = createRefsQuota({ refsDir, limitBytes: 1000 });

  assert.equal(quota.durableBytes(), 0);
  const token = quota.reserve(400);
  assert.equal(quota.totalBytes(), 400);
  writeFileSync(join(refsDir, 'a.txt'), 'x'.repeat(400));
  const actual = quota.commit(token, { writtenPath: join(refsDir, 'a.txt') });
  assert.equal(actual, 400);
  assert.equal(quota.pendingBytes, 0);

  // Overflow is typed with full details.
  assert.throws(
    () => quota.reserve(601),
    (error) => error.code === 'REFS_LIMIT_REACHED'
      && error.details?.durableBytes === 400
      && error.details?.limitBytes === 1000,
  );

  // Disk-derived rebuild: externally added bytes reduce headroom instantly.
  writeFileSync(join(refsDir, 'external.bin'), Buffer.alloc(300));
  quota.rebuildFromDisk();
  assert.throws(() => quota.reserve(701), (error) => error.code === 'REFS_LIMIT_REACHED');
  // Freeing disk space restores headroom without any in-memory residue.
  rmSync(join(refsDir, 'external.bin'));
  assert.equal(quota.reserve(600).reservedBytes, 600);

  // The code is part of the public taxonomy.
  assert.equal(ORCHESTRATION_ERROR_CODES.has('REFS_LIMIT_REACHED'), true);
});

test('R11E-U: one-shot reservation guards the exact boundary', (t) => {
  const refsDir = join(tempDir(t, 'oneshot'), 'refs');
  mkdirSync(refsDir, { recursive: true });
  const limit = ORCHESTRATION_LIMITS.maxRefsTotalBytes;
  assert.equal(typeof limit, 'number');
  // Empty dir admits anything up to the real coordination-total bound.
  assert.equal(reserveRefsBytes(refsDir, limit).reservedBytes, limit);
});

test('R11E-1: large Delivery spill respects the shared quota and never overwrites', async (t) => {
  const stateDir = tempDir(t, 'store-spill');
  const { MANIFEST_SCHEMA } = await import('../src/orchestration/constants.mjs');
  const rootsMod = await import('../src/orchestration/paths.mjs');
  const { ensureOrchestrationRoots, resolveOrchestrationRoots } = rootsMod;
  const { createCoordinationLayout } = rootsMod;
  const { createAuthority } = await import('../src/orchestration/authority.mjs');
  const { openCoordinationStore, commitDelivery } = await import('../src/orchestration/store.mjs');
  void MANIFEST_SCHEMA;

  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  ensureOrchestrationRoots(roots);
  const layout = createCoordinationLayout(roots.stateRoot, 'coord_r11e_store');
  writeAtomicJson(layout.manifestPath, {
    schema: MANIFEST_SCHEMA,
    coordinationId: 'coord_r11e_store',
    fenceEpoch: 1,
    processGeneration: 1,
    createdAt: new Date().toISOString(),
    owner: null,
  });
  createAuthority(layout);

  // Pre-seed the SHARED refs directory to the exact boundary with a sparse
  // file (statSync honors sparseness): only ~1 KiB of true headroom remains.
  mkdirSync(layout.refsDir, { recursive: true });
  const seedPath = join(layout.refsDir, 'seed.sparse');
  writeFileSync(seedPath, '');
  truncateSync(seedPath, ORCHESTRATION_LIMITS.maxRefsTotalBytes - 1024);

  const store = openCoordinationStore(layout);
  const bigPayload = { summary: 'x'.repeat(300 * 1024) };
  assert.throws(
    () => commitDelivery(store, { type: 'progress', payload: bigPayload }),
    (error) => error.code === 'REFS_LIMIT_REACHED',
    'store spill must fail typed when the coordination refs bound is reached',
  );
  // No ref file was created and the journal did not advance.
  assert.equal(refsBytes(layout.refsDir), 1, 'only the sparse seed may exist');
  assert.equal(store.state.lastSequence, 0);

  // Freeing space lets the identical spill succeed exactly once.
  rmSync(seedPath);
  const committed = commitDelivery(store, { type: 'progress', payload: bigPayload });
  assert.ok(committed.delivery.payload.ref, 'spill lands as a bounded ref after headroom returns');
  const refName = committed.delivery.payload.ref.split('/').at(-1);
  const refPath = join(layout.refsDir, refName);
  const originalBytes = readFileSync(refPath);

  // NO-OVERWRITE: an exclusive create against the SAME durable evidence path
  // is refused and leaves the original bytes untouched.
  const { createAtomicExclusiveFile } = await import('../src/orchestration/atomic-file.mjs');
  assert.throws(
    () => createAtomicExclusiveFile(refPath, 'tampered-content'),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
    'existing durable evidence must never be silently overwritten',
  );
  assert.equal(readFileSync(refPath).equals(originalBytes), true);
});

test('R11E-3: acceptance-command spill respects the shared quota', async (t) => {
  const stateDir = tempDir(t, 'accept-spill');
  const { execFileSync } = await import('node:child_process');
  const workspace = join(stateDir, 'ws');
  mkdirSync(workspace, { recursive: true });
  execFileSync('git', ['-C', workspace, 'init', '-q']);
  execFileSync('git', ['-C', workspace, 'config', 'user.email', 't@local']);
  execFileSync('git', ['-C', workspace, 'config', 'user.name', 't']);
  writeFileSync(join(workspace, 'README.md'), '# seed\n');
  execFileSync('git', ['-C', workspace, 'add', '-A']);
  execFileSync('git', ['-C', workspace, 'commit', '-qm', 'seed']);

  const { captureWorkspaceBaseline } = await import('../src/orchestration/verifier.mjs');
  const task = {
    taskId: 'task_e3',
    objective: 'acceptance spill quota',
    workspace,
    allowedReadRoots: [workspace],
    allowedWriteRoots: [join(workspace, 'src')],
    protectedPaths: [join(workspace, 'README.md')],
    dependencies: [],
    acceptanceCommands: [],
    commandPolicy: { allowedExecutables: [process.execPath] },
    delegationDepth: 1,
    initialRevision: null,
  };
  const baseline = captureWorkspaceBaseline(task);

  // Seed the SHARED refs directory to the exact coordination-total bound.
  const refsDir = join(stateDir, 'refs');
  mkdirSync(refsDir, { recursive: true });
  const seedPath = join(refsDir, 'seed.sparse');
  writeFileSync(seedPath, '');
  truncateSync(seedPath, ORCHESTRATION_LIMITS.maxRefsTotalBytes);

  const { verifyDispatch } = await import('../src/orchestration/verifier.mjs');
  const bigOutput = `console.log('${'x'.repeat(300 * 1024)}')`;
  const receipt = await verifyDispatch({
    coordinationId: 'coord_e3',
    taskId: 'task_e3',
    dispatchId: 'disp_e3',
    fenceEpoch: 1,
    task,
    baseline,
    workerOutcome: 'completed',
    commands: [[process.execPath, '-e', bigOutput]],
    stateDir,
    now: Date.now(),
  });

  assert.equal(receipt.tests.length, 1);
  assert.equal(receipt.tests[0].outputRef, null,
    'acceptance spill must be dropped when the shared quota is exhausted');
  assert.equal(receipt.tests[0].outputRefOverflowReason, 'refs-quota',
    'the overflow must be typed in the receipt');
  assert.equal(refsBytes(refsDir), 1, 'no new ref file may appear');
});

test('R11E-6: total durable bytes NEVER exceed maxRefsTotalBytes at the 64 MiB boundary', async (t) => {
  const refsDir = join(tempDir(t, 'probe64'), 'refs');
  mkdirSync(refsDir, { recursive: true });
  const limit = ORCHESTRATION_LIMITS.maxRefsTotalBytes;

  const seed = join(refsDir, 'boundary.sparse');
  writeFileSync(seed, '');
  truncateSync(seed, limit - 4096);

  // Multiple writers of different kinds race for the last 4 KiB.
  let admitted = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      reserveRefsBytes(refsDir, 2048, { writerId: `probe:${attempt}` });
      writeFileSync(join(refsDir, `w${attempt}.bin`), Buffer.alloc(2048, 7));
      admitted += 1;
    } catch (error) {
      assert.equal(error.code, 'REFS_LIMIT_REACHED');
    }
  }
  let total = 0;
  for (const name of readdirSync(refsDir)) {
    total += statSync(join(refsDir, name)).size;
  }
  assert.equal(total <= limit, true, `total ${total} must never exceed ${limit}`);
  assert.equal(admitted >= 1, true, 'the first writer fits inside the boundary band');

  rmSync(seed);
  reserveRefsBytes(refsDir, limit - total);
  const after = [...readdirSync(refsDir)].reduce(
    (sum, name) => sum + statSync(join(refsDir, name)).size, 0,
  );
  assert.equal(after + (limit - total) <= limit, true);
});
