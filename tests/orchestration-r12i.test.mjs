import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const aggregate = await import('../scripts/lib/coverage-aggregate.mjs');
const ownedMod = await import('../src/orchestration/adapters/owned-process.mjs');

const TEST_BASE = mkdtempSync(join(tmpdir(), 'r12i-'));
after(() => {
  try { rmSync(TEST_BASE, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('R12I: V8 source URLs map via fileURLToPath (percent-encoded + platform-correct)', (t) => {
  const project = join(TEST_BASE, 'url-proj');
  const srcDir = join(project, 'src');
  mkdirSync(srcDir, { recursive: true });
  const fileWithSpace = join(srcDir, 'we ird name.mjs');
  writeFileSync(fileWithSpace, 'export const x = 1;\n');

  // A percent-encoded file URL the way V8 emits it.
  const url = `file://${encodeURI(fileWithSpace)}`.replace(/^file:\/\/\/([A-Za-z]:)/, 'file:///$1');
  const payloads = [{ result: [{ url, functions: [] }] }];

  const merged = aggregate.mergeV8Payloads(project, payloads, {
    existsSyncImpl: () => true,
  });
  assert.equal(merged.size, 1, 'the encoded URL must resolve to the real file');
  const entry = [...merged.values()][0];
  assert.equal(entry.filePath, realpathSync(fileWithSpace), `decoded path expected (${entry.filePath})`);
});

test('R12I: never-loaded production files are import-probed so funcs/branches include TRUE zeros', async () => {
  const project = join(TEST_BASE, 'probe-proj');
  mkdirSync(join(project, 'src'), { recursive: true });
  const neverLoaded = join(project, 'src', 'never-loaded.mjs');
  writeFileSync(neverLoaded, [
    'export function alpha() { return 1; }',
    'export function beta() { return 2; }',
    'export function gamma(x) { if (x) return x; return -x; }',
    '',
  ].join('\n'));
  const loadedFile = join(project, 'src', 'loaded.mjs');
  writeFileSync(loadedFile, 'export const ok = true;\n');

  // Simulate a suite payload that loaded ONLY loaded.mjs with full hits.
  const url = `file://${encodeURI(loadedFile)}`;
  const payloads = [{
    result: [{
      url,
      functions: [
        { functionName: '', ranges: [{ startOffset: 0, endOffset: 22, count: 1 }], isBlockCoverage: true },
      ],
    }],
  }];

  const universe = aggregate.enumerateProductionSources(project);
  const mergedScripts = aggregate.mergeV8Payloads(project, payloads);

  const probed = aggregate.probeUnloadedSources({
    rootPath: project,
    universe,
    mergedScripts,
    workDir: join(TEST_BASE, 'probe-work'),
  });

  // The probe child imported never-loaded.mjs under coverage: its functions
  // must now appear with ZERO counts in the merged universe.
  const remerged = aggregate.mergeV8Payloads(project, [
    ...payloads,
    ...probed.extraPayloads,
  ]);
  const realNever = realpathSync(neverLoaded);
  const entry = [...remerged.values()].find((script) => script.filePath === realNever);
  assert.ok(entry, 'the probed module must now be part of the merged coverage');
  const namedFns = entry.functions.filter((fn) => fn.functionName && fn.functionName !== '');
  assert.equal(namedFns.length >= 3, true, `alpha/beta/gamma structures expected (${namedFns.map((f) => f.functionName)})`);
  for (const fn of namedFns) {
    for (const range of fn.ranges ?? []) {
      assert.equal(range.count, 0, 'probed-but-unexecuted ranges MUST count zero');
    }
  }

  const aggregated = aggregate.aggregateCoverage({
    rootPath: project,
    universe,
    mergedScripts: remerged,
  });
  assert.equal(aggregated.overall.functions < 100, true,
    `unloaded functions must drag the ratio (${aggregated.overall.functions})`);
});

/* ---------------- Windows settlement honesty -------------------------- */

function stubChild({ live = true } = {}) {
  const child = {
    exitCode: live ? null : 0,
    signalCode: null,
    once(event, fn) {
      if (live && event === 'exit') {
        // Survives every signal until SIGKILL, then exits.
        const origKill = child.kill;
        child.kill = (signal) => {
          origKill(signal);
          if (signal === 'SIGKILL') {
            child.exitCode = 0;
            fn();
          }
        };
      }
    },
    kill() { /* replaced when live */ },
  };
  return child;
}

test('R12I: on win32 a LIVE child is never skipped as no-op — pid ladder runs to proof', async (t) => {
  const stateDir = join(TEST_BASE, 'win-live');
  mkdirSync(stateDir, { recursive: true });
  const adapter = ownedMod.createOwnedProcessAdapter({
    stateDir,
    platformForTest: 'win32',
    signalGraceMs: 40,
  });
  const child = stubChild({ live: true });
  const receipt = await adapter.close({
    binding: { __child: child, processIdentity: { processGroupId: 4242 } },
  });
  assert.notEqual(receipt.disposition, 'no-op',
    'a platform check alone must NEVER yield no-op while the child is live');
  assert.equal(receipt.disposition, 'group-stopped');
  assert.equal(receipt.exitProven, true);
  assert.deepEqual(receipt.signalsAttempted, ['SIGTERM', 'SIGKILL']);
});

test('R12I: on win32 no-op is allowed ONLY with proven absence', async (t) => {
  const stateDir = join(TEST_BASE, 'win-dead');
  mkdirSync(stateDir, { recursive: true });
  const adapter = ownedMod.createOwnedProcessAdapter({
    stateDir,
    platformForTest: 'win32',
  });
  const receipt = await adapter.close({
    binding: { __child: stubChild({ live: false }), processIdentity: { processGroupId: 4243 } },
  });
  assert.equal(receipt.disposition, 'no-op');
});
