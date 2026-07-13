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
