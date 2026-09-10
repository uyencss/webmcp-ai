#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateCoverage,
  enumerateProductionSources,
  evaluateThresholds,
  mergeV8Payloads,
  probeUnloadedSources,
} from "./lib/coverage-aggregate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THRESHOLDS = Object.freeze({ lines: 80, functions: 80, branches: 80 });

export function listTestFiles(rootDir = ROOT) {
  const testsRoot = join(rootDir, "tests");
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const path = join(dir, name);
      let stats = null;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) walk(path);
      else if (name.endsWith(".test.mjs")) out.push(path);
    }
  };
  walk(testsRoot);
  return out.sort();
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
    else if (name.endsWith(".json")) sink.push(path);
  }
  return sink;
}

function main() {
  const testFiles = listTestFiles();
  if (testFiles.length === 0) {
    console.error("coverage verifier: no test files found");
    process.exit(1);
  }

  const isTestOnly = process.argv.includes("--test-only");
  if (isTestOnly) {
    const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--test-only");
    const flags = rawArgs.filter((arg) => arg.startsWith("-"));
    const explicitFiles = rawArgs.filter((arg) => !arg.startsWith("-"));
    const targets = explicitFiles.length > 0 ? explicitFiles : testFiles;
    const run = spawnSync(process.execPath, ["--test", ...flags, ...targets], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
    if (run.error) {
      console.error(`test runner: failed to spawn the test runner: ${run.error.message}`);
      process.exit(1);
    }
    if (run.status !== 0) {
      process.exit(run.status ?? 1);
    }
    return;
  }

  const coverageDir = join(tmpdir(), `webmcp-ai-cov-${process.pid}-${Date.now().toString(36)}`);
  rmSync(coverageDir, { recursive: true, force: true });
  mkdirSync(coverageDir, { recursive: true });
  process.on("exit", () => {
    try { rmSync(coverageDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  console.log(`coverage: running ${testFiles.length} test files under NODE_V8_COVERAGE ...`);
  const run = spawnSync(process.execPath, ["--test", ...testFiles], {
    cwd: ROOT,
    stdio: "inherit",
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
      payloads.push(JSON.parse(readFileSync(coverageFile, "utf8")));
    } catch {
      continue;
    }
  }

  const universe = enumerateProductionSources(ROOT);
  const firstPass = mergeV8Payloads(ROOT, payloads);
  const probed = probeUnloadedSources({ rootPath: ROOT, universe, mergedScripts: firstPass, workDir: coverageDir });
  if (probed.extraPayloads.length > 0) payloads.push(...probed.extraPayloads);
  const mergedScripts = mergeV8Payloads(ROOT, payloads);
  const { rows, overall } = aggregateCoverage({ rootPath: ROOT, universe, mergedScripts });

  const loadedCount = rows.filter((row) => row.loaded).length;
  const neverLoaded = rows.filter((row) => !row.loaded);

  console.log(`\ncoverage: per-file production summary (${loadedCount}/${rows.length} files loaded by the suite)`);
  for (const row of rows) {
    if (!row.loaded) {
      console.log(`  ${row.file.padEnd(52)} UNPROBED (${row.lines[1]} lines count as uncovered; funcs/branches unknown — never fabricated)`);
      continue;
    }
    console.log(
      `  ${row.file.padEnd(52)}`
      + ` lines ${row.linesPct.toFixed(1).padStart(6)}%`
      + `  funcs ${(row.funcsPct ?? 0).toFixed(1).padStart(6)}%`
      + `  branches ${(row.branchesPct ?? 0).toFixed(1).padStart(6)}%`
      + (row.uncoveredLines.length > 0 ? `  [uncovered: ${row.uncoveredLines.join(",")}]` : "")
    );
  }
  if (neverLoaded.length > 0) {
    console.log(`coverage: ${neverLoaded.length} production file(s) were never loaded and drag the ratios down`);
  }

  const failures = evaluateThresholds(overall, THRESHOLDS);
  for (const metric of ["lines", "functions", "branches"]) {
    const value = overall[metric];
    const ok = value >= THRESHOLDS[metric];
    console.log(`coverage: ${metric.padEnd(9)} ${value.toFixed(2).padStart(6)}% (threshold ${THRESHOLDS[metric]}%) ${ok ? "OK" : "FAIL"}`);
  }
  if (rows.length === 0 || universe.length === 0) {
    console.error("coverage verifier: no production coverage data was produced");
    process.exit(1);
  }
  if (failures.length > 0) {
    console.error(`coverage verifier: thresholds missed for: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("coverage verifier: all thresholds satisfied over the full source universe");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
