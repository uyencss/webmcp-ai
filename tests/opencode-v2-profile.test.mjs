import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  OPENCODE_V2_REVIEW_REQUIRED_FLAGS,
  normalizeOpencodeProfile,
  opencodeProfileForVersion,
  parseOpencodeVersion,
  validateOpencodeReviewSupport,
} from '../src/providers/opencode.mjs';
import { buildOpenCodeConfig } from '../src/capabilities.mjs';
import { generate } from '../src/client.mjs';

const bin = fileURLToPath(new URL('../bin/webmcp-ai.mjs', import.meta.url));
const fakeBin = fileURLToPath(new URL('./fixtures/fake-ai-cli.mjs', import.meta.url));

const V1_HELP = 'opencode run --format json --agent build --dir /ws --model sonnet --variant effort';
const V2_HELP = 'opencode run --standalone --format json --agent build --model sonnet#effort';

// ---- version parsing and profile mapping ----

test('opencode version parsing maps only major 1/2 to a profile', () => {
  assert.deepEqual(parseOpencodeVersion('opencode v2.0.1'), { major: 2, minor: 0, patch: 1, raw: '2.0.1' });
  assert.deepEqual(parseOpencodeVersion('1.18.30\n'), { major: 1, minor: 18, patch: 30, raw: '1.18.30' });
  assert.equal(parseOpencodeVersion('opencode-cli'), null);
  assert.equal(parseOpencodeVersion(''), null);

  assert.equal(opencodeProfileForVersion('opencode v2.0.1'), 'v2');
  assert.equal(opencodeProfileForVersion('1.18.30'), 'v1');
  assert.equal(opencodeProfileForVersion('2.1.0-beta.3'), 'v2');
  assert.equal(opencodeProfileForVersion('9.9.9'), null);
  assert.equal(opencodeProfileForVersion('no version here'), null);
});

test('normalizeOpencodeProfile keeps legacy default and fails closed on unknown', () => {
  assert.equal(normalizeOpencodeProfile(undefined), 'v1');
  assert.equal(normalizeOpencodeProfile(null), 'v1');
  assert.equal(normalizeOpencodeProfile('v1'), 'v1');
  assert.equal(normalizeOpencodeProfile('v2'), 'v2');
  assert.throws(
    () => normalizeOpencodeProfile('v3'),
    (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT' && e.details?.profile === 'v3' && !JSON.stringify(e).includes('v3.1'),
  );
});

// ---- validators: profile-specific required flags ----

test('opencode review validator uses profile-specific flags and typed drift', () => {
  assert.ok(validateOpencodeReviewSupport(V1_HELP));
  assert.ok(validateOpencodeReviewSupport(V1_HELP, { profile: 'v1' }));
  assert.ok(validateOpencodeReviewSupport(V2_HELP, { profile: 'v2' }));

  // v2 help lacks the v1-only flags: v1 profile must fail closed.
  assert.throws(
    () => validateOpencodeReviewSupport(V2_HELP, { profile: 'v1' }),
    (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT'
      && e.details?.profile === 'v1'
      && e.details?.missing?.includes('--dir')
      && e.details?.missing?.includes('--variant'),
  );
  // drifted/v2 help without the portable reviewer flags must fail.
  assert.throws(
    () => validateOpencodeReviewSupport('opencode run only', { profile: 'v2' }),
    (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT'
      && e.details?.profile === 'v2'
      && e.details?.missing?.length > 0,
  );
  assert.deepEqual([...OPENCODE_V2_REVIEW_REQUIRED_FLAGS], ['run', '--standalone', '--format', '--agent', '--model']);
  // no raw help or paths leak into the typed error
  const leaky = `${V2_HELP} --file /tmp/secret.txt`;
  try {
    validateOpencodeReviewSupport('opencode --help nope', { profile: 'v2' });
    assert.fail('expected drift');
  } catch (e) {
    assert.equal(JSON.stringify(e).includes('/tmp/secret.txt'), false);
    assert.equal(JSON.stringify(e).includes(leaky), false);
  }
});

// ---- config builder: v1 unchanged, v2 schema ----

test('buildOpenCodeConfig keeps v1 output and emits v2 ordered permissions', () => {
  const ws = '/workspace/project';
  const v1 = buildOpenCodeConfig({
    accessProfile: 'review-readonly', workspace: ws, allowedReadRoots: ['/refs/lib'], allowedWriteRoots: [], protectedPaths: [],
  });
  assert.ok(v1.permission && typeof v1.permission === 'object');
  assert.ok(Array.isArray(v1.external_directory));
  assert.equal(v1.permissions, undefined);
  assert.equal(v1.share, 'disabled');
  assert.equal(v1.autoupdate, false);

  const v2 = buildOpenCodeConfig({
    accessProfile: 'review-readonly', workspace: ws, allowedReadRoots: ['/refs/lib'], allowedWriteRoots: [], protectedPaths: [], profile: 'v2',
  });
  assert.equal(v2.permission, undefined, 'v2 must not use the v1 permission field');
  assert.equal(v2.external_directory, undefined, 'v2 must not use the v1 external_directory field');
  assert.equal(v2.autoupdate, undefined);
  assert.ok(Array.isArray(v2.permissions));
  assert.deepEqual(v2.permissions[0], { action: '*', resource: '*', effect: 'deny' });
  assert.ok(v2.permissions.some((r) => r.action === 'read' && r.effect === 'allow'));
  assert.ok(v2.permissions.some((r) => r.action === 'external_directory' && r.resource === ws && r.effect === 'allow'));
  assert.ok(v2.permissions.some((r) => r.action === 'external_directory' && r.resource === `${ws}/*` && r.effect === 'allow'));
  assert.ok(v2.permissions.some((r) => r.action === 'external_directory' && r.resource === '/refs/lib' && r.effect === 'allow'));
  assert.equal(v2.permissions.some((r) => r.resource === '/**' || r.resource === '**'), false);
  assert.deepEqual(v2.mcp, { servers: {} });
  assert.deepEqual(v2.plugins, []);
  assert.equal(v2.update, 'disable');
  // No edit/write allow anywhere on the read-only profile.
  assert.equal(v2.permissions.some((r) => r.action === 'edit' && r.effect === 'allow'), false);

  const compose = buildOpenCodeConfig({ accessProfile: 'compose-only', workspace: ws, allowedReadRoots: [], allowedWriteRoots: [], protectedPaths: [], profile: 'v2' });
  assert.deepEqual(compose.permissions, [{ action: '*', resource: '*', effect: 'deny' }]);

  const bounded = buildOpenCodeConfig({
    accessProfile: 'bounded-edit', workspace: ws, allowedReadRoots: [], allowedWriteRoots: ['/workspace/project/src'], protectedPaths: ['/workspace/project/src/locked'], profile: 'v2',
  });
  const allowIdx = bounded.permissions.findIndex((r) => r.action === 'edit' && r.effect === 'allow');
  const denyIdx = bounded.permissions.findIndex((r) => r.action === 'edit' && r.effect === 'deny');
  assert.ok(allowIdx >= 0, 'bounded write root must be allowed');
  assert.ok(denyIdx > allowIdx, 'protected deny must come after the allow (later rule wins)');

  assert.throws(
    () => buildOpenCodeConfig({ accessProfile: 'review-readonly', workspace: ws, profile: 'v9' }),
    (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT',
  );
});

// ---- argv builders: v1 byte-parity, v2 folded variant and no --dir ----

test('opencode legacy and review argv follow the resolved profile', async () => {
  const { getProvider } = await import('../src/providers/index.mjs');
  const provider = getProvider('opencode');
  const ws = '/workspace/project';

  const v1 = provider.buildInvocation({
    prompt: 'x', workspace: ws, accessProfile: 'provider-default', agentMode: 'accept-edits',
    model: 'opencode-go/muse-spark-1.3-contributor', effort: 'xhigh', env: {},
  });
  try {
    assert.ok(v1.args.includes('--variant'));
    assert.equal(v1.args[v1.args.indexOf('--variant') + 1], 'xhigh');
    assert.ok(v1.args.includes('--dir'));
    assert.equal(v1.args[v1.args.indexOf('--dir') + 1], ws);
    assert.equal(v1.args.includes('--standalone'), false);
  } finally { v1.cleanup?.(); }

  const v2 = provider.buildInvocation({
    prompt: 'x', workspace: ws, accessProfile: 'provider-default', agentMode: 'accept-edits',
    model: 'opencode-go/muse-spark-1.3-contributor', effort: 'xhigh', env: {}, opencodeProfile: 'v2',
  });
  try {
    assert.equal(v2.args.includes('--variant'), false);
    assert.equal(v2.args.includes('--dir'), false);
    assert.ok(v2.args.includes('--standalone'));
    assert.equal(v2.args[v2.args.indexOf('--model') + 1], 'opencode-go/muse-spark-1.3-contributor#xhigh');
  } finally { v2.cleanup?.(); }

  const reviewV2 = provider.buildInvocation({
    prompt: 'x', workspace: ws, taskIntent: 'review', accessProfile: 'review-readonly',
    model: 'opencode-go/muse-spark-1.3-contributor', effort: 'xhigh', env: {},
    opencodeHelpText: V2_HELP, opencodeProfile: 'v2',
  });
  try {
    assert.equal(reviewV2.args.includes('--dir'), false);
    assert.equal(reviewV2.args.includes('--variant'), false);
    assert.ok(reviewV2.args.includes('--standalone'));
    assert.equal(reviewV2.args[reviewV2.args.indexOf('--model') + 1], 'opencode-go/muse-spark-1.3-contributor#xhigh');
    const cfg = JSON.parse(reviewV2.env.OPENCODE_CONFIG_CONTENT);
    assert.ok(Array.isArray(cfg.permissions));
    assert.equal(cfg.permission, undefined);
  } finally { reviewV2.cleanup?.(); }

  // v2 effort without a model cannot be encoded: fail closed.
  assert.throws(
    () => provider.buildInvocation({
      prompt: 'x', workspace: ws, accessProfile: 'full', agentMode: 'accept-edits', effort: 'high', env: {}, opencodeProfile: 'v2',
    }),
    (e) => e.code === 'INVALID_INPUT',
  );

  // Unknown profile never falls back to v1 argv.
  assert.throws(
    () => provider.buildInvocation({
      prompt: 'x', workspace: ws, accessProfile: 'full', agentMode: 'accept-edits', env: {}, opencodeProfile: 'v9',
    }),
    (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT',
  );
});

// ---- v2 config schema isolation: no v1-field leftovers on any v2 lane ----

test('opencode v2 invocations emit only the v2 config schema (no v1 leftovers)', async () => {
  const { getProvider } = await import('../src/providers/index.mjs');
  const provider = getProvider('opencode');
  const ws = '/workspace/project';
  const cases = [
    {
      name: 'legacy-accept-edits',
      req: { prompt: 'x', workspace: ws, accessProfile: 'provider-default', agentMode: 'accept-edits', model: 'm', effort: 'high', env: {}, opencodeProfile: 'v2' },
      expectEditAllow: true,
    },
    {
      name: 'review',
      req: { prompt: 'x', workspace: ws, taskIntent: 'review', accessProfile: 'review-readonly', model: 'm', env: {}, opencodeHelpText: V2_HELP, opencodeProfile: 'v2' },
      expectEditAllow: false,
    },
    {
      name: 'implement-bounded',
      req: { prompt: 'x', workspace: ws, taskIntent: 'implement', accessProfile: 'bounded-edit', allowedWriteRoots: [`${ws}/src`], model: 'm', env: {}, opencodeProfile: 'v2' },
      expectEditAllow: true,
    },
    {
      name: 'compose',
      req: { prompt: 'x', workspace: ws, taskIntent: 'compose', accessProfile: 'compose-only', model: 'm', env: {}, opencodeProfile: 'v2' },
      expectEditAllow: false,
    },
  ];
  for (const c of cases) {
    const invocation = provider.buildInvocation(c.req);
    try {
      const cfg = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT);
      assert.equal(cfg.permission, undefined, `${c.name}: must not carry the v1 permission field`);
      assert.equal(cfg.external_directory, undefined, `${c.name}: must not carry v1 external_directory`);
      assert.equal(cfg.autoupdate, undefined, `${c.name}: must not carry v1 autoupdate`);
      assert.equal(cfg.mdns, undefined, `${c.name}: must not carry v1 mdns`);
      assert.equal(cfg.cors, undefined, `${c.name}: must not carry v1 cors`);
      assert.equal(cfg.plugin, undefined, `${c.name}: must not carry the v1 plugin field`);
      assert.deepEqual(cfg.mcp, { servers: {} }, `${c.name}: v2 mcp.servers`);
      assert.ok(Array.isArray(cfg.permissions), `${c.name}: v2 permissions array`);
      assert.ok(Array.isArray(cfg.plugins), `${c.name}: v2 plugins array`);
      assert.equal(cfg.update, 'disable', `${c.name}: v2 update disabled`);
      const hasEditAllow = cfg.permissions.some((r) => r.action === 'edit' && r.effect === 'allow');
      assert.equal(hasEditAllow, c.expectEditAllow, `${c.name}: edit-allow expectation`);
      if (c.name === 'legacy-accept-edits') {
        const shellDeny = cfg.permissions.filter((r) => r.action === 'shell' && r.effect === 'deny').map((r) => r.resource);
        assert.ok(shellDeny.includes('rm *') && shellDeny.includes('git push *'), 'supervised-edit shell deny-list preserved');
        const shellAllow = cfg.permissions.findIndex((r) => r.action === 'shell' && r.effect === 'allow');
        const rmDeny = cfg.permissions.findIndex((r) => r.action === 'shell' && r.resource === 'rm *' && r.effect === 'deny');
        assert.ok(shellAllow >= 0 && rmDeny > shellAllow, 'deny rules must come after the shell allow');
      }
    } finally {
      invocation.cleanup?.();
    }
  }
});

// ---- end-to-end through generate(): probe, argv, fail-closed drift ----

test('generate detects the v2 profile, drops --dir, and folds effort', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'v2-profile-ws-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const baseEnv = {
    ...process.env,
    OPENCODE_BIN: fakeBin,
    FAKE_PROVIDER: 'opencode',
    FAKE_VERSION: '2.0.1',
    FAKE_ECHO_ARGS: '1',
  };
  const ok = await generate({
    provider: 'opencode', prompt: 'hello v2', accessProfile: 'provider-default', agentMode: 'accept-edits',
    workspace: ws, model: 'opencode-go/muse-spark-1.3-contributor', effort: 'xhigh',
    env: baseEnv,
  });
  assert.equal(ok.ok, true);
  assert.match(ok.response.text, /\|args:/);
  const args = ok.response.text.split('|args:')[1];
  assert.ok(args.includes('--standalone'), args);
  assert.ok(args.includes('--model opencode-go/muse-spark-1.3-contributor#xhigh'), args);
  assert.equal(args.includes('--variant'), false, args);
  assert.equal(args.includes('--dir'), false, args);
});

test('generate fails closed on an unrecognized opencode version', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'v2-drift-ws-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  await assert.rejects(
    generate({
      provider: 'opencode', prompt: 'hello', workspace: ws,
      env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode', FAKE_VERSION: '9.9.9' },
    }),
    (e) => e.code === 'PROVIDER_CAPABILITY_DRIFT' && !JSON.stringify(e).includes(fakeBin),
  );
});

test('generate keeps v1 argv on the v1 profile and honors an explicit override', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'v1-profile-ws-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const v1 = await generate({
    provider: 'opencode', prompt: 'hello v1', accessProfile: 'provider-default', agentMode: 'accept-edits',
    workspace: ws, model: 'muse', effort: 'xhigh',
    env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode', FAKE_VERSION: '1.18.30', FAKE_ECHO_ARGS: '1' },
  });
  const v1Args = v1.response.text.split('|args:')[1];
  assert.ok(v1Args.includes('--dir'), v1Args);
  assert.ok(v1Args.includes('--variant xhigh'), v1Args);
  assert.equal(v1Args.includes('--standalone'), false);

  // Explicit profile skips the version probe: v2 version + explicit v1 keeps v1 argv.
  const forced = await generate({
    provider: 'opencode', prompt: 'forced', accessProfile: 'provider-default', agentMode: 'accept-edits',
    workspace: ws, model: 'muse', effort: 'high', opencodeProfile: 'v1',
    env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode', FAKE_VERSION: '9.9.9', FAKE_ECHO_ARGS: '1' },
  });
  const forcedArgs = forced.response.text.split('|args:')[1];
  assert.ok(forcedArgs.includes('--dir'), forcedArgs);
  assert.ok(forcedArgs.includes('--variant high'), forcedArgs);
  // NB: explicit profile skips the version probe entirely (FAKE_VERSION=9.9.9 would drift).
});

// ---- providers inspect: version-aware mapping ----

test('providers inspect opencode reports the detected profile', () => {
  const good = spawnSync(process.execPath, [bin, 'providers', 'inspect', 'opencode', '--task-intent', 'review', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode', FAKE_VERSION: '2.0.1' },
  });
  assert.equal(good.status, 0, good.stderr);
  const g = JSON.parse(good.stdout);
  assert.equal(g.ok, true);
  assert.equal(g.taskReady, true);
  assert.equal(g.supported, true);
  assert.equal(g.mapping?.profile, 'v2');
  assert.equal(JSON.stringify(g).includes(fakeBin), false);

  const v1 = spawnSync(process.execPath, [bin, 'providers', 'inspect', 'opencode', '--task-intent', 'review', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode', FAKE_VERSION: '1.18.30' },
  });
  assert.equal(v1.status, 0, v1.stderr);
  assert.equal(JSON.parse(v1.stdout).mapping?.profile, 'v1');

  const unknown = spawnSync(process.execPath, [bin, 'providers', 'inspect', 'opencode', '--task-intent', 'review', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, OPENCODE_BIN: fakeBin, FAKE_PROVIDER: 'opencode', FAKE_VERSION: '9.9.9' },
  });
  assert.equal(unknown.status, 0, unknown.stderr);
  const u = JSON.parse(unknown.stdout);
  assert.equal(u.taskReady, false);
  assert.equal(u.supported, false);
  assert.equal(u.code, 'PROVIDER_CAPABILITY_DRIFT');
  assert.equal(u.mapping?.profile, null);
});
