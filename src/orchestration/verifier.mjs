import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, isAbsolute, relative, resolve, sep } from 'node:path';

import { AiCliError } from '../errors.mjs';
import { ORCHESTRATION_LIMITS } from './constants.mjs';
import { sanitizeValue, boundText } from './redaction.mjs';
import { createAtomicExclusiveFile } from './atomic-file.mjs';
import { reserveRefsBytes } from './refs-quota.mjs';

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
  // `cursor` only ever advances over VERIFIED existing segments. As soon as a
  // segment is missing, EVERY remaining segment belongs to the missing tail
  // and is appended verbatim in lexical order — probing later segments would
  // mix two different spellings of the path and reorder the caller's tail.
  let cursor = realpathSync(rootPath);
  for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
    if (missingTail.length > 0) {
      missingTail.push(segment);
      continue;
    }
    const next = join(cursor, segment);
    let stats;
    try {
      stats = lstatSync(next);
    } catch {
      // Not-yet-existing tail segments are acceptable (worker-created files).
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
    cursor = next;
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

function probeSucceeded(result) {
  return result?.status === 0 && !result?.error && !result?.signal;
}

/**
 * Canonicalize an absolute path's EXISTING prefix segment by segment
 * (resolving symlinks like realpath would) while keeping any missing tail
 * purely lexical, so containment checks never mix two spellings of one
 * directory and symlinked segments are judged by where they REALLY lead.
 */
/**
 * Canonicalize the EXISTING prefix of a path while being HONEST about every
 * filesystem proof failure:
 *   - a genuinely missing segment (ENOENT) continues lexically — the missing
 *     tail is legal under preventive confinement;
 *   - an existing symlink is resolved to its TARGET, and a DANGLING link
 *     (target missing) or a loop (ELOOP) is a hard refusal, never silently
 *     treated as "missing";
 *   - any other probe error (EACCES, EIO, ...) fails closed: geometry that
 *     cannot be proven cannot be authorized.
 */
export function canonicalizeExistingPrefix(pathValue) {
  const absolute = resolve(pathValue);
  let cursor = isAbsolute(absolute) ? sep : '.';
  for (const segment of absolute.split(/[\\/]/).filter(Boolean)) {
    const next = join(cursor, segment);
    let stats = null;
    try {
      stats = lstatSync(next);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        cursor = next;
        continue;
      }
      throw new AiCliError(
        'POLICY_DENIED',
        `path segment '${segment}' cannot be proven (${error?.code ?? 'ERROR'}): ${next}`,
      );
    }
    if (stats.isSymbolicLink()) {
      let target = null;
      try {
        target = realpathSync(next);
      } catch (error) {
        throw new AiCliError(
          'POLICY_DENIED',
          `symlinked segment '${segment}' does not resolve (${error?.code ?? 'ERROR'}): ${next}`,
        );
      }
      cursor = target;
      continue;
    }
    cursor = next;
  }
  return cursor;
}

function canonicalExistingPrefix(pathValue) {
  return canonicalizeExistingPrefix(pathValue);
}

/** True when two paths overlap in EITHER containment direction. */
export function pathsOverlap(firstPath, secondPath) {
  const left = canonicalExistingPrefix(firstPath);
  const right = canonicalExistingPrefix(secondPath);
  return isWithin(left, right) || isWithin(right, left);
}

/**
 * Canonical protected/write-root policy: EVERY protected path / allowed write
 * root pair is canonicalized (existing prefix resolved through symlinks,
 * missing tails kept lexical and ordered) and refused when the two spellings
 * are EQUAL after canonicalization or overlap in either containment
 * direction. Lexically-disjoint aliases that resolve onto one location are
 * therefore rejected BEFORE any task admission or worker launch, closing the
 * symlink-substitution bypass of the purely lexical packet check.
 */
export function assertNoProtectedWriteOverlap({ protectedPaths = [], allowedWriteRoots = [] } = {}) {
  // EVERY allowed write root must be provable — even when zero protected
  // paths exist. Canonicalization is the proof step: dangling symlinks,
  // loops or unprovable segments refuse here regardless of overlap.
  const writableCanonicals = (allowedWriteRoots ?? []).map((writableRaw) => ({
    raw: String(writableRaw),
    canonical: canonicalizeExistingPrefix(String(writableRaw)),
  }));
  const guardedCanonicals = (protectedPaths ?? []).map((guardedRaw) => ({
    raw: String(guardedRaw),
    canonical: canonicalizeExistingPrefix(String(guardedRaw)),
  }));
  for (const guarded of guardedCanonicals) {
    for (const writable of writableCanonicals) {
      if (guarded.canonical === writable.canonical) {
        throw new AiCliError(
          'POLICY_DENIED',
          'protected path and allowed write root are equal after canonicalization; '
            + `aliasing ${guarded.raw} <-> ${writable.raw} is refused`,
        );
      }
      if (isWithin(guarded.canonical, writable.canonical) || isWithin(writable.canonical, guarded.canonical)) {
        throw new AiCliError(
          'POLICY_DENIED',
          'protected path and allowed write root overlap after canonicalization; '
            + `${guarded.raw} vs ${writable.raw} is refused`,
        );
      }
    }
  }
}

function parsePorcelainV2(stdout) {
  const out = [];
  const records = stdout.split('\u0000');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('1 ')) {
      const fields = record.split(' ');
      out.push({ x: fields[1]?.[0], y: fields[1]?.[1], path: fields[8] ?? '', origPath: null });
    } else if (record.startsWith('2 ')) {
      const fields = record.split(' ');
      // In -z format a rename/copy record is followed by the ORIGINAL path as
      // its own NUL-terminated token.
      const isRenameOrCopy = fields[1]?.[0] === 'C' || fields[1]?.[0] === 'R';
      out.push({
        x: fields[1]?.[0],
        y: fields[1]?.[1],
        path: fields[9] ?? '',
        origPath: isRenameOrCopy ? (records[index + 1] ?? null) : null,
      });
      if (isRenameOrCopy) index += 1;
    } else if (record.startsWith('u ')) {
      const fields = record.split(' ');
      out.push({ x: 'u', y: 'u', path: fields[10] ?? '', origPath: null });
    } else if (record.startsWith('?') || record.startsWith('!')) {
      out.push({ x: record[0], y: record[0], path: record.slice(2), origPath: null });
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
  if (!probeSucceeded(toplevel)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `workspace is not inside a Git repository: ${String(toplevel.stderr ?? '').slice(0, 200)}`, { exitCode: 2 });
  }
  const head = git(workspace, ['rev-parse', 'HEAD']);
  const startingRevision = head.status === 0 && !head.error && !head.signal ? head.stdout.trim() : null;

  const status = git(workspace, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
  if (!probeSucceeded(status)) {
    // A failed status probe would silently produce an EMPTY baseline; that
    // fabrication is worse than refusing to dispatch at all.
    throw new AiCliError('ORCHESTRATION_INDETERMINATE', `workspace status probe failed: ${String(status.stderr ?? '').slice(0, 200)}`, { exitCode: 2 });
  }
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
    let outputRefOverflowReason = null;
    if (bytes > ORCHESTRATION_LIMITS.maxInlinePayloadBytes && spec.stateDir) {
      mkdirSync(join(spec.stateDir, 'refs'), { recursive: true, mode: 0o700 });
      // Spilled tool output passes the same redaction boundary as everything
      // else that persists; the ref records bounded, sanitized content plus
      // explicit truncation metadata for the raw bytes.
      const sanitizedText = typeof sanitizeValue(combined) === 'string'
        ? sanitizeValue(combined)
        : JSON.stringify(sanitizeValue(combined));
      const bounded = boundText(sanitizedText, { maxBytes: ORCHESTRATION_LIMITS.maxInlinePayloadBytes, label: 'acceptance-output' });
      const baseName = `ref_${sha256(combined).slice(0, 16)}`;
      // Coordination-TOTAL refs quota: acceptance spills reserve their exact
      // sanitized byte size against the SHARED refs directory before any
      // write; overflow is typed and leaves no file behind.
      try {
        reserveRefsBytes(join(spec.stateDir, 'refs'), Buffer.byteLength(bounded.text), {
          writerId: `acceptance-spill:${baseName}`,
        });
      } catch (error) {
        if (error?.code === 'REFS_LIMIT_REACHED') {
          resolveRun({
            argvDigest: `sha256:${sha256(JSON.stringify(argv))}`,
            exitCode: child.status,
            signal: child.signal ?? null,
            timedOut: false,
            durationMs: elapsedMs,
            stdoutBytes: Buffer.byteLength(stdoutText),
            stderrBytes: Buffer.byteLength(stderrText),
            outputRef: null,
            outputRefOverflowReason: 'refs-quota',
            intendedRed: Boolean(spec.intendedRed),
          });
          return;
        }
        throw error;
      }
      // Exclusive create with content-addressed naming: on the (rare)
      // digest collision a NEW suffixed name is written instead of ever
      // overwriting durable evidence.
      let name = `${baseName}.txt`;
      for (let attempt = 0;; attempt += 1) {
        try {
          createAtomicExclusiveFile(join(spec.stateDir, 'refs', name), bounded.text);
          break;
        } catch (error) {
          if (attempt >= 16 || error?.code !== 'ORCHESTRATION_INVALID_INPUT') throw error;
          name = `${baseName}-${attempt + 1}.txt`;
        }
      }
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
      ...(outputRefOverflowReason ? { outputRefOverflowReason } : {}),
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

  // ---- Required Git evidence, re-proven NOW (fail closed) ----------------
  // Every probe below MUST succeed for acceptance to remain reachable; any
  // failure downgrades the receipt to indeterminate/rejected and never to a
  // fabricated pass over missing evidence.
  let gitEvidence = 'reproven';
  let repositoryIdentityReproven = false;

  const toplevelNow = git(baseline.workspaceRoot, ['rev-parse', '--show-toplevel']);
  if (!probeSucceeded(toplevelNow)) {
    gitEvidence = 'unavailable';
  } else {
    const topLevelPath = toplevelNow.stdout.trim();
    // Canonical Git top-level identity must still be THE baseline repository.
    if (cano(topLevelPath) !== cano(baseline.workspaceRoot)
      || baseline.repository !== `sha256:${sha256(topLevelPath)}`) {
      violations.push({
        kind: 'repository_identity_changed',
        detail: `baseline ${baseline.workspaceRoot} (${baseline.repository}) -> current ${topLevelPath}`,
      });
      gitEvidence = 'identity-changed';
    } else {
      repositoryIdentityReproven = true;
    }
  }

  const head = git(baseline.workspaceRoot, ['rev-parse', 'HEAD']);
  if (probeSucceeded(head)) {
    currentRevision = head.stdout.trim();
  } else if (baseline.startingRevision) {
    // A repo that HAD commits at baseline but cannot answer rev-parse now has
    // lost required evidence (metadata hidden/corrupt mid-flight).
    gitEvidence = gitEvidence === 'reproven' ? 'unavailable' : gitEvidence;
  }
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
  const statusUsable = probeSucceeded(statusNow);
  if (!statusUsable) {
    gitEvidence = gitEvidence === 'reproven' ? 'unavailable' : gitEvidence;
  }
  const currentEntries = statusUsable ? parsePorcelainV2(statusNow.stdout) : [];
  const baselineByPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const changedPaths = [];
  const protectedPathViolations = [];

  // Policy contradiction check in BOTH containment directions: a protected
  // path inside a writable root (or a writable root inside a protected path)
  // can never be verified honestly, whatever the worker actually did.
  const overlapPairs = [];
  for (const guarded of task.protectedPaths ?? []) {
    for (const writeRoot of task.allowedWriteRoots ?? []) {
      if (pathsOverlap(guarded, writeRoot)) {
        overlapPairs.push({ protectedPath: guarded, writeRoot });
      }
    }
  }
  if (overlapPairs.length > 0) {
    violations.push({ kind: 'protected_write_overlap', pairs: overlapPairs });
  }

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
    const inAllowedWriteFor = (candidatePath) => (task.allowedWriteRoots ?? []).some(
      (root) => isWithin(cano(candidatePath), cano(root)),
    );
    if (!existsSync(absolute)) {
      // A tracked/known path disappeared: deletions are writes too and must
      // never escape the declared write roots.
      if (!inAllowedWriteFor(absolute)) {
        violations.push({ kind: 'delete_outside_allowed_roots', path: entryPath });
      }
      // A rename whose ORIGINAL path sat outside the write roots moved
      // content the worker was never allowed to touch.
      if (entry.origPath) {
        const origAbsolute = join(baseline.workspaceRoot, String(entry.origPath).replace(/^"|"$/g, ''));
        if (!inAllowedWriteFor(origAbsolute)) {
          violations.push({ kind: 'write_outside_allowed_roots', path: entry.origPath });
        }
      }
      continue;
    }
    {
      const stats = lstatSync(absolute);
      const inAllowedWrite = inAllowedWriteFor(absolute);
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
    // Rename source check for surviving renames as well.
    if (entry.origPath) {
      const origAbsolute = join(baseline.workspaceRoot, String(entry.origPath).replace(/^"|"$/g, ''));
      if (!inAllowedWriteFor(origAbsolute)) {
        violations.push({ kind: 'write_outside_allowed_roots', path: entry.origPath });
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

  // The durable worker outcome is supervisor-owned evidence: independent
  // acceptance requires the worker to have ACTUALLY completed.
  const workerCompleted = workerOutcome === 'completed';
  const workerClaimMatched = workerCompleted
    && violations.length === 0
    && protectedPathViolations.length === 0
    && allGreen;

  let verdict = 'indeterminate';
  if (violations.length > 0 || protectedPathViolations.length > 0 || anyFailed) {
    verdict = 'rejected';
  } else if (!workerCompleted) {
    // Green tests over a failed/cancelled worker are a mismatch, never an
    // acceptance. Truthful resolution: rejected for failed workers,
    // indeterminate when the worker was cancelled or lost.
    verdict = workerOutcome === 'failed' ? 'rejected' : 'indeterminate';
  } else if (onlyIntendedRed) {
    verdict = 'indeterminate';
  } else if (allGreen) {
    verdict = 'accepted';
  }

  // Fail-closed post-classification: unavailable Git evidence can never be
  // accepted, and a changed repository identity is tamper evidence.
  if (gitEvidence === 'identity-changed') {
    verdict = 'rejected';
  } else if (gitEvidence === 'unavailable' && verdict === 'accepted') {
    verdict = 'indeterminate';
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
      gitEvidence,
      repositoryIdentityReproven,
    },
    tests: testResults.map(({
      argvDigest, verdict: label, exitCode, signal, timedOut, denied, outputRef, outputRefOverflowReason, durationMs, reason,
    }) => ({
      argvDigest,
      verdict: label,
      exitCode: exitCode ?? null,
      signal: signal ?? null,
      ...(timedOut ? { timedOut: true } : {}),
      ...(denied ? { denied: true, reason } : {}),
      ...(outputRef ? { outputRef } : {}),
      ...(outputRefOverflowReason
        ? { outputRef: null, outputRefOverflowReason }
        : {}),
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
