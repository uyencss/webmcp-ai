import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';

import { writeAtomicJson } from '../src/orchestration/atomic-file.mjs';
import {
  appendDeliveryLine,
  recoverJournal,
  replayJournal,
} from '../src/orchestration/journal.mjs';
import {
  createCoordinationLayout,
  ensureOrchestrationRoots,
  resolveOrchestrationRoots,
} from '../src/orchestration/paths.mjs';
import {
  commitDelivery,
  openCoordinationStore,
  persistAck,
} from '../src/orchestration/store.mjs';

function tempRoot(t, name = 'root') {
  const dir = join(tmpdir(), `webmcp-ai-jrn-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('state roots are outside repositories and platform-specific', () => {
  assert.equal(
    resolveOrchestrationRoots({
      env: {}, platform: 'darwin', homeDir: '/Users/tester',
    }).stateRoot,
    '/Users/tester/Library/Application Support/webmcp-ai/orchestration',
  );
  assert.equal(
    resolveOrchestrationRoots({
      env: { XDG_STATE_HOME: '/state' }, platform: 'linux', homeDir: '/home/tester',
    }).stateRoot,
    '/state/webmcp-ai/orchestration',
  );
  assert.equal(
    resolveOrchestrationRoots({
      env: {}, platform: 'linux', homeDir: '/home/tester',
    }).stateRoot,
    '/home/tester/.local/state/webmcp-ai/orchestration',
  );
  assert.equal(
    resolveOrchestrationRoots({
      env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: '/override/root' }, platform: 'darwin', homeDir: '/Users/tester',
    }).stateRoot,
    '/override/root',
  );
  assert.throws(
    () => resolveOrchestrationRoots({ env: {}, platform: 'sunos', homeDir: '/u' }),
    (error) => error.code === 'ORCHESTRATION_UNSUPPORTED_VERSION',
  );
});

test('coordination layouts are private, absolute and symlink-rejected', (t) => {
  const override = tempRoot(t, 'override');
  const roots = resolveOrchestrationRoots({
    env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: override }, platform: 'darwin', homeDir: '/Users/tester',
  });
  ensureOrchestrationRoots(roots);
  assert.equal(statSync(roots.stateRoot).mode & 0o777, 0o700);

  const layout = createCoordinationLayout(roots.stateRoot, 'coord_test');
  assert.equal(existsSync(layout.coordinationDir), true);
  assert.equal(statSync(layout.coordinationDir).mode & 0o777, 0o700);
  assert.equal(statSync(layout.refsDir).mode & 0o777, 0o700);
  for (const value of Object.values(layout)) {
    if (typeof value !== 'string') continue;
    assert.equal(value.startsWith(sep), true, `layout path must be absolute: ${value}`);
  }

  // A symlinked coordination directory is rejected before any write.
  const outside = tempRoot(t, 'outside');
  mkdirSync(outside, { recursive: true });
  const symlinkDir = join(roots.stateRoot, 'coordinations', 'coord_symlink');
  symlinkSync(outside, symlinkDir, 'dir');
  assert.throws(
    () => createCoordinationLayout(roots.stateRoot, 'coord_symlink'),
    (error) => error.code === 'POLICY_DENIED',
  );
});

test('writeAtomicJson persists mode-0600 files with a trailing newline', (t) => {
  const dir = tempRoot(t, 'atomic');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'snapshot.json');
  writeAtomicJson(target, { hello: 'world' });
  const stats = statSync(target);
  assert.equal(stats.mode & 0o777, 0o600);
  assert.equal(readFileSync(target, 'utf8'), '{"hello":"world"}\n');
  // Overwrites remain atomic and mode-stable.
  writeAtomicJson(target, { hello: 'again' });
  assert.equal(readFileSync(target, 'utf8'), '{"hello":"again"}\n');
  assert.equal(statSync(target).mode & 0o777, 0o600);
});

test('replay accepts valid JSONL and reports corruption deterministically', (t) => {
  const dir = tempRoot(t, 'replay');
  const layout = {
    coordinationDir: dir,
    journalPath: join(dir, 'events.jsonl'),
    refsDir: join(dir, 'refs'),
  };
  mkdirSync(dir, { recursive: true });

  const lines = [
    { schema: 'webmcp.ai-orchestration-delivery/v0', deliveryId: 'del_1', sequence: 1, type: 'heartbeat', payload: {} },
    { schema: 'webmcp.ai-orchestration-delivery/v0', deliveryId: 'del_2', sequence: 2, type: 'heartbeat', payload: {} },
    { schema: 'webmcp.ai-orchestration-delivery/v0', deliveryId: 'del_3', sequence: 3, type: 'heartbeat', payload: {} },
  ].map((entry) => JSON.stringify(entry)).join('\n');
  writeFileSync(layout.journalPath, `${lines}\n`, 'utf8');

  let replay = replayJournal(layout);
  assert.equal(replay.deliveries.length, 3);
  assert.equal(replay.lastSequence, 3);

  // Duplicate deliveryId at a new sequence is corruption.
  writeFileSync(layout.journalPath, `${lines}\n${JSON.stringify({ deliveryId: 'del_2', sequence: 4 })}\n`, 'utf8');
  assert.throws(() => replayJournal(layout), (error) => error.code === 'JOURNAL_CORRUPT');

  // Invalid JSON in the middle is corruption without truncation.
  const brokenMiddle = [
    JSON.stringify(lines ? JSON.parse(lines.split('\n')[0]) : {}),
    '{not json',
    lines.split('\n')[2],
  ].join('\n');
  writeFileSync(layout.journalPath, `${brokenMiddle}\n`, 'utf8');
  assert.throws(() => replayJournal(layout), (error) => error.code === 'JOURNAL_CORRUPT');
  assert.match(readFileSync(layout.journalPath, 'utf8'), /\{not json/, 'no silent truncation');

  // A partial final fragment without a newline is truncated during recovery.
  const fragment = '{"deliveryId":"del_frag"';
  const goodPrefix = `${lines}\n${fragment}`;
  writeFileSync(layout.journalPath, goodPrefix, 'utf8');
  const recovered = recoverJournal(layout);
  assert.equal(recovered.truncatedFragmentBytes, Buffer.byteLength(fragment, 'utf8'));
  assert.equal(recovered.lastSequence, 3);
  assert.doesNotMatch(readFileSync(layout.journalPath, 'utf8'), /del_frag/);
});

test('snapshot disagreement never overwrites journal truth', (t) => {
  const dir = tempRoot(t, 'snapdis');
  const layout = {
    coordinationDir: dir,
    journalPath: join(dir, 'events.jsonl'),
    snapshotPath: join(dir, 'snapshot.json'),
    manifestPath: join(dir, 'manifest.json'),
    refsDir: join(dir, 'refs'),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(layout.manifestPath, `${JSON.stringify({
    schema: 'webmcp.ai-orchestration-manifest/v0',
    coordinationId: 'coord_test',
    fenceEpoch: 1,
    processGeneration: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
  })}\n`, 'utf8');

  const lines = [1, 2, 3].map((sequence) => JSON.stringify({
    schema: 'webmcp.ai-orchestration-delivery/v0',
    deliveryId: `del_${sequence}`,
    sequence,
    coordinationId: 'coord_test',
    type: 'heartbeat',
    time: '2026-08-22T00:00:01.000Z',
    payload: {},
  })).map((line) => `${line}\n`).join('');
  writeFileSync(layout.journalPath, lines, 'utf8');

  writeFileSync(layout.snapshotPath, `${JSON.stringify({
    schema: 'webmcp.ai-orchestration-snapshot/v0',
    coordinationId: 'coord_test',
    lastSequence: 8,
    acknowledgedThrough: 0,
    fenceEpoch: 1,
    processGeneration: 1,
    coordinationState: 'open',
    tasks: {},
    dispatches: {},
    workers: {},
    gates: {},
    escalations: [],
    interruptEffects: [],
    updatedAt: '2026-08-22T00:00:00.000Z',
  })}\n`, 'utf8');
  assert.throws(() => openCoordinationStore(layout), (error) => error.code === 'SNAPSHOT_CORRUPT');

  // A stale snapshot behind the journal replays record 3 and rewrites itself.
  const staleSnapshot = JSON.parse(readFileSync(layout.snapshotPath, 'utf8'));
  staleSnapshot.lastSequence = 2;
  writeFileSync(layout.snapshotPath, `${JSON.stringify(staleSnapshot)}\n`, 'utf8');
  const store = openCoordinationStore(layout);
  assert.equal(store.state.lastSequence, 3);
  assert.equal(JSON.parse(readFileSync(layout.snapshotPath, 'utf8')).lastSequence, 3);
});

test('commitDelivery appends before expose, spills large payloads, and enforces limits', (t) => {
  const dir = tempRoot(t, 'commit');
  const layout = {
    coordinationDir: dir,
    journalPath: join(dir, 'events.jsonl'),
    snapshotPath: join(dir, 'snapshot.json'),
    manifestPath: join(dir, 'manifest.json'),
    refsDir: join(dir, 'refs'),
  };
  mkdirSync(layout.refsDir, { recursive: true });
  writeFileSync(layout.manifestPath, `${JSON.stringify({
    schema: 'webmcp.ai-orchestration-manifest/v0',
    coordinationId: 'coord_test',
    fenceEpoch: 1,
    processGeneration: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
  })}\n`, 'utf8');

  const store = openCoordinationStore(layout);
  const committed = commitDelivery(store, {
    type: 'task_created',
    taskId: 'task_test',
    payload: { taskId: 'task_test' },
    time: '2026-08-22T00:00:02.000Z',
  });
  assert.equal(committed.delivery.sequence, 1);
  assert.match(committed.delivery.deliveryId, /^del_/);
  assert.equal(store.state.tasks.task_test.state, 'created');
  assert.equal(JSON.parse(readFileSync(layout.snapshotPath, 'utf8')).lastSequence, 1);
  const journalText = readFileSync(layout.journalPath, 'utf8');
  assert.match(journalText, /task_created/, 'journal holds the appended line');

  // Inline payloads over 256 KiB become bounded sanitized refs.
  const bigPayload = { blob: 'x'.repeat(300 * 1024) };
  const spilled = commitDelivery(store, {
    type: 'progress',
    payload: bigPayload,
    time: '2026-08-22T00:00:03.000Z',
  });
  assert.match(spilled.delivery.payload.ref, /^refs\/ref_/);
  assert.equal(spilled.delivery.payload.bytes, Buffer.byteLength(JSON.stringify(bigPayload), 'utf8'));
  assert.equal(spilled.delivery.payload.mediaType, 'application/json');
  assert.match(spilled.delivery.payload.sha256, /^[0-9a-f]{64}$/);
  const refPath = join(layout.coordinationDir, spilled.delivery.payload.ref);
  assert.equal(statSync(refPath).mode & 0o777, 0o600);
  assert.ok(spilled.delivery.payload.expiresAt);

  // Payloads beyond the 32 MiB ref ceiling fail closed.
  assert.throws(
    () => commitDelivery(store, {
      type: 'progress',
      payload: { blob: 'y'.repeat(33 * 1024 * 1024) },
    }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );

  // A serialized record over 512 KiB is rejected before any journal write.
  assert.throws(
    () => commitDelivery(store, {
      type: 'heartbeat',
      taskId: `task_${'a'.repeat(600 * 1024)}`,
      payload: {},
    }),
    (error) => error.code === 'ORCHESTRATION_INVALID_INPUT',
  );
});

test('journal thresholds are enforced through an injected size source', (t) => {
  const dir = tempRoot(t, 'bounds');
  const layout = {
    coordinationDir: dir,
    journalPath: join(dir, 'events.jsonl'),
    snapshotPath: join(dir, 'snapshot.json'),
    manifestPath: join(dir, 'manifest.json'),
    refsDir: join(dir, 'refs'),
  };
  mkdirSync(layout.refsDir, { recursive: true });
  writeFileSync(layout.manifestPath, `${JSON.stringify({
    schema: 'webmcp.ai-orchestration-manifest/v0',
    coordinationId: 'coord_test',
    fenceEpoch: 1,
    processGeneration: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
  })}\n`, 'utf8');

  const injectedSizes = [];
  let store = openCoordinationStore(layout, {
    journalSizeBytes: () => injectedSizes.shift() ?? 0,
  });

  // Non-critical write at the backpressure threshold fails closed.
  injectedSizes.push(481 * 1024 * 1024);
  assert.throws(
    () => commitDelivery(store, { type: 'progress', payload: {} }),
    (error) => error.code === 'JOURNAL_BACKPRESSURE',
  );

  // Critical deliveries may use the reserved final band.
  injectedSizes.push(481 * 1024 * 1024);
  const critical = commitDelivery(store, {
    type: 'escalation',
    payload: { summary: 'critical path reserved' },
  });
  assert.equal(critical.delivery.type, 'escalation');

  // Crossing the hard threshold fails even for critical records.
  injectedSizes.push(513 * 1024 * 1024);
  assert.throws(
    () => commitDelivery(store, { type: 'escalation', payload: {} }),
    (error) => error.code === 'JOURNAL_LIMIT_REACHED',
  );
});

test('ack persistence is monotonic and touches only the snapshot', (t) => {
  const dir = tempRoot(t, 'ack');
  const layout = {
    coordinationDir: dir,
    journalPath: join(dir, 'events.jsonl'),
    snapshotPath: join(dir, 'snapshot.json'),
    manifestPath: join(dir, 'manifest.json'),
    refsDir: join(dir, 'refs'),
  };
  mkdirSync(layout.refsDir, { recursive: true });
  writeFileSync(layout.manifestPath, `${JSON.stringify({
    schema: 'webmcp.ai-orchestration-manifest/v0',
    coordinationId: 'coord_test',
    fenceEpoch: 1,
    processGeneration: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
  })}\n`, 'utf8');

  const store = openCoordinationStore(layout);
  commitDelivery(store, { type: 'heartbeat', payload: {}, time: 't1' });
  commitDelivery(store, { type: 'heartbeat', payload: {}, time: 't2' });
  persistAck(store, 2);
  assert.equal(store.state.acknowledgedThrough, 2);
  const before = statSync(layout.journalPath);
  persistAck(store, 2);
  assert.equal(store.state.acknowledgedThrough, 2);
  // A stale re-ack is an idempotent no-op; beyond-the-end still fails closed.
  persistAck(store, 1);
  assert.equal(store.state.acknowledgedThrough, 2, 'watermark never moves backwards');
  assert.throws(() => persistAck(store, 5), (error) => error.code === 'ORCHESTRATION_INVALID_INPUT');
  const after = statSync(layout.journalPath);
  assert.equal(after.size, before.size, 'ack never appends to the journal');
});
