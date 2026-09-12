// Drift lock: provider-declared capability matrix must match the runtime
// gates. `describeGenerateDryRun` reuses the exact normalizeRequest +
// provider.buildInvocation path without spawning, so a declaration that no
// longer matches the gates fails here instead of silently misleading a
// caller. Inspect declared responses are exercised through the real CLI.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { describeGenerateDryRun, generate } from '../src/client.mjs';
import { listProviders } from '../src/providers/index.mjs';

const bin = fileURLToPath(new URL('../bin/webmcp-ai.mjs', import.meta.url));
const fakeBin = fileURLToPath(new URL('./fixtures/fake-ai-cli.mjs', import.meta.url));
chmodSync(fakeBin, 0o755);

const PROVIDERS = ['agy', 'claude', 'codex', 'opencode'];
const INTENTS = ['review', 'compose', 'implement', 'plan'];
// The drift lock must not trust the declaration it is verifying. It walks
// the complete portable cross-product per provider×intent (plus a bogus
// profile/mode) and compares the runtime-accepted set with the declaration,
// asserting the typed runtime contract for every rejection.
const ALL_PROFILES = ['compose-only', 'review-readonly', 'bounded-edit', 'full'];
const ALLOWED_PROFILES = {
  compose: ['compose-only'],
  review: ['review-readonly'],
  implement: ['bounded-edit', 'full'],
  plan: ['review-readonly'],
};
const DEFAULT_PROFILE = { review: 'review-readonly', compose: 'compose-only', plan: 'review-readonly' };
const ALL_AGENT_MODES = ['plan', 'accept-edits'];
const AGENT_MODE_CAPABLE = new Set(['agy', 'opencode']);
const BOGUS_PROFILE = 'bogus-profile';
const BOGUS_AGENT_MODE = 'bogus-mode';
const RUNTIME_REJECTIONS = ['UNSUPPORTED_CAPABILITY', 'TASK_INTENT_ACCESS_CONFLICT', 'INVALID_INPUT'];
// Independent oracle for the public metadata strings. These are part of the
// discovery contract (callers display them), so an arbitrary rewrite must fail
// the lock; update the adapter and this oracle in the same change.
const EXPECTED_AGENT_MODE_VALUES = {
  agy: ['plan', 'accept-edits'],
  opencode: ['plan', 'accept-edits'],
};
const EXPECTED_INTENT_ARRAYS = {
  claude: { implement: ['full'] },
  codex: { implement: ['full'] },
  opencode: { implement: ['bounded-edit', 'full'] },
};
const EXPECTED_INTENT_SINGULAR_PROFILES = {
  claude: { review: 'review-readonly', compose: 'compose-only' },
  codex: { review: 'review-readonly', compose: 'compose-only' },
  opencode: { review: 'review-readonly', compose: 'compose-only' },
};
const EXPECTED_AGENT_MODE_REASON = {
  claude: 'Claude does not support AGY agentMode',
  codex: 'Codex does not support AGY agentMode',
};
// Exact public key sets: missing-vs-null and extra properties must fail.
const EXPECTED_AGENT_MODE_KEYS = {
  agy: ['supported', 'values', 'default'],
  opencode: ['supported', 'values', 'default'],
  claude: ['supported', 'values', 'default', 'reason'],
  codex: ['supported', 'values', 'default', 'reason'],
};
const EXPECTED_INTENT_KEYS = {
  agy: {
    review: ['supported', 'reason'],
    compose: ['supported', 'reason'],
    implement: ['supported', 'reason'],
    plan: ['supported', 'reason'],
  },
  claude: {
    review: ['supported', 'accessProfile', 'probe'],
    compose: ['supported', 'accessProfile'],
    implement: ['supported', 'accessProfiles'],
    plan: ['supported', 'reason'],
  },
  codex: {
    review: ['supported', 'accessProfile', 'probe'],
    compose: ['supported', 'accessProfile'],
    implement: ['supported', 'accessProfiles', 'note'],
    plan: ['supported', 'reason'],
  },
  opencode: {
    review: ['supported', 'accessProfile', 'probe'],
    compose: ['supported', 'accessProfile'],
    implement: ['supported', 'accessProfiles'],
    plan: ['supported', 'reason'],
  },
};
const EXPECTED_INTENT_METADATA = {
  agy: {
    review: { reason: 'AGY does not support preventive deny-write review mode' },
    compose: { reason: 'AGY vNext compose is not deny-write provable; legacy toolPolicy compose-only remains supported' },
    implement: { reason: 'AGY does not support preventive deny-write review mode' },
    plan: { reason: 'AGY does not support preventive deny-write review mode; plan additionally needs a separate webmcp-ai-plan-result/1 contract' },
  },
  claude: {
    review: { probe: 'help' },
    plan: { reason: 'requires a separate webmcp-ai-plan-result/1 contract' },
  },
  codex: {
    review: { probe: 'help' },
    implement: { note: 'bounded-edit is unsupported; use full' },
    plan: { reason: 'requires a separate webmcp-ai-plan-result/1 contract' },
  },
  opencode: {
    review: { probe: 'help' },
    plan: { reason: 'requires a separate webmcp-ai-plan-result/1 contract' },
  },
};

function run(args, envOverrides = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    cwd: '/tmp',
    env: {
      ...process.env,
      AGY_BIN: fakeBin,
      CLAUDE_BIN: fakeBin,
      CODEX_BIN: fakeBin,
      OPENCODE_BIN: fakeBin,
      ...envOverrides,
    },
  });
}

function intentInput(meta, intent, profile, workspace) {
  const input = {
    provider: meta.id,
    prompt: 'capability matrix probe',
    taskIntent: intent,
  };
  if (profile !== undefined) input.accessProfile = profile;
  // compose-only uses a disposable workspace and rejects an explicit one.
  // An omitted profile resolves to the portable default, so use the effective
  // profile to decide whether a workspace may be supplied.
  const effective = profile ?? DEFAULT_PROFILE[intent];
  if (effective !== 'compose-only') input.workspace = workspace;
  if (effective === 'bounded-edit') input.allowedWriteRoots = [join(workspace, 'src')];
  return input;
}

// Classify a dry-run without swallowing the error type: a wrong typed error
// must fail the test, not silently count as "unsupported".
function classifyDryRun(input) {
  try {
    const result = describeGenerateDryRun(input);
    return { outcome: 'ok', args: result.args };
  } catch (error) {
    return { outcome: 'error', code: error?.code ?? 'UNKNOWN' };
  }
}

// Race-free leak check: run the probe under a private TMPDIR so only
// directories created by this test can appear, then assert that no
// webmcp-ai-* artifact remains. File-level test parallelism cannot interfere.
async function withPrivateTmp(probe) {
  const privateTmp = mkdtempSync(join(tmpdir(), 'webmcp-ai-leak-check-'));
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = privateTmp;
  try {
    await probe();
    assert.deepEqual(
      readdirSync(privateTmp).filter((name) => name.startsWith('webmcp-ai-')),
      [],
      'leaked temp artifacts under the private TMPDIR',
    );
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    rmSync(privateTmp, { recursive: true, force: true });
  }
}

// Runtime-accepted set for one provider×intent over the complete portable
// profile cross-product, independent of the declaration under test. Also
// asserts the typed runtime contract: incompatible profile =>
// TASK_INTENT_ACCESS_CONFLICT, bogus profile => INVALID_INPUT, and an allowed
// profile is either accepted or fails with UNSUPPORTED_CAPABILITY.
function acceptedProfiles(meta, intent, workspace) {
  const accepted = [];
  for (const profile of [...ALL_PROFILES, BOGUS_PROFILE]) {
    const result = classifyDryRun(intentInput(meta, intent, profile, workspace));
    if (result.outcome === 'ok') {
      accepted.push(profile);
      assert.ok(
        profile !== BOGUS_PROFILE && ALLOWED_PROFILES[intent].includes(profile),
        `${meta.id}.${intent}.${profile} accepted but not in the portable allowlist`,
      );
      continue;
    }
    assert.ok(RUNTIME_REJECTIONS.includes(result.code), `${meta.id}.${intent}.${profile} unexpected error ${result.code}`);
    if (profile === BOGUS_PROFILE) {
      assert.equal(result.code, 'INVALID_INPUT', `${meta.id}.${intent}.${profile} code`);
    } else if (!ALLOWED_PROFILES[intent].includes(profile)) {
      assert.equal(result.code, 'TASK_INTENT_ACCESS_CONFLICT', `${meta.id}.${intent}.${profile} code`);
    } else {
      assert.equal(result.code, 'UNSUPPORTED_CAPABILITY', `${meta.id}.${intent}.${profile} code`);
    }
  }
  return accepted.sort();
}

function declaredProfiles(declared) {
  if (declared.accessProfile) return [declared.accessProfile];
  return [...(declared.accessProfiles ?? [])];
}

test('every provider declares agentModes plus all four taskIntents', () => {
  assert.deepEqual(listProviders().map((provider) => provider.id), PROVIDERS);
  for (const meta of listProviders()) {
    const modes = meta.capabilities.agentModes;
    assert.ok(modes, `${meta.id} is missing agentModes`);
    assert.deepEqual(Object.keys(modes), EXPECTED_AGENT_MODE_KEYS[meta.id], `${meta.id}.agentModes exact keys`);
    assert.equal(typeof modes.supported, 'boolean', `${meta.id}.agentModes.supported`);
    assert.deepEqual(
      modes.values,
      EXPECTED_AGENT_MODE_VALUES[meta.id] ?? [],
      `${meta.id}.agentModes.values exact order`,
    );
    // Absence is part of the contract too: a reason on a supported provider
    // (or a missing one) must fail.
    assert.equal(modes.reason ?? null, EXPECTED_AGENT_MODE_REASON[meta.id] ?? null, `${meta.id}.agentModes.reason`);
    const intents = meta.capabilities.taskIntents;
    assert.ok(intents, `${meta.id} is missing taskIntents`);
    assert.deepEqual(Object.keys(intents), INTENTS, `${meta.id} taskIntent keys exact order`);
    for (const intent of INTENTS) {
      assert.deepEqual(
        Object.keys(intents[intent]),
        EXPECTED_INTENT_KEYS[meta.id][intent],
        `${meta.id}.${intent} exact keys`,
      );
      assert.equal(typeof intents[intent].supported, 'boolean', `${meta.id}.${intent}.supported`);
      assert.deepEqual(
        intents[intent].accessProfiles ?? null,
        EXPECTED_INTENT_ARRAYS[meta.id]?.[intent] ?? null,
        `${meta.id}.${intent} accessProfiles exact order`,
      );
      assert.equal(
        intents[intent].accessProfile ?? null,
        EXPECTED_INTENT_SINGULAR_PROFILES[meta.id]?.[intent] ?? null,
        `${meta.id}.${intent} accessProfile`,
      );
      const expectedMeta = EXPECTED_INTENT_METADATA[meta.id]?.[intent] ?? {};
      assert.deepEqual(
        {
          reason: intents[intent].reason ?? null,
          note: intents[intent].note ?? null,
          probe: intents[intent].probe ?? null,
        },
        {
          reason: expectedMeta.reason ?? null,
          note: expectedMeta.note ?? null,
          probe: expectedMeta.probe ?? null,
        },
        `${meta.id}.${intent} metadata`,
      );
    }
  }
});

test('declared taskIntents match every runtime-accepted profile', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'webmcp-ai-matrix-'));
  try {
    for (const meta of listProviders()) {
      for (const intent of INTENTS) {
        const declared = meta.capabilities.taskIntents[intent];
        const accepted = acceptedProfiles(meta, intent, workspace);
        assert.equal(
          declared.supported,
          accepted.length > 0,
          `${meta.id}.${intent} declared supported=${declared.supported} but runtime-accepted=[${accepted}]`,
        );
        assert.deepEqual(
          declaredProfiles(declared).sort(),
          accepted,
          `${meta.id}.${intent} declared profiles vs runtime-accepted`,
        );
      }
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('claude portable compose is reachable while legacy compose-only stays rejected', () => {
  // F6 follow-up: the portable lane (taskIntent compose + compose-only) is
  // exempt from the legacy toolPolicy declaration check, so claude reaches its
  // text-only compose branch. The legacy no-taskIntent lane is frozen:
  // `toolPolicies` stays ['provider-default'] and compose-only still fails.
  const portable = classifyDryRun({ provider: 'claude', prompt: 'compose probe', taskIntent: 'compose' });
  assert.equal(portable.outcome, 'ok', 'claude portable compose must reach the adapter');
  const toolsIndex = portable.args.indexOf('--tools');
  assert.ok(toolsIndex !== -1 && portable.args[toolsIndex + 1] === '', 'compose must deny tools with an empty --tools list');
  assert.ok(portable.args.includes('--safe-mode'), 'compose must stay in safe-mode');
  const legacy = classifyDryRun({ provider: 'claude', prompt: 'compose probe', toolPolicy: 'compose-only' });
  assert.equal(legacy.outcome, 'error', 'legacy claude compose-only must stay rejected');
  assert.equal(legacy.code, 'UNSUPPORTED_CAPABILITY');
  // A caller-supplied legacy toolPolicy must be well-formed even when the
  // portable profile drives the effective policy.
  for (const bogus of ['unsafe', 'full']) {
    const invalid = classifyDryRun({ provider: 'claude', prompt: 'compose probe', taskIntent: 'compose', toolPolicy: bogus });
    assert.equal(invalid.outcome, 'error', `compose + toolPolicy ${bogus} must fail`);
    assert.equal(invalid.code, 'INVALID_INPUT', `compose + toolPolicy ${bogus} code`);
  }
});

test('rejected claude compose cleans up its disposable workspace', async () => {
  await withPrivateTmp(async () => {
    await assert.rejects(
      generate({
        provider: 'claude', prompt: 'compose probe', taskIntent: 'compose', agentMode: 'plan',
        env: { ...process.env, CLAUDE_BIN: fakeBin },
      }),
      (error) => error.code === 'UNSUPPORTED_CAPABILITY',
    );
  });
});

test('rejected legacy agy compose dry-run cleans its preview temp dir', async () => {
  await withPrivateTmp(() => {
    assert.throws(
      () => describeGenerateDryRun({ provider: 'agy', prompt: 'compose probe', toolPolicy: 'compose-only', agentMode: 'bogus' }),
      (error) => error.code === 'INVALID_INPUT',
    );
  });
});

test('hostile env source does not leak the claude compose workspace', async () => {
  await withPrivateTmp(async () => {
    const hostileEnv = new Proxy({}, {
      ownKeys() { throw new Error('hostile env'); },
      getOwnPropertyDescriptor() { throw new Error('hostile env'); },
    });
    await assert.rejects(
      generate({ provider: 'claude', prompt: 'compose probe', taskIntent: 'compose', env: hostileEnv }),
      /hostile env/,
    );
  });
});

test('throwing observer accessor does not leak the claude compose workspace', async () => {
  await withPrivateTmp(async () => {
    for (const field of ['onStream', 'onEvent']) {
      const hostile = {
        provider: 'claude', prompt: 'compose probe', taskIntent: 'compose',
        env: { ...process.env, CLAUDE_BIN: fakeBin },
      };
      Object.defineProperty(hostile, field, {
        enumerable: true,
        get() { throw new Error(`hostile ${field}`); },
      });
      await assert.rejects(generate(hostile), new RegExp(`hostile ${field}`));
    }
  });
});

test('unserializable codex schema does not leak a provider temp dir', async () => {
  await withPrivateTmp(() => {
    const circular = {};
    circular.self = circular;
    assert.throws(
      () => describeGenerateDryRun({ provider: 'codex', prompt: 'schema probe', schema: circular }),
      TypeError,
    );
  });
});

test('declared agentModes match every runtime-accepted mode', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'webmcp-ai-modes-'));
  try {
    for (const meta of listProviders()) {
      const declared = meta.capabilities.agentModes;
      const accepted = [];
      for (const mode of [...ALL_AGENT_MODES, BOGUS_AGENT_MODE]) {
        const result = classifyDryRun({ provider: meta.id, prompt: 'mode probe', workspace, agentMode: mode });
        if (result.outcome === 'ok') {
          accepted.push(mode);
          assert.notEqual(mode, BOGUS_AGENT_MODE, `${meta.id} accepted the bogus agentMode`);
          continue;
        }
        assert.ok(RUNTIME_REJECTIONS.includes(result.code), `${meta.id}.${mode} unexpected error ${result.code}`);
        // Providers that support agentMode validate the value (INVALID_INPUT);
        // providers without agentMode reject the option itself.
        const expectedCode = mode === BOGUS_AGENT_MODE && AGENT_MODE_CAPABLE.has(meta.id)
          ? 'INVALID_INPUT'
          : 'UNSUPPORTED_CAPABILITY';
        assert.equal(result.code, expectedCode, `${meta.id}.${mode} code`);
      }
      accepted.sort();
      assert.equal(
        declared.supported,
        accepted.length > 0,
        `${meta.id} declared agentModes.supported=${declared.supported} but runtime-accepted=[${accepted}]`,
      );
      assert.deepEqual([...declared.values].sort(), accepted, `${meta.id} agentModes.values vs runtime-accepted`);
      if (declared.supported) {
        assert.ok(declared.values.includes(declared.default), `${meta.id} default ${declared.default} must be an accepted value`);
        // Lock the runtime default: a dry-run with agentMode omitted must
        // resolve to exactly the args of the declared default mode, and to no
        // other mode. This catches a default that is a valid value but not the
        // one the runtime actually picks (e.g. opencode defaults to plan).
        const omitted = describeGenerateDryRun({ provider: meta.id, prompt: 'mode probe', workspace });
        const matching = declared.values.filter((mode) => {
          const explicit = describeGenerateDryRun({ provider: meta.id, prompt: 'mode probe', workspace, agentMode: mode });
          return JSON.stringify(explicit.args) === JSON.stringify(omitted.args);
        });
        assert.deepEqual(matching, [declared.default], `${meta.id} runtime default vs declared default`);
      } else {
        assert.equal(declared.default, null, `${meta.id} unsupported agentModes.default must be null`);
      }
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('omitted accessProfile resolves to the portable default', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'webmcp-ai-defaults-'));
  try {
    for (const meta of listProviders()) {
      for (const intent of INTENTS) {
        const omitted = classifyDryRun(intentInput(meta, intent, undefined, workspace));
        if (intent === 'implement') {
          // implement has no default profile: must fail typed, before spawn.
          assert.equal(omitted.outcome, 'error', `${meta.id}.implement omitted profile resolved`);
          assert.equal(omitted.code, 'TASK_INTENT_ACCESS_CONFLICT', `${meta.id}.implement omitted profile code`);
          continue;
        }
        const explicitDefault = classifyDryRun(intentInput(meta, intent, DEFAULT_PROFILE[intent], workspace));
        assert.equal(omitted.outcome, explicitDefault.outcome, `${meta.id}.${intent} omitted vs default outcome`);
        if (omitted.outcome === 'ok') {
          assert.deepEqual(omitted.args, explicitDefault.args, `${meta.id}.${intent} omitted vs default args`);
        } else {
          assert.equal(omitted.code, explicitDefault.code, `${meta.id}.${intent} omitted vs default code`);
        }
      }
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('providers list JSON exposes agentModes and taskIntents', () => {
  const result = run(['providers', 'list', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  for (const provider of payload.providers) {
    assert.ok(provider.capabilities.agentModes, `${provider.id} agentModes`);
    assert.equal(Object.keys(provider.capabilities.taskIntents).length, 4);
  }
});

test('providers inspect reports declared intents without spawning', () => {
  for (const meta of listProviders()) {
    for (const intent of ['compose', 'implement', 'plan']) {
      const declared = meta.capabilities.taskIntents[intent];
      const result = run(['providers', 'inspect', meta.id, '--task-intent', intent, '--json']);
      assert.equal(result.status, 0, `${meta.id}/${intent}: ${result.stderr}`);
      const payload = JSON.parse(result.stdout);
      const expectedKeys = [
        'ok', 'provider', 'taskIntent', 'accessProfile',
        ...(declared.accessProfiles ? ['accessProfiles'] : []),
        'probe', 'supported', 'policySupported', 'taskReady', 'code', 'reason',
        ...(declared.note ? ['note'] : []),
        'mapping',
      ];
      assert.deepEqual(Object.keys(payload), expectedKeys, `${meta.id}/${intent} exact keys`);
      assert.equal(payload.ok, true, `${meta.id}/${intent} ok`);
      assert.equal(payload.provider, meta.id, `${meta.id}/${intent} provider`);
      assert.equal(payload.taskIntent, intent, `${meta.id}/${intent} taskIntent`);
      assert.equal(payload.mapping, null, `${meta.id}/${intent} mapping`);
      assert.equal(payload.probe, 'declared', `${meta.id}/${intent} probe`);
      assert.equal(payload.taskReady, null, `${meta.id}/${intent} taskReady`);
      assert.equal(payload.supported, declared.supported, `${meta.id}/${intent} supported`);
      assert.equal(payload.policySupported, declared.supported, `${meta.id}/${intent} policySupported`);
      assert.equal(payload.reason ?? null, declared.reason ?? null, `${meta.id}/${intent} reason`);
      assert.equal(payload.note ?? null, declared.note ?? null, `${meta.id}/${intent} note`);
      assert.deepEqual(payload.accessProfile ?? null, declared.accessProfile ?? null, `${meta.id}/${intent} accessProfile`);
      assert.deepEqual(payload.accessProfiles ?? null, declared.accessProfiles ?? null, `${meta.id}/${intent} accessProfiles`);
      if (declared.supported) {
        assert.equal(payload.code, null, `${meta.id}/${intent} code`);
      } else {
        assert.equal(payload.code, 'UNSUPPORTED_CAPABILITY', `${meta.id}/${intent} code`);
        assert.ok(payload.reason, `${meta.id}/${intent} reason`);
      }
    }
  }
  // Review keeps the existing install/help-probe shape. AGY is exercised here
  // without any binary probe; the claude/codex/opencode help-probe lanes are
  // covered by review-codex-opencode-probes.test.mjs.
  const agyReview = run(['providers', 'inspect', 'agy', '--task-intent', 'review', '--json']);
  assert.equal(agyReview.status, 0, agyReview.stderr);
  const agyPayload = JSON.parse(agyReview.stdout);
  assert.equal(agyPayload.ok, true);
  assert.equal(agyPayload.supported, false);
  assert.equal(agyPayload.code, 'UNSUPPORTED_CAPABILITY');
});

test('declared inspections never invoke a provider binary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'webmcp-ai-nospawn-'));
  const marker = join(dir, 'invoked.txt');
  const markerBin = join(dir, 'marker-provider.sh');
  writeFileSync(markerBin, `#!/bin/sh\necho invoked >> "${marker}"\nexit 0\n`);
  chmodSync(markerBin, 0o755);
  try {
    // Positive control: the marker executable must really write the marker,
    // otherwise a silent no-op would make the negative assertion vacuous.
    const control = spawnSync(markerBin, [], { encoding: 'utf8' });
    assert.equal(control.status, 0, 'marker executable positive control failed');
    assert.equal(existsSync(marker), true, 'marker executable positive control wrote no marker');
    rmSync(marker);
    for (const meta of listProviders()) {
      for (const intent of ['compose', 'implement', 'plan']) {
        const result = spawnSync(process.execPath, [bin, 'providers', 'inspect', meta.id, '--task-intent', intent, '--json'], {
          encoding: 'utf8',
          cwd: '/tmp',
          env: {
            ...process.env,
            AGY_BIN: markerBin,
            CLAUDE_BIN: markerBin,
            CODEX_BIN: markerBin,
            OPENCODE_BIN: markerBin,
          },
        });
        assert.equal(result.status, 0, `${meta.id}/${intent}: ${result.stderr}`);
      }
    }
    assert.equal(existsSync(marker), false, 'a declared inspection invoked a provider binary');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflight, doctor, plain inspect, and models inspect carry the runtime matrix', () => {
  const registry = listProviders();
  const byId = new Map(registry.map((provider) => [provider.id, provider]));
  const assertExactMatrix = (capabilities, providerId, label) => {
    assert.ok(byId.has(providerId), `${label} unknown provider ${providerId}`);
    assert.deepEqual(capabilities, byId.get(providerId).capabilities, `${label} exact capabilities`);
  };
  const preflight = JSON.parse(run(['preflight', '--json']).stdout);
  for (const provider of preflight.providers) assertExactMatrix(provider.capabilities, provider.id, 'preflight');
  // Doctor with non-existent binaries: availability probes fail closed without
  // spawning a model, and the capability metadata must still be present.
  const missingEnv = {
    AGY_BIN: '/nonexistent/webmcp-ai-bin',
    CLAUDE_BIN: '/nonexistent/webmcp-ai-bin',
    CODEX_BIN: '/nonexistent/webmcp-ai-bin',
    OPENCODE_BIN: '/nonexistent/webmcp-ai-bin',
  };
  const doctor = run(['doctor', '--json'], missingEnv);
  assert.equal(doctor.status, 0, doctor.stderr);
  for (const provider of JSON.parse(doctor.stdout).providers) assertExactMatrix(provider.capabilities, provider.id, 'doctor');
  const list = JSON.parse(run(['providers', 'list', '--json']).stdout);
  for (const provider of list.providers) assertExactMatrix(provider.capabilities, provider.id, 'providers list');
  for (const meta of registry) {
    const plain = JSON.parse(run(['providers', 'inspect', meta.id, '--json']).stdout);
    assertExactMatrix(plain.provider.capabilities, meta.id, 'plain inspect');
    const model = JSON.parse(run(['models', 'inspect', '--provider', meta.id, '--json']).stdout);
    assertExactMatrix(model.capabilities, meta.id, 'models inspect');
  }
});

test('provider inspect rejects an unknown taskIntent with the enum in the message', () => {
  const result = run(['providers', 'inspect', 'codex', '--task-intent', 'bogus', '--json']);
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, 'TASK_INTENT_INVALID');
  assert.match(payload.error.message, /review\|compose\|implement\|plan/);
});
