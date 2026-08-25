#!/usr/bin/env node
// Node 18-compatible coverage gate for the packaged runtime.
//
// The built-in threshold flags (--test-coverage-lines=80 ...) only exist on
// newer Node lines, and `--test-force-exit` masks leaked handles. This script
// replaces BOTH with a portable, zero-dependency verifier:
//
//   1. run the full suite once under NODE_V8_COVERAGE (no force-exit, so any
//      leaked server/child/timeout keeps the runner alive and fails loudly);
//   2. aggregate V8 coverage for the PRODUCTION sources (src/**/*.mjs,
//      bin/*.mjs) into line / function / branch ratios;
//   3. enforce the 80/80/80 thresholds — ANY miss exits nonzero.
//
// No dev or runtime dependency is added to the package artifact.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THRESHOLDS = Object.freeze({ lines: 80, functions: 80, branches: 80 });

function listTestFiles() {
  return readdirSync(join(ROOT, 'tests'))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => join(ROOT, 'tests', name))
    .sort();
}

function isProductionSource(filePath) {
  const rel = relative(ROOT, filePath);
  if (rel.startsWith('..')) return false;
  return (rel.startsWith(`src${sep}`) || rel.startsWith(`bin${sep}`)) && rel.endsWith('.mjs');
}

function collectCoverageFiles(dir, sink = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (statSync(path).isDirectory()) collectCoverageFiles(path, sink);
      else if (name.endsWith('.json')) sink.push(path);
    } catch {
      // A vanished temp file contributes nothing.
    }
  }
  return sink;
}

function main() {
  const testFiles = listTestFiles();
  if (testFiles.length === 0) {
    console.error('coverage verifier: no test files found');
    process.exit(1);
  }

  const coverageDir = join(tmpdir(), `webmcp-ai-cov-${process.pid}-${Date.now().toString(36)}`);
  rmSync(coverageDir, { recursive: true, force: true });
  mkdirSync(coverageDir, { recursive: true });
  process.on('exit', () => {
    try { rmSync(coverageDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  console.log(`coverage: running ${testFiles.length} test files under NODE_V8_COVERAGE ...`);
  const run = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
  });
  if (run.error) {
    console.error(`coverage verifier: failed to spawn the test runner: ${run.error.message}`);
    process.exit(1);
  }
  if (run.status !== 0) {
    console.error(`coverage verifier: test suite failed with exit code ${run.status}`);
    process.exit(run.status ?? 1);
  }

  /**
   * Cross-process aggregation with the SAME merge and metric definitions as
   * Node's built-in test-runner coverage report (lib/internal/test_runner/
   * coverage.js), so the calibrated 80/80/80 thresholds keep their meaning:
   * scripts merge by url; functions merge by (name, root offsets); ranges
   * merge by keeping covered ranges, summing exact matches and shrinking
   * uncovered regions to their intersections; then every range of a
   * block-coverage function is one branch, functions exclude the synthetic
   * root, and lines are covered when fully spanned by a counted range.
   */
  const mergedScripts = new Map();
  const doesRangeEqualOtherRange = (range, otherRange) => range.startOffset === otherRange.startOffset
    && range.endOffset === otherRange.endOffset;
  const doesRangeContainOtherRange = (range, otherRange) => range.startOffset <= otherRange.startOffset
    && range.endOffset >= otherRange.endOffset;

  function mergeCoverageRanges(oldRanges, newRanges) {
    const mergedRanges = new Set();
    for (const oldRange of oldRanges) {
      if (oldRange.count > 0) mergedRanges.add(oldRange);
    }
    for (const newRange of newRanges) {
      let exactMatch = false;
      for (const oldRange of oldRanges) {
        if (doesRangeEqualOtherRange(newRange, oldRange)) {
          oldRange.count += newRange.count;
          mergedRanges.add(oldRange);
          exactMatch = true;
          break;
        }
        if (oldRange.count === 0 && newRange.count === 0) {
          if (doesRangeContainOtherRange(oldRange, newRange)) {
            mergedRanges.add(newRange);
          } else if (doesRangeContainOtherRange(newRange, oldRange)) {
            mergedRanges.add(oldRange);
          }
        }
      }
      if (newRange.count > 0 && !exactMatch) mergedRanges.add(newRange);
    }
    return [...mergedRanges];
  }

  function mergeScriptInto(mergedFunctions, newFunctions) {
    for (const newFn of newFunctions) {
      let found = false;
      for (const oldFn of mergedFunctions) {
        if (newFn.functionName === oldFn.functionName
          && newFn.ranges?.[0]?.startOffset === oldFn.ranges?.[0]?.startOffset
          && newFn.ranges?.[0]?.endOffset === oldFn.ranges?.[0]?.endOffset) {
          found = true;
          if (newFn.isBlockCoverage === true) {
            if (oldFn.isBlockCoverage === true) {
              oldFn.ranges = mergeCoverageRanges(oldFn.ranges, newFn.ranges);
            } else {
              oldFn.isBlockCoverage = true;
              oldFn.ranges = newFn.ranges;
            }
          }
          break;
        }
      }
      if (!found) mergedFunctions.push(newFn);
    }
  }

  for (const coverageFile of collectCoverageFiles(coverageDir)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(coverageFile, 'utf8'));
    } catch {
      continue;
    }
    for (const script of parsed.result ?? []) {
      const url = typeof script.url === 'string' ? script.url : '';
      if (!url.startsWith('file://')) continue;
      let filePath;
      try {
        filePath = decodeURIComponent(new URL(url).pathname);
      } catch {
        continue;
      }
      if (!isProductionSource(filePath) || !existsSync(filePath)) continue;
      const existing = mergedScripts.get(url);
      if (!existing) {
        mergedScripts.set(url, { filePath, functions: [...(script.functions ?? [])] });
      } else {
        mergeScriptInto(existing.functions, script.functions ?? []);
      }
    }
  }

  // Line tables mirror CoverageLine: start/end offsets EXCLUDE the trailing
  // newline; zero-length lines start trivially covered, exactly like the
  // built-in report computes them.
  const lineTableCache = new Map();
  const lineTableFor = (filePath) => {
    let table = lineTableCache.get(filePath);
    if (!table) {
      const source = readFileSync(filePath, 'utf8');
      const rawLines = source.split(/(?<=\r?\n)/u);
      let offset = 0;
      table = rawLines.map((text) => {
        const newlineLength = /\r?\n$/u.exec(text)?.[0].length ?? 0;
        const startOffset = offset;
        const endOffset = startOffset + text.length - newlineLength;
        offset += text.length;
        return { startOffset, endOffset, count: startOffset === endOffset ? 1 : 0 };
      });
      lineTableCache.set(filePath, table);
    }
    return table;
  };

  let totals = { lines: [0, 0], functions: [0, 0], branches: [0, 0] };
  const rowsOut = [];
  for (const { filePath, functions } of [...mergedScripts.values()].sort((a, b) => a.filePath.localeCompare(b.filePath))) {
    const lineRows = lineTableFor(filePath);
    let branchesTotal = 0;
    let branchesHit = 0;
    let functionsTotal = 0;
    let functionsHit = 0;

    functions.forEach((func, fnIndex) => {
      const ranges = func.ranges ?? [];
      for (const range of ranges) {
        if (func.isBlockCoverage === true) {
          branchesTotal += 1;
          if ((range.count ?? 0) > 0) branchesHit += 1;
        }
        // mapRangeToLines: a line fully spanned by the range takes its count.
        if ((range.count ?? 0) <= 0) continue;
        let cursor = 0;
        while (cursor < lineRows.length && lineRows[cursor].endOffset < range.startOffset) cursor += 1;
        for (; cursor < lineRows.length && lineRows[cursor].startOffset < range.endOffset; cursor += 1) {
          const row = lineRows[cursor];
          if (range.startOffset <= row.startOffset && range.endOffset >= row.endOffset) {
            row.count = range.count;
          }
        }
      }
      if (fnIndex > 0 && ranges.length > 0) {
        functionsTotal += 1;
        if ((ranges[0].count ?? 0) !== 0) functionsHit += 1;
      }
    });

    const linesHit = lineRows.filter((row) => row.count > 0).length;
    const linesPct = lineRows.length === 0 ? 100 : (linesHit / lineRows.length) * 100;
    const funcsPct = functionsTotal === 0 ? 100 : (functionsHit / functionsTotal) * 100;
    const branchesPct = branchesTotal === 0 ? 100 : (branchesHit / branchesTotal) * 100;
    totals.lines[0] += linesHit; totals.lines[1] += lineRows.length;
    totals.functions[0] += functionsHit; totals.functions[1] += functionsTotal;
    totals.branches[0] += branchesHit; totals.branches[1] += branchesTotal;
    rowsOut.push({ file: relative(ROOT, filePath), linesPct, funcsPct, branchesPct });
  }

  const overall = {
    lines: totals.lines[1] === 0 ? 100 : (totals.lines[0] / totals.lines[1]) * 100,
    functions: totals.functions[1] === 0 ? 100 : (totals.functions[0] / totals.functions[1]) * 100,
    branches: totals.branches[1] === 0 ? 100 : (totals.branches[0] / totals.branches[1]) * 100,
  };

  console.log('\ncoverage: per-file production summary');
  for (const row of rowsOut) {
    console.log(
      `  ${row.file.padEnd(52)}`
      + ` lines ${row.linesPct.toFixed(1).padStart(6)}%`
      + `  funcs ${row.funcsPct.toFixed(1).padStart(6)}%`
      + `  branches ${row.branchesPct.toFixed(1).padStart(6)}%`,
    );
  }

  const failures = [];
  for (const metric of ['lines', 'functions', 'branches']) {
    const value = overall[metric];
    const ok = value >= THRESHOLDS[metric];
    console.log(`coverage: ${metric.padEnd(9)} ${value.toFixed(2).padStart(6)}% (threshold ${THRESHOLDS[metric]}%) ${ok ? 'OK' : 'FAIL'}`);
    if (!ok) failures.push(metric);
  }
  if (rowsOut.length === 0) {
    console.error('coverage verifier: no production coverage data was produced');
    process.exit(1);
  }
  if (failures.length > 0) {
    console.error(`coverage verifier: thresholds missed for: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('coverage verifier: all thresholds satisfied');
}

main();
