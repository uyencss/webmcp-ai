import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateCoverage,
  buildLineTable,
  enumerateProductionSources,
  evaluateThresholds,
} from '../scripts/lib/coverage-aggregate.mjs';
import { readFileSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;

// ---- fixture helpers ---------------------------------------------------------

function fixtureSource(lines) {
  return `${lines.join('\n')}\n`;
}

/** Build a minimal block-coverage function table for `sourceText`. */
function fn(name, ranges) {
  return { functionName: name, isBlockCoverage: true, ranges };
}
const range = (startOffset, endOffset, count) => ({ startOffset, endOffset, count });

function mergedScriptFor(filePath, functions) {
  return new Map([[`file://${filePath}`, { filePath, functions }]]);
}

// ---- RED tests ---------------------------------------------------------------

test('R11F-1: a never-loaded production file lowers the overall lines ratio', () => {
  const full = fixtureSource([
    "export const a = 1;",
    "export const b = 2;",
    "export const c = a + b;",
    "",
  ]);
  const never = fixtureSource([
    "export function hidden() {",
    "  return 'never imported';",
    "}",
    "",
  ]);
  const universe = ['/pkg/src/full.mjs', '/pkg/src/never.mjs'];
  const readFile = (filePath) => (filePath.endsWith('full.mjs') ? full : never);
  const whole = range(0, full.length - 0, 5);
  const scripts = mergedScriptFor('/pkg/src/full.mjs', [fn('', [whole])]);

  const { rows, overall } = aggregateCoverage({ rootPath: '/pkg', universe, mergedScripts: scripts, readFile });

  assert.equal(rows.length, 2);
  const neverRow = rows.find((row) => row.file === 'src/never.mjs');
  assert.equal(neverRow.loaded, false, 'the untouched file must be reported as never loaded');
  assert.equal(neverRow.lines[0], 0);
  // R12I: blank/zero-length lines hold no code and sit OUT of both sides;
  // only the file's 3 code lines enter the denominator.
  assert.equal(neverRow.lines[1], 3, 'its code-line table counts in the denominator');
  // 3 code lines of full.mjs covered out of a 6-code-line universe.
  assert.ok(overall.lines < 100, `unloaded files must drag coverage down, got ${overall.lines}`);
});

test('R11F-2: a nested zero-count range marks its lines UNCOVERED despite an executed enclosing body', () => {
  const source = fixtureSource([
    'export function pick(x) {',
    "  if (x === 'yes') {",
    "    return 'taken';",
    '  }',
    "  return 'untaken';",
    '}',
    '',
  ]);
  const table = buildLineTable(source);
  // Whole body executed; the untaken branch (lines 4-5 region: "return
  // 'untaken';" line) is a nested ZERO-count range.
  const untakenStart = table[4].startOffset;
  const untakenEnd = table[4].endOffset;
  const functions = [fn('pick', [
    range(0, source.length, 3),
    range(untakenStart, untakenEnd, 0),
  ])];

  const { rows, overall } = aggregateCoverage({
    rootPath: '/pkg',
    universe: ['/pkg/src/pick.mjs'],
    mergedScripts: mergedScriptFor('/pkg/src/pick.mjs', functions),
    readFile: () => source,
  });

  assert.deepEqual(rows[0].uncoveredLines, [5],
    `exactly the untaken return line must be uncovered, got ${JSON.stringify(rows[0].uncoveredLines)}`);
  assert.ok(overall.lines < 100, 'an untaken branch must reduce the honest lines ratio');

  // MUTATION GUARD: the old verifier skipped zero-count ranges entirely and
  // reported these very lines as covered — pin that the demote pass exists.
  const legacyRows = (() => {
    // Simulate legacy behavior by removing pass-2 zero ranges.
    const legacyFunctions = [fn('pick', [range(0, source.length, 3)])];
    const legacy = aggregateCoverage({
      rootPath: '/pkg',
      universe: ['/pkg/src/pick.mjs'],
      mergedScripts: mergedScriptFor('/pkg/src/pick.mjs', legacyFunctions),
      readFile: () => source,
    });
    return legacy.rows[0];
  })();
  assert.notEqual(legacyRows.uncoveredLines.length, rows[0].uncoveredLines.length,
    'without the zero-demote pass the untaken line would be falsely claimed');
});

test('R11F-3: thresholds are enforced on the REAL metric — 99.9 fails, 80 passes honestly', () => {
  // A realistic aggregate well under 100%.
  const overall = { lines: 93.29, functions: 92.49, branches: 81.43 };
  assert.deepEqual(evaluateThresholds(overall, { lines: 80, functions: 80, branches: 80 }), []);
  const failures = evaluateThresholds(overall, { lines: 99.9, functions: 99.9, branches: 99.9 });
  assert.deepEqual(failures.sort(), ['branches', 'functions', 'lines'].sort(),
    'a 99.9 threshold must fail because the metric is real, not incidentally satisfied');
  // Lines alone at 99.9 fails even when funcs/branches would pass.
  const linesOnly = evaluateThresholds({ lines: 99.0, functions: 100, branches: 100 }, { lines: 99.9, functions: 99.9, branches: 99.9 });
  assert.deepEqual(linesOnly, ['lines']);
});

test('R11F-4: the CLI enumerates the real package universe including bin/', (t) => {
  const pkg = mkdtempSync(join(tmpdir(), 'r11f-univ-'));
  t.after(() => rmSync(pkg, { recursive: true, force: true }));
  mkdirSync(join(pkg, 'src', 'orchestration'), { recursive: true });
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'src', 'cli.mjs'), '');
  writeFileSync(join(pkg, 'src', 'orchestration', 'supervisor.mjs'), '');
  writeFileSync(join(pkg, 'bin', 'tool.mjs'), '');
  writeFileSync(join(pkg, 'src', 'notes.txt'), ''); // not .mjs → excluded

  const universe = enumerateProductionSources(pkg).map((path) => path.slice(pkg.length + 1));
  assert.deepEqual(universe.sort(), ['bin/tool.mjs', 'src/cli.mjs', 'src/orchestration/supervisor.mjs']);
});
