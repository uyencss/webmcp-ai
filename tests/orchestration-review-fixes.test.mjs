import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  releaseRecoveredRuntimeDatabase,
  resolveOpencodeDataRoot,
} from '../src/orchestration/adapters/opencode-server.mjs';
import { classifyRecoveredStop, SETTLEMENT_PROOF } from '../src/orchestration/settlement.mjs';

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

function tempHome(t, name) {
  const home = mkdtempSync(join(tmpdir(), `r11fix-${name}-`));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('R11FIX-D1: production geometry — lease INSIDE the user data-root runtime subtree is released; sibling default DB untouched', async (t) => {
  const home = tempHome(t, 'geom');
  const dataRoot = resolveOpencodeDataRoot({ homeDir: home });
  const dbDir = join(dataRoot, 'webmcp-ai-runtime', 'worker_geom');
  const dbPath = join(dbDir, 'opencode.db');
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(dbPath, 'runtime-owned-db');
  writeFileSync(join(dbDir, 'opencode.db-wal'), 'wal');

  // The USER default database sits in the SAME data root and must survive.
  const defaultDbDir = join(dataRoot, 'user-default');
  const defaultDbPath = join(defaultDbDir, 'opencode.db');
  mkdirSync(defaultDbDir, { recursive: true });
  writeFileSync(defaultDbPath, 'USER DEFAULT');

  // A dead pid stands in for the provably-exited server process.
  const record = {
    capability: 'opencode-server',
    cleanupLease: {
      ownershipMode: 'runtime-owned',
      canonicalRuntimeDbPath: dbPath,
      canonicalRuntimeDbDir: dbDir,
      databaseIdentity: sha256Hex(dbPath),
      processIdentity: { pid: 999_999_555, startIdentity: 'fixture:dead', processGroupId: 999_999_555 },
    },
  };

  const outcome = await releaseRecoveredRuntimeDatabase(record, { homeDir: home });

  assert.equal(outcome.released, true, `expected release, got ${JSON.stringify(outcome)}`);
  assert.equal(existsSync(dbDir), false);
  assert.equal(readFileSync(defaultDbPath, 'utf8'), 'USER DEFAULT',
    'the user default DB inside the same data root must be untouched');
});

test('R11FIX-D1b: a forged lease at the bare data root is still denied (denylist intact)', async (t) => {
  const home = tempHome(t, 'deny');
  const dataRoot = resolveOpencodeDataRoot({ homeDir: home });
  const forgedPath = join(dataRoot, 'opencode.db');
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(forgedPath, 'USER DEFAULT');

  const record = {
    capability: 'opencode-server',
    cleanupLease: {
      ownershipMode: 'runtime-owned',
      canonicalRuntimeDbPath: forgedPath,
      canonicalRuntimeDbDir: dataRoot,
      databaseIdentity: sha256Hex(forgedPath),
      processIdentity: { pid: 999_999_556, startIdentity: 'fixture:dead-2', processGroupId: 999_999_556 },
    },
  };

  await assert.rejects(
    () => releaseRecoveredRuntimeDatabase(record, { homeDir: home }),
    (error) => error.code === 'POLICY_DENIED',
  );
  assert.equal(readFileSync(forgedPath, 'utf8'), 'USER DEFAULT');
});

test('R11FIX-D2: a recycled-pid original-exited orphan classifies as proven-absent and settles', () => {
  const settlement = classifyRecoveredStop({
    attempted: false,
    disposition: 'pid-recycled-original-exited',
  });
  assert.equal(settlement.proof, SETTLEMENT_PROOF.PROVEN_ABSENT,
    'a mismatching identity probe proves the ORIGINAL exited even before signalling');

  const unavailable = classifyRecoveredStop({
    attempted: false,
    disposition: 'pid-recycled-identity-unavailable',
  });
  assert.equal(unavailable.proof, SETTLEMENT_PROOF.PENDING_RETRY,
    'an unavailable probe must park as pending-retry, never failed-closed forever');
});
