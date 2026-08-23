import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bin = fileURLToPath(new URL('../bin/webmcp-ai.mjs', import.meta.url));

function run(args, { input, env = {} } = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    input,
    encoding: 'utf8',
    cwd: '/tmp',
    timeout: 60_000,
    env: {
      ...process.env,
      ...env,
    },
  });
}

function cliStateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-t4cli-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('orchestration capabilities and guide are additive', () => {
  const capabilities = run(['orchestration', 'capabilities', '--json']);
  assert.equal(capabilities.status, 0, capabilities.stderr);
  assert.equal(JSON.parse(capabilities.stdout).protocol, 'webmcp.ai-orchestration/v0');

  const guide = run(['orchestration', 'guide', '--format', 'markdown']);
  assert.equal(guide.status, 0, guide.stderr);
  assert.match(guide.stdout, /Portable CLI Agent Orchestration Runtime/);
});

test('orchestration create and call work through a temporary state override', (t) => {
  const stateDir = cliStateDir(t);
  const baseEnv = { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir };

  const create = run(['orchestration', 'create', '--input-json', '-', '--json'], {
    input: JSON.stringify({
      protocol: 'webmcp.ai-orchestration/v0',
      requestId: 'req_cli_create',
      owner: { host: 'cli-test' },
    }),
    env: baseEnv,
  });
  assert.equal(create.status, 0, create.stderr || create.stdout);
  const created = JSON.parse(create.stdout);
  assert.equal(created.ok, true);
  const coordinationId = created.coordinationId;
  assert.match(coordinationId, /^coord_/);

  const call = run(['orchestration', 'call', '--coordination', coordinationId, '--input-json', '-', '--json'], {
    input: JSON.stringify({
      protocol: 'webmcp.ai-orchestration/v0',
      requestId: 'req_cli_call',
      operation: 'coordination.inspect',
      input: {},
    }),
    env: baseEnv,
  });
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const response = JSON.parse(call.stdout);
  assert.equal(response.ok, true);
  assert.equal(response.result.coordinationId, coordinationId);
});

test('invalid JSON input and missing --coordination fail with typed envelopes', () => {
  const badJson = run(['orchestration', 'create', '--input-json', '-', '--json'], {
    input: '{not json',
  });
  assert.notEqual(badJson.status, 0);
  const envelope = JSON.parse(badJson.stdout);
  assert.equal(envelope.ok, false);

  const missingCoordination = run(['orchestration', 'call', '--input-json', '-', '--json'], {
    input: JSON.stringify({
      protocol: 'webmcp.ai-orchestration/v0',
      requestId: 'req_missing_coord',
      operation: 'coordination.inspect',
      input: {},
    }),
  });
  assert.notEqual(missingCoordination.status, 0);
  const missingEnvelope = JSON.parse(missingCoordination.stdout);
  assert.equal(missingEnvelope.ok, false);
  assert.match(missingEnvelope.error.code, /ORCHESTRATION_INVALID_INPUT|USAGE_ERROR/);
});

test('unknown orchestration subcommands are rejected without touching one-shot parsing', () => {
  const unknown = run(['orchestration', 'teleport', '--json']);
  assert.notEqual(unknown.status, 0);

  // Existing command surface unchanged.
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /webmcp-ai generate/);
  assert.match(help.stdout, /webmcp-ai tool-call/);
  assert.match(help.stdout, /orchestration capabilities/);
});

test('the kill switch blocks mutation but keeps read-only inspection usable', async (t) => {
  const stateDir = cliStateDir(t);
  const disabledEnv = {
    WEBMCP_AI_ORCHESTRATION_DISABLED: '1',
    WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir,
  };

  const blockedCreate = run(['orchestration', 'create', '--input-json', '-', '--json'], {
    input: JSON.stringify({
      protocol: 'webmcp.ai-orchestration/v0',
      requestId: 'req_disabled_create',
    }),
    env: disabledEnv,
  });
  assert.notEqual(blockedCreate.status, 0);
  const blockedEnvelope = JSON.parse(blockedCreate.stdout);
  assert.equal(blockedEnvelope.ok, false);
  assert.equal(blockedEnvelope.error.code, 'ORCHESTRATION_DISABLED');

  const stillCapabilities = run(['orchestration', 'capabilities', '--json'], { env: disabledEnv });
  assert.equal(stillCapabilities.status, 0, stillCapabilities.stderr);
  assert.equal(JSON.parse(stillCapabilities.stdout).enabled, false);

  const stillGuide = run(['orchestration', 'guide', '--format', 'markdown'], { env: disabledEnv });
  assert.equal(stillGuide.status, 0, stillGuide.stderr);

  // One-shot path remains fully usable with the kill switch engaged.
  const providers = run(['providers', 'list', '--json'], { env: disabledEnv });
  assert.equal(providers.status, 0, providers.stderr);
  assert.equal(JSON.parse(providers.stdout).ok, true);
});
