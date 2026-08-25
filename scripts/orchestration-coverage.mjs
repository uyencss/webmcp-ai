#!/usr/bin/env node
// Node 18-compatible coverage gate for the packaged runtime.
//
// The built-in threshold flags (--test-coverage-lines=80 ...) only exist on
// newer Node lines, and `--test-force-exit` masks leaked handles. This script
// replaces BOTH with a portable, zero-dependency verifier:
//
//   1. run the full suite once under NODE_V8_COVERAGE (no force-exit, so any
//      leaked server/child/timeout keeps the runner alive and fails loudly);
//   2. aggregate V8 coverage for the ENTIRE production source universe
//      (src/**/*.mjs + bin/*.mjs) into honest line / function / branch
//      ratios — never-loaded files count at zero, nested zero-count ranges
//      demote their lines (untaken branches reduce the lines ratio);
//   3. enforce the 80/80/80 thresholds — ANY miss exits nonzero.
//
// All metric math lives in scripts/lib/coverage-aggregate.mjs so focused
// fixture/mutation tests can pin the semantics. No dev or runtime dependency
// is added to the package artifact.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aggregateCoverage,
  enumerateProductionSources,
  evaluateThresholds,
  mergeV8Payloads,
} from './lib/coverage-aggregate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THRESHOLDS = Object.freeze({ lines: 80, functions: 80, branches: 80 });

function listTestFiles() {
  return readdirSync(join(ROOT, 'tests'))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => join(ROOT, 'tests', name))
    .sort();
}

function collectCoverageFiles(dir, sink = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let stats = null;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) collectCoverageFiles(path, sink);
    else if (name.endsWith('.json')) sink.push(path);
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

  const payloads = [];
  for (const coverageFile of collectCoverageFiles(coverageDir)) {
    try {
      payloads.push(JSON.parse(readFileSync(coverageFile, 'utf8')));
    } catch {
      continue;
    }
  }

  const universe = enumerateProductionSources(ROOT);
  const mergedScripts = mergeV8Payloads(ROOT, payloads);
  const { rows, overall } = aggregateCoverage({ rootPath: ROOT, universe, mergedScripts });

  const loadedCount = rows.filter((row) => row.loaded).length;
  const neverLoaded = rows.filter((row) => !row.loaded);

  console.log('\ncoverage: per-file production summary '
    + `(${loadedCount}/${rows.length} files loaded by the suite)`);
  for (const row of rows) {
    if (!row.loaded) {
      console.log(`  ${row.file.padEnd(52)} NEVER LOADED (${row.lines[1]} lines count as uncovered)`);
      continue;
    }
    console.log(
      `  ${row.file.padEnd(52)}`
      + ` lines ${row.linesPct.toFixed(1).padStart(6)}%`
      + `  funcs ${(row.funcsPct ?? 100).toFixed(1).padStart(6)}%`
      + `  branches ${(row.branchesPct ?? 100).toFixed(1).padStart(6)}%`
      + (row.uncoveredLines.length > 0 ? `  [uncovered: ${row.uncoveredLines.join(',')}]` : ''),
    );
  }
  if (neverLoaded.length > 0) {
    console.log(`coverage: ${neverLoaded.length} production file(s) were never loaded and drag the ratios down`);
  }

  const failures = evaluateThresholds(overall, THRESHOLDS);
  for (const metric of ['lines', 'functions', 'branches']) {
    const value = overall[metric];
    const ok = value >= THRESHOLDS[metric];
    console.log(`coverage: ${metric.padEnd(9)} ${value.toFixed(2).padStart(6)}% (threshold ${THRESHOLDS[metric]}%) ${ok ? 'OK' : 'FAIL'}`);
  }
  if (rows.length === 0 || universe.length === 0) {
    console.error('coverage verifier: no production coverage data was produced');
    process.exit(1);
  }
  if (failures.length > 0) {
    console.error(`coverage verifier: thresholds missed for: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('coverage verifier: all thresholds satisfied over the full source universe');
}

main();
