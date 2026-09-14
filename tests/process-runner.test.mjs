import assert from 'node:assert/strict';
import test from 'node:test';

import { runProcess } from '../src/process-runner.mjs';

test('process runner captures stdout and stderr', async () => {
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('out'); process.stderr.write('err')"], {
    timeoutMs: 1000,
  });
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
});

test('process runner enforces output limits', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(1000))"], {
      timeoutMs: 1000,
      maxOutputBytes: 10,
    }),
    (error) => error.code === 'PROVIDER_OUTPUT_LIMIT',
  );
});

test('process runner supports AbortSignal', async () => {
  const controller = new AbortController();
  const promise = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
    timeoutMs: 2000,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(promise, (error) => error.code === 'PROVIDER_ABORTED');
});

test('process runner reports missing executables', async () => {
  await assert.rejects(
    runProcess('/definitely/missing/webmcp-ai', [], { timeoutMs: 1000 }),
    (error) => error.code === 'CLI_NOT_INSTALLED' && error.exitCode === 2,
  );
});

test('process runner classifies bounded provider failures without leaking raw output', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', "process.stderr.write('insufficient credits for account'); process.exit(1)"], {
      timeoutMs: 1000,
    }),
    (error) => error.code === 'PROVIDER_QUOTA_EXHAUSTED'
      && error.retryable === false
      && error.details.exitCode === 1
      && JSON.stringify(error.details).includes('credits') === false,
  );
  await assert.rejects(
    runProcess(process.execPath, ['-e', "process.stderr.write('401 token_invalidated'); process.exit(1)"], {
      timeoutMs: 1000,
    }),
    (error) => error.code === 'PROVIDER_AUTH_FAILED' && error.retryable === false,
  );
  await assert.rejects(
    runProcess(process.execPath, ['-e', "process.stderr.write('429 too many requests'); process.exit(1)"], {
      timeoutMs: 1000,
    }),
    (error) => error.code === 'PROVIDER_RATE_LIMITED' && error.retryable === true,
  );
  await assert.rejects(
    runProcess(process.execPath, ['-e', "process.stderr.write('renderer crashed'); process.exit(1)"], {
      timeoutMs: 1000,
    }),
    (error) => error.code === 'PROVIDER_EXIT_ERROR',
  );
});

test('process runner preserves structured provider no-route failures without leaking raw diagnostics', async () => {
  const nativeFailure = JSON.stringify({
    type: 'error',
    error: {
      type: 'provider.no-route',
      message: 'Model unavailable: opencode-go/muse-spark-1.3-contributor',
    },
  });
  await assert.rejects(
    runProcess(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(nativeFailure)}); process.exit(1)`], {
      timeoutMs: 1000,
    }),
    (error) => error.code === 'PROVIDER_NO_ROUTE'
      && error.retryable === false
      && error.details.exitCode === 1
      && error.details.providerCode === 'provider.no-route'
      && !JSON.stringify(error).includes('Model unavailable'),
  );
});
