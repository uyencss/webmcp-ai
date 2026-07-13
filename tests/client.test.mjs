import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { generate, listModels, probeProviders } from '../src/client.mjs';

const fakeBin = fileURLToPath(new URL('./fixtures/fake-ai-cli.mjs', import.meta.url));
chmodSync(fakeBin, 0o755);

test('generate invokes Claude and returns the normalized envelope', async () => {
  const result = await generate({
    provider: 'claude',
    prompt: 'hello',
    model: 'sonnet',
    env: { ...process.env, CLAUDE_BIN: fakeBin, FAKE_PROVIDER: 'claude' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider.id, 'claude');
  assert.equal(result.response.text, 'reply:claude:hello');
  assert.equal(result.session.id, 'claude-session');
  assert.ok(result.timing.elapsedMs >= 0);
});

test('generate reads Codex output-last-message files', async () => {
  const result = await generate({
    provider: 'codex',
    prompt: 'hello',
    env: { ...process.env, CODEX_BIN: fakeBin, FAKE_PROVIDER: 'codex' },
  });

  assert.equal(result.response.text, 'reply:codex:hello');
});

test('generate returns typed provider failures with redacted stderr', async () => {
  await assert.rejects(
    generate({
      provider: 'agy',
      prompt: 'hello',
      env: {
        ...process.env,
        AGY_BIN: fakeBin,
        FAKE_PROVIDER: 'agy',
        FAKE_EXIT_CODE: '7',
      },
    }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_EXIT_ERROR');
      assert.equal(error.details.exitCode, 7);
      assert.doesNotMatch(error.message, /redact-me/);
      return true;
    },
  );
});

test('generate enforces timeout and terminates the provider', async () => {
  await assert.rejects(
    generate({
      provider: 'claude',
      prompt: 'hello',
      timeoutMs: 20,
      env: {
        ...process.env,
        CLAUDE_BIN: fakeBin,
        FAKE_PROVIDER: 'claude',
        FAKE_DELAY_MS: '200',
      },
    }),
    (error) => error.code === 'PROVIDER_TIMEOUT',
  );
});

test('doctor-style provider probes report available and missing binaries', async () => {
  const probes = await probeProviders({
    env: {
      ...process.env,
      AGY_BIN: fakeBin,
      CLAUDE_BIN: '/definitely/missing/claude',
      CODEX_BIN: fakeBin,
      FAKE_PROVIDER: 'probe',
    },
  });

  assert.equal(probes.find((probe) => probe.id === 'agy').available, true);
  assert.equal(probes.find((probe) => probe.id === 'claude').available, false);
  assert.equal(probes.find((probe) => probe.id === 'codex').version, 'probe-cli 9.9.9');
});

test('model discovery is provider-scoped', async () => {
  const models = await listModels('agy', {
    env: { ...process.env, AGY_BIN: fakeBin, FAKE_PROVIDER: 'agy' },
  });
  assert.deepEqual(models, ['model-one', 'model-two']);
  await assert.rejects(listModels('claude'), (error) => error.code === 'UNSUPPORTED_CAPABILITY');
});

test('generate validates required input and timeout', async () => {
  await assert.rejects(generate({ provider: 'claude', prompt: '' }), (error) => error.code === 'INVALID_INPUT');
  await assert.rejects(generate({ provider: 'claude', prompt: 'x', timeoutMs: 0 }), (error) => error.code === 'INVALID_INPUT');
});

test('generate reports missing provider executables', async () => {
  await assert.rejects(
    generate({ provider: 'claude', prompt: 'x', env: { ...process.env, CLAUDE_BIN: '/definitely/missing/claude' } }),
    (error) => error.code === 'CLI_NOT_INSTALLED',
  );
});

test('generate rejects empty provider responses', async () => {
  await assert.rejects(
    generate({
      provider: 'agy',
      prompt: 'x',
      env: { ...process.env, AGY_BIN: fakeBin, FAKE_PROVIDER: 'agy', FAKE_EMPTY: '1' },
    }),
    (error) => error.code === 'EMPTY_RESPONSE',
  );
});

test('provider probes handle missing PATH commands', async () => {
  const probes = await probeProviders({
    env: {
      ...process.env,
      AGY_BIN: 'definitely-missing-webmcp-ai-command',
      CLAUDE_BIN: fakeBin,
      CODEX_BIN: fakeBin,
      FAKE_PROVIDER: 'probe',
    },
  });
  assert.equal(probes.find((probe) => probe.id === 'agy').available, false);
});
