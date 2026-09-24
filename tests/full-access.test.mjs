import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildFullChildEnv,
  buildOpenCodeConfig,
  FULL_DENY_EXACT,
  FULL_DENY_PREFIXES,
  isFullChildEnvDenied,
  normalizeAccessProfile,
  toOpenCodeRelativePatterns,
  validateCapabilityRequest,
  VALID_ACCESS_PROFILES,
} from '../src/capabilities.mjs';
import { generate } from '../src/client.mjs';
import { describeTools, handleToolCall, TOOL_PROTOCOL } from '../src/protocol.mjs';
import { getProvider } from '../src/providers/index.mjs';
import { withV2Db } from './fixtures/opencode-v2-db.mjs';

const fakeBin = fileURLToPath(new URL('./fixtures/fake-ai-cli.mjs', import.meta.url));
const bin = fileURLToPath(new URL('../bin/webmcp-ai.mjs', import.meta.url));

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
    assert.equal(invocation.args.includes('--dir'), false);
    assert.ok(invocation.args.includes('--standalone'));
    assert.ok(invocation.args.includes('--auto'));
    // No restrictive generated config: ambient operator config is kept (opencode only).
    assert.equal(invocation.env.OPENCODE_CONFIG_CONTENT, undefined);
    assert.equal(invocation.env.OPENCODE_CONFIG, undefined);
    assert.equal(invocation.env.OPENCODE_PURE, undefined);
    // Session DB isolation is kept (harmless, avoids SQLITE_BUSY).
    assert.ok(typeof invocation.env.OPENCODE_DB === 'string');
    assert.ok(invocation.env.OPENCODE_DB.endsWith('opencode.db'));
    assert.equal(typeof invocation.cleanup, 'function');
    invocation.cleanup();

    // explicit opencodeProfile:'v1' is refused
    assert.throws(
      () => getProvider('opencode').buildInvocation({
        prompt: 'full prompt',
        timeoutMs: 1234,
        workspace: ws,
        accessProfile: 'full',
        agentMode: 'accept-edits',
        env: {},
        opencodeProfile: 'v1',
      }),
      (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT' && e.details?.required === 'v2',
    );
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
  // Truthful scope: full still isolates config via ephemeral + ignore flags,
  // so ambient user config/MCP is NOT inherited (opencode-only keeps ambient).
  assert.ok(invocation.args.includes('--ephemeral'));
  assert.ok(invocation.args.includes('--ignore-user-config'));
  assert.ok(invocation.args.includes('--ignore-rules'));
  assert.equal(typeof invocation.cleanup, 'function');
  invocation.cleanup();

  const locked = getProvider('codex').buildInvocation({ prompt: 'x', timeoutMs: 1000 });
  assert.ok(locked.args.includes('--sandbox'));
  assert.equal(locked.args[locked.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(locked.args.includes('--ephemeral'));
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

// M1: explicit auditable boundary — entire WEBMCP_ namespace plus named
// server/Vault authority is denied; provider credentials stay ambient.
// Uses fixed fixture literals only (never real env values).
test('full child env boundary denies WEBMCP namespace and server/Vault authority', () => {
  // Boundary is explicit and auditable: exact known keys + WEBMCP_ prefix.
  assert.ok(FULL_DENY_EXACT.has('WEBMCP_SIGNING_KEY'));
  assert.ok(FULL_DENY_EXACT.has('OPENCODE_SERVER_PASSWORD'));
  assert.ok(FULL_DENY_EXACT.has('VAULT_TOKEN'));
  assert.ok(FULL_DENY_EXACT.has('VAULT_ADDR'));
  assert.deepEqual([...FULL_DENY_PREFIXES], ['WEBMCP_']);
  assert.equal(isFullChildEnvDenied('WEBMCP_SIGNING_KEY'), true);
  assert.equal(isFullChildEnvDenied('WEBMCP_AI_WORKER_CAPABILITY_FILE'), true);
  assert.equal(isFullChildEnvDenied('WEBMCP_CUSTOM_FUTURE_KEY'), true);
  assert.equal(isFullChildEnvDenied('OPENCODE_SERVER_PASSWORD'), true);
  assert.equal(isFullChildEnvDenied('VAULT_TOKEN'), true);
  assert.equal(isFullChildEnvDenied('VAULT_ADDR'), true);
  assert.equal(isFullChildEnvDenied('ANTHROPIC_API_KEY'), false);
  assert.equal(isFullChildEnvDenied('MY_OPERATOR_VAR'), false);

  const env = buildFullChildEnv({
    MY_OPERATOR_VAR: 'kept-fixture',
    ANTHROPIC_API_KEY: 'provider-auth-fixture',
    OPENAI_API_KEY: 'provider-auth-fixture-2',
    WEBMCP_SIGNING_KEY: 'deny-fixture',
    WEBMCP_PRIVATE_KEY: 'deny-fixture',
    WEBMCP_PERMIT_PRIVATE_KEY: 'deny-fixture',
    WEBMCP_GATEWAY_TOKEN: 'deny-fixture',
    WEBMCP_RUNNER_SECRET: 'deny-fixture',
    WEBMCP_VAULT_KEY: 'deny-fixture',
    WEBMCP_VAULT_KEY_FILE: 'deny-fixture',
    WEBMCP_VAULT_NEW_KEY: 'deny-fixture',
    WEBMCP_VAULT_NEW_KEY_FILE: 'deny-fixture',
    // Arbitrary worker/hook/callback/orchestration/closure/state selectors.
    WEBMCP_AI_WORKER_CAPABILITY_FILE: 'deny-fixture',
    WEBMCP_AI_CALLBACK_CAPABILITY: 'deny-fixture',
    WEBMCP_AI_ORCHESTRATION_STATE_DIR: 'deny-fixture',
    WEBMCP_AI_HOOK_TOKEN: 'deny-fixture',
    WEBMCP_CLOSURE_STATE: 'deny-fixture',
    WEBMCP_CLOSURE_WORKER: 'deny-fixture',
    WEBMCP_FAKE_SERVER_PASSWORD: 'deny-fixture',
    WEBMCP_CUSTOM_FUTURE_AUTH: 'deny-fixture',
    OPENCODE_SERVER_PASSWORD: 'deny-fixture',
    VAULT_TOKEN: 'deny-fixture',
    VAULT_ADDR: 'deny-fixture',
  }, { OPENCODE_DB: '/tmp/cli.db' });
  assert.equal(env.MY_OPERATOR_VAR, 'kept-fixture');
  assert.equal(env.ANTHROPIC_API_KEY, 'provider-auth-fixture');
  assert.equal(env.OPENAI_API_KEY, 'provider-auth-fixture-2');
  assert.equal(env.OPENCODE_DB, '/tmp/cli.db');
  for (const denied of [
    'WEBMCP_SIGNING_KEY', 'WEBMCP_PRIVATE_KEY', 'WEBMCP_PERMIT_PRIVATE_KEY',
    'WEBMCP_GATEWAY_TOKEN', 'WEBMCP_RUNNER_SECRET', 'WEBMCP_VAULT_KEY',
    'WEBMCP_VAULT_KEY_FILE', 'WEBMCP_VAULT_NEW_KEY', 'WEBMCP_VAULT_NEW_KEY_FILE',
    'WEBMCP_AI_WORKER_CAPABILITY_FILE', 'WEBMCP_AI_CALLBACK_CAPABILITY',
    'WEBMCP_AI_ORCHESTRATION_STATE_DIR', 'WEBMCP_AI_HOOK_TOKEN',
    'WEBMCP_CLOSURE_STATE', 'WEBMCP_CLOSURE_WORKER',
    'WEBMCP_FAKE_SERVER_PASSWORD', 'WEBMCP_CUSTOM_FUTURE_AUTH',
    'OPENCODE_SERVER_PASSWORD', 'VAULT_TOKEN', 'VAULT_ADDR',
  ]) {
    assert.equal(denied in env, false, `${denied} must not reach the child`);
  }
  // No broad TOKEN/KEY denial: provider credentials survive.
  assert.equal('ANTHROPIC_API_KEY' in env, true);
});

test('full child env filtering applies to private invocation env as well', () => {
  const env = buildFullChildEnv(
    { MY_OPERATOR_VAR: 'kept-fixture' },
    {
      OPENCODE_DB: '/tmp/cli.db',
      WEBMCP_GATEWAY_TOKEN: 'deny-fixture',
      WEBMCP_AI_WORKER_CAPABILITY_FILE: 'deny-fixture',
      OPENCODE_SERVER_PASSWORD: 'deny-fixture',
      VAULT_TOKEN: 'deny-fixture',
    },
  );
  assert.equal(env.MY_OPERATOR_VAR, 'kept-fixture');
  assert.equal(env.OPENCODE_DB, '/tmp/cli.db');
  for (const denied of [
    'WEBMCP_GATEWAY_TOKEN', 'WEBMCP_AI_WORKER_CAPABILITY_FILE',
    'OPENCODE_SERVER_PASSWORD', 'VAULT_TOKEN',
  ]) {
    assert.equal(denied in env, false, `${denied} must not reach the child via invocation env`);
  }
});

test('full generate strips WebMCP/server/Vault authority end to end', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-env-'));
  try {
    const result = await generate({
      provider: 'opencode',
      prompt: 'env check',
      workspace: ws,
      accessProfile: 'full',
      env: withV2Db({
        ...process.env,
        OPENCODE_BIN: fakeBin,
        FAKE_PROVIDER: 'opencode',
        FAKE_ECHO_ENV: 'FULL_PASSTHROUGH_PROBE,WEBMCP_GATEWAY_TOKEN,WEBMCP_AI_WORKER_CAPABILITY_FILE,OPENCODE_SERVER_PASSWORD,VAULT_TOKEN,VAULT_ADDR',
        FULL_PASSTHROUGH_PROBE: 'visible-to-child-fixture',
        WEBMCP_GATEWAY_TOKEN: 'deny-fixture',
        WEBMCP_AI_WORKER_CAPABILITY_FILE: 'deny-fixture',
        OPENCODE_SERVER_PASSWORD: 'deny-fixture',
        VAULT_TOKEN: 'deny-fixture',
        VAULT_ADDR: 'deny-fixture',
      }),
    });
    assert.equal(result.ok, true);
    // Non-WebMCP provider fixture passes; authority material is stripped (empty echo).
    assert.match(result.response.text, /FULL_PASSTHROUGH_PROBE=visible-to-child-fixture/);
    assert.match(result.response.text, /WEBMCP_GATEWAY_TOKEN=(;|$)/m);
    assert.match(result.response.text, /WEBMCP_AI_WORKER_CAPABILITY_FILE=(;|$)/m);
    assert.match(result.response.text, /OPENCODE_SERVER_PASSWORD=(;|$)/m);
    assert.match(result.response.text, /VAULT_TOKEN=(;|$)/m);
    assert.match(result.response.text, /VAULT_ADDR=(;|$)/m);
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
      env: withV2Db({
        ...process.env,
        OPENCODE_BIN: fakeBin,
        FAKE_PROVIDER: 'opencode',
        FAKE_ECHO_ENV: 'WEBMCP_AI_BOUNDED_PROBE',
        WEBMCP_AI_BOUNDED_PROBE: 'must-not-arrive',
      }),
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
    const baseEnv = withV2Db({ ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' });
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

// M3: full still validates workspace existence and directory shape.
test('full missing workspace fails closed', async () => {
  const missing = join(tmpdir(), `webmcp-ai-missing-${process.pid}-${Date.now()}-full`);
  assert.throws(
    () => validateCapabilityRequest({ workspace: missing, accessProfile: 'full' }),
    (e) => e.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    generate({
      provider: 'opencode',
      prompt: 'hi',
      workspace: missing,
      accessProfile: 'full',
      env: withV2Db({ ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' }),
    }),
    (e) => e.code === 'INVALID_INPUT',
  );
});

test('full workspace file instead of directory fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'full-filews-'));
  const file = join(dir, 'not-a-dir.txt');
  try {
    writeFileSync(file, 'fixture');
    assert.throws(
      () => validateCapabilityRequest({ workspace: file, accessProfile: 'full' }),
      (e) => e.code === 'INVALID_INPUT',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('full still rejects broad filesystem roots', () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-broad-'));
  try {
    assert.throws(
      () => validateCapabilityRequest({ workspace: '/', accessProfile: 'full' }),
      (e) => e.code === 'INVALID_INPUT',
    );
    assert.throws(
      () => validateCapabilityRequest({ workspace: '/tmp', accessProfile: 'full' }),
      (e) => e.code === 'INVALID_INPUT',
    );
    assert.throws(
      () => validateCapabilityRequest({ workspace: ws, accessProfile: 'full', allowedReadRoots: ['/'] }),
      (e) => e.code === 'INVALID_INPUT',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('full still rejects relative paths', () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-relative-'));
  try {
    assert.throws(
      () => validateCapabilityRequest({ workspace: 'relative/path', accessProfile: 'full' }),
      (e) => e.code === 'INVALID_INPUT',
    );
    assert.throws(
      () => validateCapabilityRequest({ workspace: ws, accessProfile: 'full', allowedReadRoots: ['relative/root'] }),
      (e) => e.code === 'INVALID_INPUT',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('full still rejects dot-dot segments', () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-dotdot-'));
  try {
    assert.throws(
      () => validateCapabilityRequest({ workspace: '/a/../b', accessProfile: 'full' }),
      (e) => e.code === 'INVALID_INPUT',
    );
    assert.throws(
      () => validateCapabilityRequest({ workspace: `${ws}/../escape`, accessProfile: 'full' }),
      (e) => e.code === 'INVALID_INPUT',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('full still rejects null bytes', () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-null-'));
  try {
    assert.throws(
      () => validateCapabilityRequest({ workspace: `${ws}/a\0b`, accessProfile: 'full' }),
      (e) => e.code === 'INVALID_INPUT',
    );
    assert.throws(
      () => validateCapabilityRequest({ workspace: ws, accessProfile: 'full', allowedReadRoots: [`${ws}/x\0y`] }),
      (e) => e.code === 'INVALID_INPUT',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('full still rejects symlink workspace and symlink roots', () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-symlink-'));
  try {
    const real = join(ws, 'real');
    mkdirSync(real);
    const link = join(ws, 'link');
    symlinkSync(real, link);
    assert.throws(
      () => validateCapabilityRequest({ workspace: link, accessProfile: 'full' }),
      (e) => e.code === 'INVALID_INPUT' && /symlink/.test(e.message),
    );
    assert.throws(
      () => validateCapabilityRequest({ workspace: ws, accessProfile: 'full', allowedReadRoots: [join(link, 'file')] }),
      (e) => e.code === 'INVALID_INPUT' && /symlink/.test(e.message),
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// M3: full metadata carries digests only — no paths, prompt text, or secrets.
test('full metadata carries digests only, no paths or secrets', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-meta-'));
  const readRoot = join(ws, 'src');
  try {
    mkdirSync(readRoot);
    const result = await handleToolCall({
      protocol: TOOL_PROTOCOL,
      requestId: 'full-meta-1',
      tool: 'ai.generate',
      input: {
        provider: 'opencode',
        prompt: 'full metadata secret prompt must not appear in metadata',
        accessProfile: 'full',
        workspace: ws,
        allowedReadRoots: [readRoot],
        projectId: 'proj-full-123',
        storeRevisions: { automation: 'sha256:aaa' },
      },
    }, {
      env: withV2Db({
        ...process.env,
        OPENCODE_BIN: fakeBin,
        FAKE_PROVIDER: 'opencode',
        GITHUB_TOKEN: 'fixture-secret-must-not-leak',
        WEBMCP_GATEWAY_TOKEN: 'fixture-authority-must-not-leak',
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.metadata.capability.accessProfile, 'full');
    assert.equal(result.metadata.capability.fullPassthrough, true);
    assert.match(result.metadata.capability.workspaceDigest, /^[0-9a-f]{16}$/);
    assert.match(result.metadata.capability.readRootsDigest, /^[0-9a-f]{16}$/);
    const metaStr = JSON.stringify(result.metadata);
    assert.equal(metaStr.includes(ws), false, 'metadata must not leak absolute workspace path');
    assert.equal(metaStr.includes(readRoot), false, 'metadata must not leak read root');
    assert.equal(metaStr.includes('full metadata secret prompt'), false, 'metadata must not leak prompt text');
    assert.equal(metaStr.includes('fixture-secret-must-not-leak'), false, 'metadata must not leak secrets');
    assert.equal(metaStr.includes('fixture-authority-must-not-leak'), false);
    assert.equal(result.output.text.includes(ws), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// M3: full provider failure stays typed and output cap is enforced.
test('full provider failure stays typed without leaking stderr secrets', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-fail-'));
  try {
    await assert.rejects(
      generate({
        provider: 'opencode',
        prompt: 'hi',
        workspace: ws,
        accessProfile: 'full',
        env: withV2Db({
          ...process.env,
          OPENCODE_BIN: fakeBin,
          FAKE_PROVIDER: 'opencode',
          FAKE_EXIT_CODE: '7',
        }),
      }),
      (e) => {
        assert.equal(e.code, 'PROVIDER_EXIT_ERROR');
        assert.equal(e.details?.exitCode, 7);
        assert.doesNotMatch(e.message, /redact-me/);
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('full output cap is enforced', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-cap-'));
  try {
    await assert.rejects(
      generate({
        provider: 'opencode',
        prompt: 'hi',
        workspace: ws,
        accessProfile: 'full',
        maxOutputBytes: 1,
        env: withV2Db({ ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' }),
      }),
      (e) => e.code === 'PROVIDER_OUTPUT_LIMIT',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('bounded profiles stay fail-closed', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-bounded-closed-'));
  try {
    assert.throws(
      () => validateCapabilityRequest({ workspace: ws, accessProfile: 'bounded-edit', allowedWriteRoots: [] }),
      (e) => e.code === 'INVALID_INPUT',
    );
    assert.throws(
      () => validateCapabilityRequest({ workspace: ws, accessProfile: 'gateway-tool' }),
      (e) => e.code === 'UNSUPPORTED_CAPABILITY',
    );
    assert.throws(
      () => validateCapabilityRequest({ workspace: ws, accessProfile: 'compose-only' }),
      (e) => e.code === 'INVALID_INPUT',
    );
    await assert.rejects(
      generate({
        provider: 'opencode',
        prompt: 'x',
        workspace: ws,
        accessProfile: 'bounded-edit',
        allowedWriteRoots: [],
        env: withV2Db({ ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' }),
      }),
      (e) => e.code === 'INVALID_INPUT',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// L1: boolean `full` input behavior is intentional and consistent.
// CLI --input-json { full: true } maps to accessProfile full (CLI-only alias);
// the webmcp-tool-v1 protocol keeps canonical accessProfile: full and rejects
// a top-level `full` field fail-closed.
test('tool-call rejects top-level full field and keeps canonical accessProfile', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-proto-'));
  try {
    const tools = describeTools();
    assert.equal('full' in tools.tools[0].inputSchema.properties, false);
    await assert.rejects(
      handleToolCall({
        protocol: TOOL_PROTOCOL,
        requestId: 'full-alias-1',
        tool: 'ai.generate',
        input: { provider: 'opencode', prompt: 'x', workspace: ws, full: true },
      }, { env: withV2Db({ ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' }) }),
      (e) => e.code === 'INVALID_INPUT' && /unknown input field: full/.test(e.message),
    );
    const ok = await handleToolCall({
      protocol: TOOL_PROTOCOL,
      requestId: 'full-canonical-1',
      tool: 'ai.generate',
      input: { provider: 'opencode', prompt: 'x', workspace: ws, accessProfile: 'full' },
    }, { env: withV2Db({ ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' }) });
    assert.equal(ok.ok, true);
    assert.equal(ok.metadata.capability.accessProfile, 'full');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('CLI input-json full:true maps to full while full:false does not', () => {
  const ws = mkdtempSync(join(tmpdir(), 'full-cli-alias-'));
  try {
    const withTrue = spawnSync(process.execPath, [bin, 'generate', '--input-json', '-', '--json'], {
      input: JSON.stringify({ provider: 'opencode', prompt: 'hi', workspace: ws, full: true }),
      encoding: 'utf8',
      env: withV2Db({ ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' }),
    });
    assert.equal(withTrue.status, 0, withTrue.stderr);
    assert.equal(JSON.parse(withTrue.stdout).capability.accessProfile, 'full');

    const withFalse = spawnSync(process.execPath, [bin, 'generate', '--input-json', '-', '--json'], {
      input: JSON.stringify({ provider: 'opencode', prompt: 'hi', workspace: ws, full: false }),
      encoding: 'utf8',
      env: withV2Db({ ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' }),
    });
    assert.equal(withFalse.status, 0, withFalse.stderr);
    assert.notEqual(JSON.parse(withFalse.stdout).capability.accessProfile, 'full');

    const withFlag = spawnSync(process.execPath, [bin, 'generate', '--provider', 'opencode', '--prompt', 'hi', '--workspace', ws, '--full', '--json'], {
      encoding: 'utf8',
      env: withV2Db({ ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode' }),
    });
    assert.equal(withFlag.status, 0, withFlag.stderr);
    assert.equal(JSON.parse(withFlag.stdout).capability.accessProfile, 'full');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
