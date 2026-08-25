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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

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
    return { startOffset, endOffset, count: startOffset === endOffset ? 1 : 0 };
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
export function mergeV8Payloads(rootPath, payloads, { existsSyncImpl = existsSync } = {}) {
  const mergedScripts = new Map();
  for (const parsed of payloads) {
    for (const script of parsed?.result ?? []) {
      const url = typeof script.url === 'string' ? script.url : '';
      if (!url.startsWith('file://')) continue;
      let filePath;
      try {
        filePath = decodeURIComponent(new URL(url).pathname);
      } catch {
        continue;
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
export function aggregateCoverage({
  rootPath,
  universe,
  mergedScripts,
  readFile = (filePath) => readFileSync(filePath, 'utf8'),
}) {
  const loadedByPath = new Map();
  for (const entry of mergedScripts.values()) loadedByPath.set(entry.filePath, entry.functions);

  const rows = [];
  const totals = { lines: [0, 0], functions: [0, 0], branches: [0, 0] };

  for (const filePath of universe) {
    const source = readFile(filePath);
    const lineRows = buildLineTable(source);
    const functions = loadedByPath.get(filePath);

    if (!functions) {
      // NEVER-LOADED production file: entire line table counts, zero hit.
      const total = lineRows.length;
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
    const linesHit = lineRows.filter((row) => row.count > 0).length;
    const linesPct = lineRows.length === 0 ? 100 : (linesHit / lineRows.length) * 100;
    const funcsPct = functionsTotal === 0 ? 100 : (functionsHit / functionsTotal) * 100;
    const branchesPct = branchesTotal === 0 ? 100 : (branchesHit / branchesTotal) * 100;
    totals.lines[0] += linesHit;
    totals.lines[1] += lineRows.length;
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
