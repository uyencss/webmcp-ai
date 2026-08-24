import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, isAbsolute, relative, resolve } from 'node:path';

import { AiCliError } from '../errors.mjs';
import { ORCHESTRATION_LIMITS } from './constants.mjs';
import { sanitizeValue, boundText } from './redaction.mjs';
import { writeAtomicFile } from './atomic-file.mjs';

const RECEIPT_SCHEMA = 'webmcp.ai-acceptance-receipt/v0';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isWithin(candidate, rootPath) {
  const rel = relative(rootPath, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function git(workspace, args) {
  const result = spawnSync('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result;
}

/**
 * Canonicalize a candidate path against the workspace root segment by segment
 * with lstat; symlink or special-file escapes throw before any use.
 */
export function canonicalizeWorkspacePath(rootPath, candidate) {
  if (!isAbsolute(candidate)) {
    // Relative candidates are resolved against the canonical workspace root.
    candidate = join(rootPath, candidate);
  }
  const absolute = resolve(candidate);
  if (!isWithin(absolute, resolve(rootPath))) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `path escapes the workspace root: ${absolute}`, { exitCode: 2 });
  }
  const rel = relative(resolve(rootPath), absolute);
  const missingTail = [];
  let cursor = realpathSync(rootPath);
  for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, segment);
    let stats;
    try {
      stats = lstatSync(cursor);
    } catch {
      // Not-yet-existing tail segments are acceptable (worker-created files);
      // keep appending them purely lexically.
      missingTail.push(segment);
      continue;
    }
    if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
      throw new AiCliError(
        'ORCHESTRATION_INVALID_INPUT',
        `unsafe path segment during canonicalization: ${segment}`,
        { exitCode: 2 },
      );
    }
  }
  return join(cursor, ...missingTail);
}

function hashFile(path) {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

function cano(pathValue) {
  try {
    return realpathSync(pathValue);
  } catch {
    return pathValue;
  }
}

function parsePorcelainV2(stdout) {
  const out = [];
  for (const record of stdout.split('\u0000')) {
    if (!record) continue;
    if (record.startsWith('1 ')) {
      const fields = record.split(' ');
      out.push({ x: fields[1]?.[0], y: fields[1]?.[1], path: fields[8] ?? '' });
    } else if (record.startsWith('2 ')) {
      const fields = record.split(' ');
      out.push({ x: fields[1]?.[0], y: fields[1]?.[1], path: fields[9] ?? '' });
    } else if (record.startsWith('u ')) {
      const fields = record.split(' ');
      out.push({ x: 'u', y: 'u', path: fields[10] ?? '' });
    } else if (record.startsWith('?') || record.startsWith('!')) {
      out.push({ x: record[0], y: record[0], path: record.slice(2) });
    }
  }
  return out;
}

/**
 * Capture pre-dispatch workspace evidence: repository identity, HEAD,
 * porcelain-v2 status, dirty-file hashes and nested-repository identities.
 */
export function captureWorkspaceBaseline(task) {
  const workspace = task.workspace;
  const toplevel = git(workspace, ['rev-parse', '--show-toplevel']);
  if (toplevel.status !== 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `workspace is not inside a Git repository: ${toplevel.stderr.slice(0, 200)}`, { exitCode: 2 });
  }
  const head = git(workspace, ['rev-parse', 'HEAD']);
  const startingRevision = head.status === 0 ? head.stdout.trim() : null;

  const status = git(workspace, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
  const entries = parsePorcelainV2(status.stdout);

  const dirtyFiles = {};
  const protectedDirty = {};
  for (const entry of entries) {
    const absolute = join(toplevel.stdout.trim(), entry.path.replace(/^"|"$/g, ''));
    if (!existsSync(absolute)) continue;
    const digest = hashFile(absolute);
    dirtyFiles[entry.path] = digest;
    for (const guarded of task.protectedPaths ?? []) {
      if (isWithin(cano(absolute), cano(guarded))) {
        protectedDirty[entry.path] = digest;
      }
    }
  }

  const nestedRepositories = [];
  collectNestedRepos(toplevel.stdout.trim(), nestedRepositories, new Set());

  return {
    repository: `sha256:${sha256(toplevel.stdout.trim())}`,
    workspaceRoot: toplevel.stdout.trim(),
    startingRevision,
    entries,
    dirtyFiles,
    protectedDirty,
    nestedRepositories,
  };
}

function collectNestedRepos(rootPath, sink, seen) {
  if (seen.has(rootPath)) return;
  seen.add(rootPath);
  let items = [];
  try {
    items = readdirSafe(rootPath);
  } catch {
    return;
  }
  for (const name of items) {
    const child = join(rootPath, name);
    let stats;
    try {
      stats = lstatSync(child);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      if (name === '.git' || existsSync(join(child, '.git'))) {
        if (name !== '.git') {
          const head = git(child, ['rev-parse', 'HEAD']);
          sink.push({
            path: child,
            revision: head.status === 0 ? head.stdout.trim() : null,
          });
        }
        continue;
      }
      collectNestedRepos(child, sink, seen);
    }
  }
}

function readdirSafe(dirPath) {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}


/**
 * Run one acceptance command from the Task packet. Executables come only from
 * the coordinator-owned allowlist; output beyond the inline bound spills into
 * a mode-0600 bounded ref.
 */
export async function runAcceptanceCommand(spec) {
  const argv = spec.argv;
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string') {
    return { verdict: 'failed', denied: true, reason: 'acceptance command must be an argv array' };
  }
  const timeoutMs = Math.min(Number(spec.timeoutMs ?? 60_000), ORCHESTRATION_LIMITS.maxAcceptanceCommandMs);
  const startedAt = Date.now();
  if (spec.stateDir) {
    mkdirSync(join(spec.stateDir, 'refs'), { recursive: true, mode: 0o700 });
  }

  return new Promise((resolveRun) => {
    process._rawDebug && process.env.R4_TRACE && process._rawDebug('TRACE pre-spawn');
    const child = spawnSync(argv[0], argv.slice(1), {
      cwd: spec.cwd,
      shell: false,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      encoding: 'buffer',
      maxBuffer: ORCHESTRATION_LIMITS.maxRefBytes,
      env: { ...process.env },
    });

    const elapsedMs = Date.now() - startedAt;
    process._rawDebug && process.env.R4_TRACE && process._rawDebug(`TRACE post-spawn status=${child.status} sig=${child.signal} err=${child.error?.code} outLen=${child.stdout?.length}`);
    if (child.error?.code === 'ENOENT' || child.error?.code === 'EACCES') {
      resolveRun({
        argvDigest: `sha256:${sha256(JSON.stringify(argv))}`,
        denied: true,
        verdict: 'failed',
        reason: `executable outside policy allowlist (${child.error.code})`,
        elapsedMs,
      });
      return;
    }

    const stdoutText = String(child.stdout ?? '');
    const stderrText = String(child.stderr ?? '');
    const combined = `${stdoutText}\n${stderrText}`;
    const bytes = Buffer.byteLength(combined);

    let outputRef = null;
    if (bytes > ORCHESTRATION_LIMITS.maxInlinePayloadBytes && spec.stateDir) {
      mkdirSync(join(spec.stateDir, 'refs'), { recursive: true, mode: 0o700 });
      // Spilled tool output passes the same redaction boundary as everything
      // else that persists; the ref records bounded, sanitized content plus
      // explicit truncation metadata for the raw bytes.
      const sanitizedText = typeof sanitizeValue(combined) === 'string'
        ? sanitizeValue(combined)
        : JSON.stringify(sanitizeValue(combined));
      const bounded = boundText(sanitizedText, { maxBytes: ORCHESTRATION_LIMITS.maxInlinePayloadBytes, label: 'acceptance-output' });
      const name = `ref_${sha256(combined).slice(0, 16)}.txt`;
      writeAtomicFile(join(spec.stateDir, 'refs', name), bounded.text);
      outputRef = join('refs', name);
    }

    process._rawDebug && process.env.R4_TRACE && process._rawDebug('TRACE pre-resolve');
    resolveRun({
      argvDigest: `sha256:${sha256(JSON.stringify(argv))}`,
      exitCode: child.status,
      signal: child.signal ?? null,
      timedOut: Boolean(child.error?.code === 'ENTIMEOUT' || child.signal === 'SIGKILL' && timeoutMs <= elapsedMs + 50),
      durationMs: elapsedMs,
      stdoutBytes: Buffer.byteLength(stdoutText),
      stderrBytes: Buffer.byteLength(stderrText),
      outputRef,
      ...(spec.intendedRed ? {} : {}),
      intendedRed: Boolean(spec.intendedRed),
    });
  });
}

function summarizeVerdict(results, expectedExitCode) {
  return results.map((result) => {
    if (result.denied) return 'denied';
    if (result.timedOut) return 'timeout';
    if (result.intendedRed) return 'intended_RED';
    return result.exitCode === (expectedExitCode ?? 0) ? 'GREEN' : 'failed';
  });
}

/**
 * Independent acceptance verification. The verifier observes and rejects; it
 * never repairs worker changes. Any indeterminacy yields `indeterminate`,
 * never `accepted`.
 */
export async function verifyDispatch(context) {
  const { task, baseline, workerOutcome, commands = [], now = Date.now() } = context;
  const violations = [];
  let currentRevision = baseline.startingRevision;

  const head = git(baseline.workspaceRoot, ['rev-parse', 'HEAD']);
  if (head.status === 0) currentRevision = head.stdout.trim();
  if (
    baseline.startingRevision
    && currentRevision !== baseline.startingRevision
    && task.allowedCommitAuthority !== true
  ) {
    violations.push({
      kind: 'revision_changed_without_authority',
      detail: `starting ${baseline.startingRevision} -> current ${currentRevision}`,
    });
  }

  const statusNow = git(baseline.workspaceRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
  const currentEntries = parsePorcelainV2(statusNow.stdout);
  const baselineByPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const changedPaths = [];
  const protectedPathViolations = [];

  for (const entry of currentEntries) {
    const entryPath = entry.path;
    if (!entryPath) continue;
    changedPaths.push(entryPath);
    const absolute = join(baseline.workspaceRoot, entryPath.replace(/^"|"$/g, ''));
    let hashNow = null;
    try {
      if (existsSync(absolute) && lstatSync(absolute).isFile()) hashNow = hashFile(absolute);
    } catch {
      hashNow = null;
    }
    const beforeEntry = baselineByPath.get(entryPath);
    const beforeDigest = beforeEntry ? (baseline.dirtyFiles[entryPath] ?? null) : null;
    const isWorkerChange = !beforeEntry || beforeDigest !== hashNow;

    for (const guarded of task.protectedPaths ?? []) {
      if (isWithin(cano(absolute), cano(guarded))) {
        if (!beforeEntry || beforeDigest !== hashNow) {
          protectedPathViolations.push(entryPath);
        }
      }
    }
    if (!isWorkerChange) continue;
    if (existsSync(absolute)) {
      const stats = lstatSync(absolute);
      const inAllowedWrite = (task.allowedWriteRoots ?? []).some((root) => isWithin(cano(absolute), cano(root)));
      if (!inAllowedWrite) {
        violations.push({ kind: 'write_outside_allowed_roots', path: entryPath });
      } else if (stats.isSymbolicLink()) {
        let target = null;
        try {
          target = realpathSync(absolute);
        } catch {
          target = null;
        }
        if (!target || !isWithin(target, baseline.workspaceRoot)) {
          violations.push({ kind: 'symlink_escape', path: entryPath });
        }
      }
    }
  }

  // Undeclared nested repositories introduced after the baseline.
  if (context.declaredNestedRepositories !== undefined) {
    const srcNested = join(baseline.workspaceRoot, 'src');
    if (
      existsSync(srcNested)
      && lstatSync(srcNested).isDirectory()
      && existsSync(join(srcNested, '.git'))
      && !context.declaredNestedRepositories.includes(srcNested)
    ) {
      violations.push({
        kind: 'undeclared_nested_repository',
        path: relative(baseline.workspaceRoot, srcNested),
      });
    }
  }

  // Acceptance commands run sequentially with per-command evidence.
  const testResults = [];
  for (const command of commands) {
    const spec = Array.isArray(command)
      ? { argv: command, cwd: task.workspace, timeoutMs: 120_000, stateDir: context.stateDir }
      : { cwd: task.workspace, timeoutMs: 120_000, stateDir: context.stateDir, ...command };
    const allowlist = task.commandPolicy?.allowedExecutables ?? [];
    if (!allowlist.includes(spec.argv[0])) {
      testResults.push({
        argvDigest: `sha256:${sha256(JSON.stringify(spec.argv))}`,
        denied: true,
        verdict: 'denied',
        reason: 'executable outside coordinator allowlist',
      });
      continue;
    }
    const result = await runAcceptanceCommand(spec);
    const label = result.denied
      ? 'denied'
      : result.timedOut
        ? 'timeout'
        : result.intendedRed
          ? 'intended_RED'
          : result.exitCode === (spec.expectedExitCode ?? 0)
            ? 'GREEN'
            : 'failed';
    testResults.push({ ...result, verdict: label });
  }

  const anyFailed = testResults.some((result) => ['failed', 'denied', 'timeout'].includes(result.verdict));
  const allGreen = commands.length > 0 && testResults.every((result) => result.verdict === 'GREEN');
  const onlyIntendedRed = commands.length > 0
    && testResults.length > 0
    && testResults.every((result) => result.verdict === 'intended_RED');

  const workerClaimMatched = workerOutcome === 'completed'
    && violations.length === 0
    && protectedPathViolations.length === 0
    && allGreen;

  let verdict = 'indeterminate';
  if (violations.length > 0 || protectedPathViolations.length > 0 || anyFailed) {
    verdict = 'rejected';
  } else if (onlyIntendedRed) {
    verdict = 'indeterminate';
  } else if (allGreen) {
    verdict = 'accepted';
  }

  return {
    schema: RECEIPT_SCHEMA,
    coordinationId: context.coordinationId,
    taskId: task.taskId,
    dispatchId: context.dispatchId,
    fenceEpoch: context.fenceEpoch,
    workspace: {
      repository: baseline.repository,
      startingRevision: baseline.startingRevision,
      currentRevision,
      changedPaths,
      protectedPathViolations: [...new Set(protectedPathViolations)],
      violations,
    },
    tests: testResults.map(({
      argvDigest, verdict: label, exitCode, signal, timedOut, denied, outputRef, durationMs, reason,
    }) => ({
      argvDigest,
      verdict: label,
      exitCode: exitCode ?? null,
      signal: signal ?? null,
      ...(timedOut ? { timedOut: true } : {}),
      ...(denied ? { denied: true, reason } : {}),
      ...(outputRef ? { outputRef } : {}),
      durationMs: durationMs ?? null,
    })),
    workerClaimMatched,
    verdict,
    verifiedAt: new Date(now).toISOString(),
  };
}

export function receiptOutputPath(stateDir, digest) {
  return join(stateDir ?? '.', 'receipts', digest.slice(0, 16));
}
