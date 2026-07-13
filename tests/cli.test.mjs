import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bin = fileURLToPath(new URL('../bin/webmcp-ai.mjs', import.meta.url));
const fakeBin = fileURLToPath(new URL('./fixtures/fake-ai-cli.mjs', import.meta.url));
chmodSync(fakeBin, 0o755);

function run(args, { input, env = {} } = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    input,
    encoding: 'utf8',
    cwd: '/tmp',
    env: {
      ...process.env,
      AGY_BIN: fakeBin,
      CLAUDE_BIN: fakeBin,
      CODEX_BIN: fakeBin,
      ...env,
    },
  });
}

test('help documents the complete command surface', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp-ai doctor/);
  assert.match(result.stdout, /webmcp-ai providers list/);
  assert.match(result.stdout, /webmcp-ai generate/);
  assert.match(result.stdout, /webmcp-ai tool-call/);
});

test('providers list emits stable JSON', () => {
  const result = run(['providers', 'list', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.providers.map((provider) => provider.id), ['agy', 'claude', 'codex']);
});

test('doctor, inspect, models, tools, and version commands are independently usable', () => {
  const doctor = run(['doctor', '--json'], { env: { FAKE_PROVIDER: 'doctor' } });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).readyProviders.length, 3);

  const inspect = run(['providers', 'inspect', 'codex', '--json']);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.equal(JSON.parse(inspect.stdout).provider.id, 'codex');

  const models = run(['models', 'list', '--provider', 'agy', '--json'], { env: { FAKE_PROVIDER: 'agy' } });
  assert.equal(models.status, 0, models.stderr);
  assert.deepEqual(JSON.parse(models.stdout).models, ['model-one', 'model-two']);

  const tools = run(['tools', 'describe', '--json']);
  assert.equal(tools.status, 0, tools.stderr);
  assert.equal(JSON.parse(tools.stdout).tools[0].id, 'ai.generate');

  const version = run(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^0\.1\.0/);
});

test('generate accepts JSON input over stdin', () => {
  const result = run(['generate', '--input-json', '-', '--json'], {
    input: JSON.stringify({ provider: 'claude', prompt: 'from-json', model: 'sonnet' }),
    env: { FAKE_PROVIDER: 'claude' },
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.response.text, 'reply:claude:from-json');
});

test('tool-call implements webmcp-tool-v1', () => {
  const result = run(['tool-call', '--json'], {
    input: JSON.stringify({
      protocol: 'webmcp-tool-v1',
      requestId: 'run-1@compose',
      tool: 'ai.generate',
      input: { provider: 'codex', prompt: 'tool-prompt' },
    }),
    env: { FAKE_PROVIDER: 'codex' },
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.protocol, 'webmcp-tool-v1');
  assert.equal(payload.requestId, 'run-1@compose');
  assert.equal(payload.output.text, 'reply:codex:tool-prompt');
});

test('JSON errors are stable and exclude stack traces', () => {
  const result = run(['generate', '--provider', 'missing', '--prompt', 'hello', '--json']);
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'UNKNOWN_PROVIDER');
  assert.equal('stack' in payload.error, false);
});

test('invalid JSON and unknown commands produce typed usage errors', () => {
  const invalidJson = run(['generate', '--input-json', '-', '--json'], { input: '{' });
  assert.equal(invalidJson.status, 2);
  assert.equal(JSON.parse(invalidJson.stdout).error.code, 'INVALID_JSON');

  const unknown = run(['unknown']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /USAGE_ERROR/);
});

test('human-readable command output remains composable', () => {
  const providers = run(['providers', 'list']);
  assert.equal(providers.status, 0, providers.stderr);
  assert.match(providers.stdout, /claude\tClaude Code/);

  const inspect = run(['providers', 'inspect', 'agy']);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stdout, /"id": "agy"/);

  const models = run(['models', 'list', '--provider=agy'], { env: { FAKE_PROVIDER: 'agy' } });
  assert.equal(models.status, 0, models.stderr);
  assert.equal(models.stdout, 'model-one\nmodel-two\n');

  const generate = run(['generate', '--provider=agy', '--prompt', 'human-output'], {
    env: { FAKE_PROVIDER: 'agy' },
  });
  assert.equal(generate.status, 0, generate.stderr);
  assert.equal(generate.stdout, 'reply:agy:human-output\n');
});
