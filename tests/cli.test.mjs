import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runCli } from '../src/cli.mjs';
import { withV2Db } from './fixtures/opencode-v2-db.mjs';

const bin = fileURLToPath(new URL('../bin/webmcp-ai.mjs', import.meta.url));
const fakeBin = fileURLToPath(new URL('./fixtures/fake-ai-cli.mjs', import.meta.url));
chmodSync(fakeBin, 0o755);

function run(args, { input, env = {} } = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    input,
    encoding: 'utf8',
    cwd: '/tmp',
    env: withV2Db({
      ...process.env,
      AGY_BIN: fakeBin,
      CLAUDE_BIN: fakeBin,
      CODEX_BIN: fakeBin,
      OPENCODE_BIN: fakeBin,
      ...env,
    }),
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
  assert.deepEqual(payload.providers.map((provider) => provider.id), ['agy', 'claude', 'codex', 'opencode']);
});

test('doctor, inspect, models, agents, tools, and version commands are independently usable', () => {
  const doctor = run(['doctor', '--json'], { env: { FAKE_PROVIDER: 'doctor' } });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).readyProviders.length, 4);

  const inspect = run(['providers', 'inspect', 'codex', '--json']);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.equal(JSON.parse(inspect.stdout).provider.id, 'codex');

  const models = run(['models', 'list', '--provider', 'agy', '--json'], { env: { FAKE_PROVIDER: 'agy' } });
  assert.equal(models.status, 0, models.stderr);
  assert.deepEqual(JSON.parse(models.stdout).models, ['model-one', 'model-two']);

  const agents = run(['agents', 'list', '--provider', 'agy', '--json'], { env: { FAKE_PROVIDER: 'agy' } });
  assert.equal(agents.status, 0, agents.stderr);
  assert.deepEqual(JSON.parse(agents.stdout).agents, ['webmcp-node-executor', 'code-reviewer']);

  const tools = run(['tools', 'describe', '--json']);
  assert.equal(tools.status, 0, tools.stderr);
  assert.equal(JSON.parse(tools.stdout).tools[0].id, 'ai.generate');

  const version = run(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^0\.3\.0-alpha\.1/);
});

test('orchestration subcommand requires extracted package and keeps one-shots stable', () => {
  const stateDir = join(tmpdir(), `webmcp-ai-cli-disabled-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const capabilities = run(['orchestration', 'capabilities', '--json'], {
    env: {
      WEBMCP_AI_ORCHESTRATION_DISABLED: '1',
      WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir,
    },
  });
  assert.equal(capabilities.status, 2, capabilities.stderr);
  const payload = JSON.parse(capabilities.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'ORCHESTRATION_PACKAGE_REQUIRED');
  assert.match(payload.error.message, /@gyga-browser\/webmcp-ai-orchestration/);
  assert.equal(capabilities.stderr, '', 'shim emits typed JSON without stack trace');
  assert.equal(existsSync(stateDir), false, 'missing package never creates state');

  const textMode = run(['orchestration', 'capabilities']);
  assert.equal(textMode.status, 2);
  assert.match(textMode.stderr, /^ORCHESTRATION_PACKAGE_REQUIRED:/);
  assert.doesNotMatch(textMode.stderr, /at /);

  const providers = run(['providers', 'list', '--json'], {
    env: { WEBMCP_AI_ORCHESTRATION_DISABLED: '1' },
  });
  assert.equal(providers.status, 0, providers.stderr);
  assert.equal(JSON.parse(providers.stdout).ok, true);
});

test('generate accepts JSON input over stdin', () => {
  const result = run(['generate', '--input-json', '-', '--json'], {
    input: JSON.stringify({
      provider: 'agy',
      prompt: 'from-json',
      model: 'sonnet',
      agent: 'webmcp-node-executor',
    }),
    env: { FAKE_PROVIDER: 'agy' },
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.response.text, 'reply:agy:from-json');
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

test('tool-call failures stay protocol-shaped and echo the requestId', () => {
  const result = run(['tool-call', '--json'], {
    input: JSON.stringify({
      protocol: 'webmcp-tool-v1',
      requestId: 'run-9@compose',
      tool: 'ai.generate',
      input: { provider: 'nope', prompt: 'x' },
    }),
  });
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.protocol, 'webmcp-tool-v1');
  assert.equal(payload.requestId, 'run-9@compose');
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'UNKNOWN_PROVIDER');
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

  const agents = run(['agents', 'list', '--provider=agy'], { env: { FAKE_PROVIDER: 'agy' } });
  assert.equal(agents.status, 0, agents.stderr);
  assert.equal(agents.stdout, 'webmcp-node-executor\ncode-reviewer\n');

  const generate = run(['generate', '--provider=agy', '--prompt', 'human-output'], {
    env: { FAKE_PROVIDER: 'agy' },
  });
  assert.equal(generate.status, 0, generate.stderr);
  assert.equal(generate.stdout, 'reply:agy:human-output\n');
});

test('CLI --stream string flag forms map through isTrueFlag', () => {
  const ws = mkdtempSync(join(tmpdir(), 'cli-stream-flag-'));
  try {
    const base = ['generate', '--provider', 'opencode', '--prompt', 'flag form', '--workspace', ws, '--full', '--json'];
    const enabled = run([...base, '--stream=true'], { env: { FAKE_PROVIDER: 'opencode' } });
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.match(enabled.stderr, /reply:opencode:flag form/);
    const enabledOne = run([...base, '--stream=1'], { env: { FAKE_PROVIDER: 'opencode' } });
    assert.equal(enabledOne.status, 0, enabledOne.stderr);
    assert.match(enabledOne.stderr, /reply:opencode:flag form/);
    const enabledYes = run([...base, '--stream=yes'], { env: { FAKE_PROVIDER: 'opencode' } });
    assert.equal(enabledYes.status, 0, enabledYes.stderr);
    assert.match(enabledYes.stderr, /reply:opencode:flag form/);
    const disabled = run([...base, '--stream=false'], { env: { FAKE_PROVIDER: 'opencode' } });
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(disabled.stderr.includes('reply:opencode:flag form'), false);
    const disabledZero = run([...base, '--stream=0'], { env: { FAKE_PROVIDER: 'opencode' } });
    assert.equal(disabledZero.status, 0, disabledZero.stderr);
    assert.equal(disabledZero.stderr.includes('reply:opencode:flag form'), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('CLI --events string flag forms map through isTrueFlag', () => {
  const ws = mkdtempSync(join(tmpdir(), 'cli-events-flag-'));
  try {
    const base = ['generate', '--provider', 'opencode', '--prompt', 'event flag', '--workspace', ws, '--full', '--json'];
    const enabled = run([...base, '--events=true'], { env: { FAKE_PROVIDER: 'opencode' } });
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.match(enabled.stderr, /webmcp-ai-event/);
    const disabled = run([...base, '--events=false'], { env: { FAKE_PROVIDER: 'opencode' } });
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(disabled.stderr.includes('webmcp-ai-event'), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('CLI --input-json file path and --prompt-file behave like stdin', () => {
  const ws = mkdtempSync(join(tmpdir(), 'cli-file-input-'));
  try {
    const inputPath = join(ws, 'input.json');
    writeFileSync(inputPath, JSON.stringify({ provider: 'agy', prompt: 'from-file', model: 'sonnet' }));
    const fromFile = run(['generate', '--input-json', inputPath, '--json'], { env: { FAKE_PROVIDER: 'agy' } });
    assert.equal(fromFile.status, 0, fromFile.stderr);
    assert.equal(JSON.parse(fromFile.stdout).response.text, 'reply:agy:from-file');

    const promptPath = join(ws, 'prompt.md');
    writeFileSync(promptPath, 'file-prompt-body');
    const fromPromptFile = run(
      ['generate', '--provider', 'agy', '--prompt-file', promptPath, '--json'],
      { env: { FAKE_PROVIDER: 'agy' } },
    );
    assert.equal(fromPromptFile.status, 0, fromPromptFile.stderr);
    assert.equal(JSON.parse(fromPromptFile.stdout).response.text, 'reply:agy:file-prompt-body');

    const schemaPath = join(ws, 'schema.json');
    writeFileSync(schemaPath, JSON.stringify({ type: 'object' }));
    const withSchema = run(
      ['generate', '--provider', 'codex', '--prompt', 'schema check', '--schema', schemaPath, '--json'],
      { env: { FAKE_PROVIDER: 'codex' } },
    );
    assert.equal(withSchema.status, 0, withSchema.stderr);
    assert.equal(JSON.parse(withSchema.stdout).ok, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('CLI --store-revisions parses JSON and rejects non-object fallback', () => {
  const ws = mkdtempSync(join(tmpdir(), 'cli-store-rev-'));
  try {
    const ok = run(
      ['generate', '--provider', 'opencode', '--prompt', 'rev check', '--workspace', ws, '--full', '--store-revisions', '{"automation":"sha256:aaa"}', '--json'],
      { env: { FAKE_PROVIDER: 'opencode' } },
    );
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).ok, true);

    const fromJson = run(['generate', '--input-json', '-', '--json'], {
      input: JSON.stringify({
        provider: 'opencode', prompt: 'rev json', workspace: ws, accessProfile: 'full', storeRevisions: { automation: 'sha256:aaa' },
      }),
      env: { FAKE_PROVIDER: 'opencode' },
    });
    assert.equal(fromJson.status, 0, fromJson.stderr);
    assert.equal(JSON.parse(fromJson.stdout).ok, true);

    const bad = run(
      ['generate', '--provider', 'opencode', '--prompt', 'rev bad', '--workspace', ws, '--full', '--store-revisions', 'not-json{', '--json'],
      { env: { FAKE_PROVIDER: 'opencode' } },
    );
    assert.equal(bad.status, 2);
    assert.equal(JSON.parse(bad.stdout).error.code, 'INVALID_INPUT');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('CLI tools describe without --json and custom command name cover print paths', () => {
  const plain = run(['tools', 'describe']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(JSON.parse(plain.stdout).ok, true);

  const custom = run(['--help'], { env: { WEBMCP_AI_COMMAND_NAME: 'custom-ai' } });
  assert.equal(custom.status, 0, custom.stderr);
  assert.match(custom.stdout, /custom-ai doctor/);
});

test('CLI repeatable roots accept values and tolerate a bare flag', () => {
  const ws = mkdtempSync(join(tmpdir(), 'cli-repeatable-'));
  try {
    const withRoots = run(
      ['generate', '--provider', 'opencode', '--prompt', 'roots check', '--workspace', ws, '--full', '--allowed-read-root', ws, '--allowed-write-root', ws, '--protected-path', join(ws, 'secret.txt'), '--json'],
      { env: { FAKE_PROVIDER: 'opencode' } },
    );
    assert.equal(withRoots.status, 0, withRoots.stderr);
    assert.equal(JSON.parse(withRoots.stdout).ok, true);

    const bare = run(
      ['generate', '--provider', 'opencode', '--prompt', 'bare flag', '--workspace', ws, '--full', '--allowed-read-root', '--json'],
      { env: { FAKE_PROVIDER: 'opencode' } },
    );
    assert.equal(bare.status, 0, bare.stderr);
    assert.equal(JSON.parse(bare.stdout).ok, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('CLI clogged stderr does not fail --stream and --events', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cli-clogged-'));
  const env = withV2Db({
    ...process.env,
    AGY_BIN: fakeBin,
    CLAUDE_BIN: fakeBin,
    CODEX_BIN: fakeBin,
    OPENCODE_BIN: fakeBin,
    FAKE_PROVIDER: 'opencode',
  });
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let throwsRemaining = 2;
  process.stderr.write = () => {
    if (throwsRemaining > 0) {
      throwsRemaining -= 1;
      throw new Error('clogged diagnostics channel');
    }
    return true;
  };
  try {
    const code = await runCli(
      ['generate', '--provider', 'opencode', '--prompt', 'clogged check', '--workspace', ws, '--full', '--stream', '--events', '--json'],
      env,
    );
    assert.equal(code, 0);
    assert.equal(throwsRemaining, 0);
  } finally {
    process.stderr.write = originalStderrWrite;
    rmSync(ws, { recursive: true, force: true });
  }
});
