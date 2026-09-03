import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildFullChildEnv,
  buildOpenCodeConfig,
  normalizeAccessProfile,
  toOpenCodeRelativePatterns,
  validateCapabilityRequest,
  VALID_ACCESS_PROFILES,
} from '../src/capabilities.mjs';
import { generate } from '../src/client.mjs';
import { describeTools, handleToolCall } from '../src/protocol.mjs';
import { getProvider } from '../src/providers/index.mjs';

const fakeBin = fileURLToPath(new URL('./fixtures/fake-ai-cli.mjs', import.meta.url));

test('full is a known access profile', () => {
  assert.ok(VALID_ACCESS_PROFILES.has('full'));
  assert.equal(normalizeAccessProfile('full'), 'full');
  // near-miss names stay invalid
  assert.throws(() => normalizeAccessProfile('full-access'), (e) => e.code === 'INVALID_INPUT');
});

test('full requires only an existing workspace directory', () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-ws-'));
  try {
    const req = validateCapabilityRequest({ workspace: ws, accessProfile: 'full' });
    assert.equal(req.accessProfile, 'full');
    assert.equal(req.workspace, ws);
    assert.ok(req.allowedReadRoots.includes(ws));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('full does not require write roots and allows ancestor read roots', () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-ancestor-ws-'));
  try {
    // Ancestor read root is rejected for bounded profiles but allowed for full.
    // tmpdir() is an ancestor of the mkdtemp workspace on all platforms.
    const ancestor = tmpdir();
    const req = validateCapabilityRequest({
      workspace: ws,
      accessProfile: 'full',
      allowedReadRoots: [ancestor],
      allowedWriteRoots: [],
    });
    assert.equal(req.accessProfile, 'full');
    assert.deepEqual(req.allowedWriteRoots, []);
    assert.ok(req.allowedReadRoots.includes(ancestor));
    assert.ok(req.allowedReadRoots.includes(ws));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('full conflicts fail closed with compose-only toolPolicy', () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-conflict-'));
  try {
    assert.throws(
      () => validateCapabilityRequest({ workspace: ws, accessProfile: 'full', toolPolicy: 'compose-only' }),
      (e) => e.code === 'INVALID_INPUT',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('opencode full is passthrough: no generated config, ambient tools kept', () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-opencode-'));
  try {
    const invocation = getProvider('opencode').buildInvocation({
      prompt: 'full prompt',
      timeoutMs: 1234,
      workspace: ws,
      accessProfile: 'full',
      agentMode: 'accept-edits',
      env: {},
    });
    assert.equal(invocation.stdin, 'full prompt');
    assert.ok(invocation.args.includes('--dir'));
    assert.equal(invocation.args[invocation.args.indexOf('--dir') + 1], ws);
    assert.ok(invocation.args.includes('--auto'));
    // No restrictive generated config: ambient operator config is kept.
    assert.equal(invocation.env.OPENCODE_CONFIG_CONTENT, undefined);
    assert.equal(invocation.env.OPENCODE_CONFIG, undefined);
    assert.equal(invocation.env.OPENCODE_PURE, undefined);
    // Session DB isolation is kept (harmless, avoids SQLITE_BUSY).
    assert.ok(typeof invocation.env.OPENCODE_DB === 'string');
    assert.equal(typeof invocation.cleanup, 'function');
    invocation.cleanup();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('codex full uses workspace-write instead of read-only sandbox', () => {
  const invocation = getProvider('codex').buildInvocation({
    prompt: 'x',
    timeoutMs: 1000,
    accessProfile: 'full',
  });
  assert.equal(invocation.args[invocation.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(invocation.args.includes('read-only'), false);
  assert.equal(invocation.args.includes('danger-full-access'), false);
  assert.equal(typeof invocation.cleanup, 'function');
  invocation.cleanup();

  const locked = getProvider('codex').buildInvocation({ prompt: 'x', timeoutMs: 1000 });
  assert.ok(locked.args.includes('--sandbox'));
  locked.cleanup();
});

test('claude full drops the text-only tool deny', () => {
  const invocation = getProvider('claude').buildInvocation({
    prompt: 'x',
    timeoutMs: 1000,
    accessProfile: 'full',
  });
  assert.equal(invocation.args.includes('--tools'), false);
  assert.equal(invocation.args.includes('--safe-mode'), false);

  const locked = getProvider('claude').buildInvocation({ prompt: 'x', timeoutMs: 1000 });
  assert.deepEqual(locked.args.slice(0, 4), ['-p', '--tools', '', '--safe-mode']);
});

test('agy full drops the forced sandbox', () => {
  const invocation = getProvider('agy').buildInvocation({
    prompt: 'x',
    timeoutMs: 5000,
    accessProfile: 'full',
  });
  assert.equal(invocation.args.includes('--sandbox'), false);

  const locked = getProvider('agy').buildInvocation({ prompt: 'x', timeoutMs: 5000 });
  assert.ok(locked.args.includes('--sandbox'));
});

test('buildOpenCodeConfig full does not throw', () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-cfg-'));
  try {
    const cfg = buildOpenCodeConfig({ accessProfile: 'full', workspace: ws });
    assert.equal(cfg.permission['*'], 'allow');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('protocol schema advertises full', () => {
  const tools = describeTools();
  const schema = tools.tools[0].inputSchema.properties.accessProfile;
  assert.ok(schema.enum.includes('full'));
});

test('full child env passes ambient through except WebMCP authority denylist', () => {
  const env = buildFullChildEnv({
    MY_OPERATOR_VAR: 'kept',
    ANTHROPIC_API_KEY: 'provider-auth-kept',
    WEBMCP_SIGNING_KEY: 'drop',
    WEBMCP_PRIVATE_KEY: 'drop',
    WEBMCP_PERMIT_PRIVATE_KEY: 'drop',
    WEBMCP_GATEWAY_TOKEN: 'drop',
    WEBMCP_RUNNER_SECRET: 'drop',
    WEBMCP_VAULT_KEY: 'drop',
    WEBMCP_VAULT_KEY_FILE: 'drop',
    WEBMCP_VAULT_NEW_KEY: 'drop',
    WEBMCP_VAULT_NEW_KEY_FILE: 'drop',
  }, { OPENCODE_DB: '/tmp/cli.db' });
  assert.equal(env.MY_OPERATOR_VAR, 'kept');
  assert.equal(env.ANTHROPIC_API_KEY, 'provider-auth-kept');
  assert.equal(env.OPENCODE_DB, '/tmp/cli.db');
  for (const denied of [
    'WEBMCP_SIGNING_KEY', 'WEBMCP_PRIVATE_KEY', 'WEBMCP_PERMIT_PRIVATE_KEY',
    'WEBMCP_GATEWAY_TOKEN', 'WEBMCP_RUNNER_SECRET', 'WEBMCP_VAULT_KEY',
    'WEBMCP_VAULT_KEY_FILE', 'WEBMCP_VAULT_NEW_KEY', 'WEBMCP_VAULT_NEW_KEY_FILE',
  ]) {
    assert.equal(denied in env, false, `${denied} must not reach the child`);
  }
});

test('full generate reaches the provider with ambient env intact', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-env-'));
  try {
    const result = await generate({
      provider: 'opencode',
      prompt: 'env check',
      workspace: ws,
      accessProfile: 'full',
      env: {
        ...process.env,
        OPENCODE_BIN: fakeBin,
        FAKE_PROVIDER: 'opencode',
        FAKE_ECHO_ENV: 'WEBMCP_AI_FULL_PROBE,WEBMCP_GATEWAY_TOKEN',
        WEBMCP_AI_FULL_PROBE: 'visible-to-child',
        WEBMCP_GATEWAY_TOKEN: 'must-not-arrive',
      },
    });
    assert.equal(result.ok, true);
    assert.match(result.response.text, /WEBMCP_AI_FULL_PROBE=visible-to-child/);
    assert.match(result.response.text, /WEBMCP_GATEWAY_TOKEN=$/m);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('bounded profiles still strip ambient env', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'bounded-env-'));
  try {
    const result = await generate({
      provider: 'opencode',
      prompt: 'env check',
      workspace: ws,
      accessProfile: 'review-readonly',
      env: {
        ...process.env,
        OPENCODE_BIN: fakeBin,
        FAKE_PROVIDER: 'opencode',
        FAKE_ECHO_ENV: 'WEBMCP_AI_BOUNDED_PROBE',
        WEBMCP_AI_BOUNDED_PROBE: 'must-not-arrive',
      },
    });
    assert.equal(result.ok, true);
    assert.match(result.response.text, /WEBMCP_AI_BOUNDED_PROBE=$/m);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('maxOutputBytes validates and flows through tool-call', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-maxout-'));
  try {
    const baseEnv = { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' };
    const ok = await handleToolCall({
      protocol: 'webmcp-tool-v1',
      requestId: 'maxout-1',
      tool: 'ai.generate',
      input: { provider: 'opencode', prompt: 'hi', workspace: ws, accessProfile: 'full', maxOutputBytes: 1024 },
    }, { env: baseEnv });
    assert.equal(ok.ok, true);
    assert.equal(ok.metadata.capability.accessProfile, 'full');
    assert.equal(ok.metadata.capability.fullPassthrough, true);
    await assert.rejects(
      generate({ provider: 'opencode', prompt: 'hi', workspace: ws, maxOutputBytes: -5, env: baseEnv }),
      (e) => e.code === 'INVALID_INPUT',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('bounded-edit emits workspace-relative edit/write rules', () => {
  const ws = mkdtempSync(join(tmpdir(), 'bounded-rel-'));
  try {
    assert.deepEqual(toOpenCodeRelativePatterns(join(ws, 'src'), ws), ['src', 'src/**']);
    assert.deepEqual(toOpenCodeRelativePatterns(ws, ws), ['**']);
    const cfg = buildOpenCodeConfig({
      accessProfile: 'bounded-edit',
      workspace: ws,
      allowedReadRoots: [ws],
      allowedWriteRoots: [join(ws, 'src')],
      protectedPaths: [join(ws, 'src', 'secret.mjs')],
    });
    for (const tool of ['edit', 'write']) {
      const rules = cfg.permission[tool];
      assert.equal(rules['*'], 'deny');
      assert.equal(rules.src, 'allow');
      assert.equal(rules['src/**'], 'allow');
      assert.equal(rules[join('src', 'secret.mjs')], 'deny');
      for (const key of Object.keys(rules)) {
        if (key === '*') continue;
        assert.equal(key.startsWith('/'), false, `${tool} rule must be relative, got ${key}`);
      }
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
