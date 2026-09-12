import { spawn } from 'node:child_process';

import { AiCliError } from './errors.mjs';

const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const CLASSIFICATION_SAMPLE_BYTES = 16 * 1024;

function boundedDiagnostics(stdout, stderr) {
  return Buffer.concat([...stderr, ...stdout])
    .toString('utf8')
    .slice(-CLASSIFICATION_SAMPLE_BYTES);
}

function classifyProviderExit({ stdout, stderr, exitCode, exitSignal }) {
  const text = boundedDiagnostics(stdout, stderr).toLowerCase();
  const details = { exitCode, signal: exitSignal || null };

  // Concurrent opencode runs contend on the same SQLite database and fail with
  // "database is locked" (SQLITE_BUSY). This is transient; retrying with
  // backoff is the fix, so classify it separately from a generic provider exit.
  if (/\b(database|db)\b.{0,40}\bis locked\b|\bsqlite_busy\b|\bdatabase table is locked\b/.test(text)) {
    return new AiCliError('PROVIDER_DB_LOCKED', 'Provider storage is locked by a concurrent process', {
      retryable: true,
      details,
    });
  }
  if (/\b(quota|credit|credits|usage limit|billing limit|insufficient credits|out of credits|resource exhausted)\b/.test(text)
    || /\b429\b/.test(text) && /\b(quota|credit|usage)\b/.test(text)) {
    return new AiCliError('PROVIDER_QUOTA_EXHAUSTED', 'Provider quota or credits are exhausted', {
      retryable: false,
      details,
    });
  }
  if (/\b(auth|authentication|authorization|unauthorized|forbidden|token_invalidated|refresh_token_invalidated|invalid api key|login required)\b/.test(text)
    || /\b(401|403)\b/.test(text)) {
    return new AiCliError('PROVIDER_AUTH_FAILED', 'Provider authentication failed', {
      retryable: false,
      details,
    });
  }
  if (/\b(rate limit|rate-limit|too many requests|temporarily rate limited)\b/.test(text) || /\b429\b/.test(text)) {
    return new AiCliError('PROVIDER_RATE_LIMITED', 'Provider is rate limited', {
      retryable: true,
      details,
    });
  }
  return new AiCliError('PROVIDER_EXIT_ERROR', `Provider exited with code ${exitCode ?? 'unknown'}`, {
    retryable: true,
    details,
  });
}

function terminate(child) {
  if (!child.pid || child.killed) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export function runProcess(command, args, {
  stdin = null,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 600_000,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  signal,
  onStdout = null,
  onStderr = null,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let exceededOutput = false;
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;

    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    };

    const onAbort = () => {
      terminate(child);
      finishReject(new AiCliError('PROVIDER_ABORTED', 'Provider execution was aborted', {
        retryable: true,
      }));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    // Live forward: an observer (orchestrator) sees provider bytes as they
    // arrive instead of waiting for exit. A throwing callback must never
    // break the run, and buffering/accounting below is unchanged.
    const forward = (callback) => (chunk) => {
      if (typeof callback !== 'function') return;
      try {
        callback(chunk);
      } catch {
        // Observer errors are swallowed by design; completion is decided by
        // the process result and independent verification, not the observer.
      }
    };
    const forwardStdout = forward(onStdout);
    const forwardStderr = forward(onStderr);

    const collect = (target, forwardChunk) => (chunk) => {
      forwardChunk(chunk);
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        exceededOutput = true;
        terminate(child);
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', collect(stdout, forwardStdout));
    child.stderr.on('data', collect(stderr, forwardStderr));

    child.on('error', (error) => {
      const missing = error.code === 'ENOENT';
      finishReject(new AiCliError(
        missing ? 'CLI_NOT_INSTALLED' : 'PROVIDER_SPAWN_ERROR',
        missing ? `Provider CLI not found: ${command}` : `Could not start provider CLI: ${command}`,
        { exitCode: missing ? 2 : 1, cause: error },
      ));
    });

    child.on('close', (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      if (timedOut) {
        reject(new AiCliError('PROVIDER_TIMEOUT', `Provider exceeded the ${timeoutMs}ms timeout`, {
          retryable: true,
          details: { timeoutMs },
        }));
        return;
      }
      if (exceededOutput) {
        reject(new AiCliError('PROVIDER_OUTPUT_LIMIT', `Provider output exceeded ${maxOutputBytes} bytes`, {
          details: { maxOutputBytes },
        }));
        return;
      }
      if (exitCode !== 0) {
        reject(classifyProviderExit({ stdout, stderr, exitCode, exitSignal }));
        return;
      }

      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: exitCode ?? 0,
      });
    });

    if (stdin === null || stdin === undefined) child.stdin.end();
    else child.stdin.end(String(stdin));
  });
}
