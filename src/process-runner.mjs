import { spawn } from 'node:child_process';

import { AiCliError } from './errors.mjs';

const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

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

    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        exceededOutput = true;
        terminate(child);
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));

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
        reject(new AiCliError('PROVIDER_EXIT_ERROR', `Provider exited with code ${exitCode ?? 'unknown'}`, {
          retryable: true,
          details: { exitCode, signal: exitSignal || null },
        }));
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
