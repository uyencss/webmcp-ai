/**
 * Pure V8-coverage aggregation core for the portable coverage gate.
 *
 * Zero-dependency, Node >=18. The CLI (scripts/orchestration-coverage.mjs)
 * runs the suite under NODE_V8_COVERAGE and delegates ALL metric math to this
 * module so focused fixture/mutation tests can pin the exact semantics:
 *
 *   - The UNIVERSE is the full production source tree (every `.mjs` under
 *     `src/` and `bin/`). A file never loaded by the suite contributes its
 *     whole line table to the denominator at zero hits — untested production
 *     code can never be silently dropped from the sample.
 *   - Line mapping is innermost-range-wins: a line fully spanned by any
 *     range takes that range's count, and NESTED ZERO-COUNT ranges demote
 *     their fully-spanned lines back to uncovered even when an enclosing
 *     function body range claims them. This is what makes untaken branches
 *     honestly reduce the lines ratio.
 *   - Functions exclude the synthetic index-0 script root; branches count
 *     every range of every block-coverage function (built-in parity).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function isProductionSource(rootPath, filePath) {
  const rel = relative(rootPath, filePath);
  if (rel.startsWith('..')) return false;
  return (rel.startsWith(`src${sep}`) || rel.startsWith(`bin${sep}`)) && rel.endsWith('.mjs');
}

// Enumerate EVERY production source file under root (every .mjs in src/ and bin/).
export function enumerateProductionSources(rootPath) {
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
      else if (path.endsWith('.mjs') && isProductionSource(rootPath, path)) out.push(path);
    }
  };
  walk(join(resolve(rootPath), 'src'));
  walk(join(resolve(rootPath), 'bin'));
  return out.sort();
}

/** Line table with CoverageLine semantics: end offsets EXCLUDE newlines. */
export function buildLineTable(sourceText) {
  const rawLines = String(sourceText).split(/(?<=\r?\n)/u);
  let offset = 0;
  return rawLines.map((text) => {
    const newlineLength = /\r?\n$/u.exec(text)?.[0].length ?? 0;
    const startOffset = offset;
    const endOffset = startOffset + text.length - newlineLength;
    offset += text.length;
    // A zero-length line holds NO code: it is neither covered nor uncovered
    // and must stay out of both numerator and denominator (count 0 and the
    // aggregator filters empty rows out of the ratio math).
    return { startOffset, endOffset, count: 0 };
  });
}

export function doesRangeEqualOtherRange(range, otherRange) {
  return range.startOffset === otherRange.startOffset && range.endOffset === otherRange.endOffset;
}

export function doesRangeContainOtherRange(range, otherRange) {
  return range.startOffset <= otherRange.startOffset && range.endOffset >= otherRange.endOffset;
}

/** Node-parity cross-process range merge (keep covered, intersect uncovered). */
export function mergeCoverageRanges(oldRanges, newRanges) {
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

export function mergeScriptInto(mergedFunctions, newFunctions) {
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

/** Merge raw NODE_V8_COVERAGE JSON payloads into url-keyed merged scripts. */
export function mergeV8Payloads(rootPathRaw, payloads, { existsSyncImpl = existsSync } = {}) {
  // Compare everything against the REAL root spelling (/var vs /private/var).
  const rootPath = normalizeRealpathSafe(rootPathRaw);
  const mergedScripts = new Map();
  for (const parsed of payloads) {
    for (const script of parsed?.result ?? []) {
      const url = typeof script.url === 'string' ? script.url : '';
      if (!url.startsWith('file://')) continue;
      let filePath;
      try {
        // fileURLToPath (NOT .pathname): platform-correct decoding — on
        // Windows .pathname yields /%C:/... and percent-encoded segments
        // would never match the real files.
        filePath = fileURLToPath(url);
      } catch {
        continue;
      }
      // Normalize platform symlink spellings (/var vs /private/var) FIRST so
      // universe membership and later comparisons are stable regardless of
      // who reported the path.
      {
        let normalized = filePath;
        if (!existsSyncImpl(filePath)) {
          // A /private-prefixed spelling may exist while the literal one does
          // not (or vice versa): probe both.
          const alt = filePath.startsWith('/private')
            ? filePath.slice('/private'.length)
            : `/private${filePath}`;
          if (existsSyncImpl(alt)) normalized = alt;
        }
        try { normalized = existsSyncImpl(normalized) ? realpathSync(normalized) : normalized; } catch { }
        filePath = normalized;
      }
      if (!isProductionSource(rootPath, filePath) || !existsSyncImpl(filePath)) continue;
      const existing = mergedScripts.get(url);
      if (!existing) {
        mergedScripts.set(url, { filePath, functions: [...(script.functions ?? [])] });
      } else {
        mergeScriptInto(existing.functions, script.functions ?? []);
      }
    }
  }
  return mergedScripts;
}

/**
 * Aggregate the FULL universe against merged V8 data.
 * Returns per-file rows (including never-loaded files at zero) and overall
 * ratios. Uncovered line numbers are reported per file for actionable logs.
 */
function normalizeRealpathSafe(filePath) {
  try { return realpathSync(filePath); } catch { return filePath; }
}

export function aggregateCoverage({
  rootPath: rootPathRaw,
  universe,
  mergedScripts,
  readFile = (filePath) => readFileSync(filePath, 'utf8'),
}) {
  const rootPath = normalizeRealpathSafe(rootPathRaw);
  const loadedByPath = new Map();
  for (const entry of mergedScripts.values()) loadedByPath.set(normalizeRealpathSafe(entry.filePath), entry.functions);

  const rows = [];
  const totals = { lines: [0, 0], functions: [0, 0], branches: [0, 0] };

  for (const filePath of universe) {
    const source = readFile(filePath);
    const lineRows = buildLineTable(source);
    const functions = loadedByPath.get(normalizeRealpathSafe(filePath));

    if (!functions) {
      // NEVER-LOADED production file: every CODE line counts, zero hit.
      const total = lineRows.filter((row) => row.endOffset > row.startOffset).length;
      totals.lines[1] += total;
      rows.push({
        file: relative(rootPath, filePath),
        loaded: false,
        linesPct: total === 0 ? 100 : 0,
        funcsPct: null,
        branchesPct: null,
        lines: [0, total],
        uncoveredLines: [],
      });
      continue;
    }

    let branchesTotal = 0;
    let branchesHit = 0;
    let functionsTotal = 0;
    let functionsHit = 0;

    // PASS 1: positives claim their fully-spanned lines (last write wins,
    // matching built-in iteration semantics).
    for (const func of functions) {
      for (const range of func.ranges ?? []) {
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
    }
    // PASS 2 (the honest-lines fix): NESTED ZERO-COUNT ranges demote every
    // line they fully span, so an executed function body cannot mask its own
    // untaken branches.
    for (const func of functions) {
      if (func.isBlockCoverage !== true) continue;
      for (const range of func.ranges ?? []) {
        if ((range.count ?? 0) > 0) continue;
        let cursor = 0;
        while (cursor < lineRows.length && lineRows[cursor].endOffset < range.startOffset) cursor += 1;
        for (; cursor < lineRows.length && lineRows[cursor].startOffset < range.endOffset; cursor += 1) {
          const row = lineRows[cursor];
          if (range.startOffset <= row.startOffset && range.endOffset >= row.endOffset) {
            row.count = 0;
          }
        }
      }
    }
    // Branch/function accounting mirrors the built-in definitions.
    functions.forEach((func, fnIndex) => {
      const ranges = func.ranges ?? [];
      if (func.isBlockCoverage === true) {
        for (const range of ranges) {
          branchesTotal += 1;
          if ((range.count ?? 0) > 0) branchesHit += 1;
        }
      }
      if (fnIndex > 0 && ranges.length > 0) {
        functionsTotal += 1;
        if ((ranges[0].count ?? 0) !== 0) functionsHit += 1;
      }
    });

    const uncoveredLineNumbers = [];
    lineRows.forEach((row, index) => {
      if (row.count <= 0 && row.endOffset > row.startOffset) uncoveredLineNumbers.push(index + 1);
    });
    const codeLines = lineRows.filter((row) => row.endOffset > row.startOffset);
    const linesHit = codeLines.filter((row) => row.count > 0).length;
    const linesPct = codeLines.length === 0 ? 100 : (linesHit / codeLines.length) * 100;
    const funcsPct = functionsTotal === 0 ? 100 : (functionsHit / functionsTotal) * 100;
    const branchesPct = branchesTotal === 0 ? 100 : (branchesHit / branchesTotal) * 100;
    totals.lines[0] += linesHit;
    totals.lines[1] += codeLines.length;
    totals.functions[0] += functionsHit;
    totals.functions[1] += functionsTotal;
    totals.branches[0] += branchesHit;
    totals.branches[1] += branchesTotal;
    rows.push({
      file: relative(rootPath, filePath),
      loaded: true,
      linesPct,
      funcsPct,
      branchesPct,
      lines: [linesHit, lineRows.length],
      uncoveredLines: uncoveredLineNumbers.slice(0, 40),
    });
  }

  rows.sort((a, b) => a.file.localeCompare(b.file));
  const overall = {
    lines: totals.lines[1] === 0 ? 100 : (totals.lines[0] / totals.lines[1]) * 100,
    functions: totals.functions[1] === 0 ? 100 : (totals.functions[0] / totals.functions[1]) * 100,
    branches: totals.branches[1] === 0 ? 100 : (totals.branches[0] / totals.branches[1]) * 100,
  };
  return { rows, overall, totals };
}

export function evaluateThresholds(overall, thresholds) {
  const failures = [];
  for (const metric of ['lines', 'functions', 'branches']) {
    if (!(overall[metric] >= thresholds[metric])) failures.push(metric);
  }
  return failures;
}

/**
 * HONEST never-loaded accounting: for every src/** production file the suite
 * did NOT load, run a throwaway child that merely IMPORTS it under its own
 * NODE_V8_COVERAGE dir. V8 then reports the module's TRUE function/branch
 * structure with zero hits, so functions/branches denominators include real
 * counts instead of silently excluding the file (which would fake 100%).
 *
 * Only side-effect-safe imports are attempted: bin/ scripts are excluded
 * (they execute CLIs), every failure is swallowed and the file stays an
 * explicit UNPROBED zero-lines row rather than a fabricated number.
 */
export function probeUnloadedSources({
  rootPath,
  universe,
  mergedScripts,
  workDir = mkdtempSync(join(tmpdirBase(), 'cov-probe-')),
} = {}) {
  const loaded = new Set([...mergedScripts.values()].map((script) => script.filePath));
  const missing = universe.filter((filePath) => !loaded.has(filePath)
    && filePath.startsWith(resolve(rootPath, 'src') + sep));
  const extraPayloads = [];
  const unprobeable = [];
  for (const filePath of missing) {
    const outDir = join(workDir, Buffer.from(relative(rootPath, filePath)).toString('hex').slice(0, 40));
    try {
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      const run = spawnSync(process.execPath, [
        '--input-type=module', '-e',
        `await import(${JSON.stringify(pathToFileURL(filePath).href)});`,
      ], {
        env: { ...process.env, NODE_V8_COVERAGE: outDir },
        timeout: 15_000,
      });
      if (run.error) throw run.error;
      let sawAny = false;
      collectJsonFiles(outDir, (path) => {
        try {
          const parsed = JSON.parse(readFileSync(path, 'utf8'));
          if (parsed?.result) { extraPayloads.push(parsed); sawAny = true; }
        } catch { /* skip unreadable */ }
      });
      if (!sawAny) unprobeable.push(filePath);
    } catch {
      unprobeable.push(filePath);
    }
  }
  return { extraPayloads, unprobeable };
}

function tmpdirBase() {
  return process.env.TMPDIR || process.env.TEMP || '/tmp';
}

function collectJsonFiles(dir, sink) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    let stats = null;
    try { stats = statSync(full); } catch { continue; }
    if (stats.isDirectory()) collectJsonFiles(full, sink);
    else if (name.endsWith('.json')) sink(full);
  }
}
