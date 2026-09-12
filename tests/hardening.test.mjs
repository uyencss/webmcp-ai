import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { resolveAgyArtifacts } from '../src/artifacts.mjs';
import { describeGenerateDryRun } from '../src/client.mjs';
import { describeModel, effortRejection } from '../src/model-capabilities.mjs';

const bin = fileURLToPath(new URL('../bin/webmcp-ai.mjs', import.meta.url));
const fakeBin = fileURLToPath(new URL('./fixtures/fake-ai-cli.mjs', import.meta.url));
chmodSync(fakeBin, 0o755);

function run(args, { env = {}, cwd = '/tmp' } = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      AGY_BIN: fakeBin,
      CLAUDE_BIN: fakeBin,
      CODEX_BIN: fakeBin,
      OPENCODE_BIN: fakeBin,
      ...env,
    },
  });
}

function runRaw(args, { env = {} } = {}) {
  const { AGY_BIN, CLAUDE_BIN, CODEX_BIN, OPENCODE_BIN, ...base } = process.env;
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    cwd: '/tmp',
    env: { ...base, ...env },
  });
}

test('describeModel surfaces provider limits and per-model effort support', () => {
  const opus = describeModel('agy', 'claude-opus-4-6-thinking');
  assert.equal(opus.supportsEffort, false);
  assert.equal(opus.maxPromptBytes, 128 * 1024);
  assert.equal(opus.artifacts, 'brain-fallback');
  assert.deepEqual(opus.effortValues, []);

  const gemini = describeModel('agy', 'gemini-3.8-flash-high');
  assert.equal(gemini.supportsEffort, true);

  const unknown = describeModel('opencode', 'opencode-go/not-a-real-model');
  assert.equal(unknown.known, false);
  assert.equal(unknown.supportsEffort, null);
  assert.equal(describeModel('nope', 'x'), null);
  assert.equal(describeModel('agy', '').model, null);
});

test('effortRejection only fires for a known effort-refusing model', () => {
  assert.equal(effortRejection({ providerId: 'agy', modelId: 'claude-opus-4-6-thinking', effort: 'high' }).allowedEfforts.length, 0);
  assert.equal(effortRejection({ providerId: 'agy', modelId: 'gemini-3.8-flash-high', effort: 'high' }), null);
  assert.equal(effortRejection({ providerId: 'opencode', modelId: 'opencode-go/unknown', effort: 'xhigh' }), null);
  assert.equal(effortRejection({ providerId: 'agy', modelId: 'claude-opus-4-6-thinking', effort: null }), null);
});

test('generate dry-run rejects a known unsupported --effort before spawn', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'webmcp-ai-effort-'));
  try {
    assert.throws(
      () => describeGenerateDryRun({
        provider: 'agy', prompt: 'x', model: 'claude-opus-4-6-thinking', effort: 'high', workspace, env: {},
      }),
      (error) => error.code === 'UNSUPPORTED_EFFORT',
    );
    const ok = describeGenerateDryRun({
      provider: 'agy', prompt: 'x', model: 'gemini-3.8-flash-high', effort: 'high', workspace, env: {},
    });
    assert.equal(ok.dryRun, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('models inspect exposes the per-model surface', () => {
  const result = run(['models', 'inspect', '--provider', 'agy', '--model', 'claude-opus-4-6-thinking', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.supportsEffort, false);
  assert.equal(payload.maxPromptBytes, 128 * 1024);
  assert.equal(payload.capabilities.modelDiscovery, true);
});

test('preflight reports providers and the external quota pointer without spawning', () => {
  const result = run(['preflight', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.providers.map((provider) => provider.id), ['agy', 'claude', 'codex', 'opencode']);
  assert.equal(payload.providers.every((provider) => provider.installed === true), true);
  assert.equal(payload.quota.owner, 'companion');
  assert.match(payload.quota.service, /:8421\/api\/quotas$/);
  assert.equal(payload.quota.app, 'apps/ai-cli-usage-tray');
});

test('preflight resolves bare provider names against PATH, not by assumption', () => {
  const missing = runRaw(['preflight', '--json'], { env: { PATH: '/nonexistent-webmcp-ai-path' } });
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).providers.every((provider) => provider.installed === false), true);

  const dir = mkdtempSync(join(tmpdir(), 'webmcp-ai-path-'));
  try {
    writeFileSync(join(dir, 'agy'), '#!/bin/sh\n');
    chmodSync(join(dir, 'agy'), 0o755);
    const found = runRaw(['preflight', '--json'], { env: { PATH: dir } });
    const providers = JSON.parse(found.stdout).providers;
    assert.equal(providers.find((provider) => provider.id === 'agy').installed, true);
    assert.equal(providers.find((provider) => provider.id === 'claude').installed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAgyArtifacts respects the time window and ignores empty files', () => {
  const root = mkdtempSync(join(tmpdir(), 'webmcp-ai-brain-'));
  try {
    const nested = join(root, 'run-1');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'answer.md'), '# full answer\n');
    writeFileSync(join(nested, 'empty.md'), '   \n');
    const now = Date.now();
    const found = resolveAgyArtifacts({ brainDir: root, sinceMs: now - 10_000, untilMs: now + 10_000 });
    assert.equal(found.length, 1);
    assert.equal(found[0].text, '# full answer\n');
    assert.equal(found[0].digest.length, 16);
    assert.equal(resolveAgyArtifacts({ brainDir: root, sinceMs: now + 10_000, untilMs: now + 20_000 }).length, 0);
    assert.deepEqual(resolveAgyArtifacts({ brainDir: '' }), []);
    assert.deepEqual(resolveAgyArtifacts({ brainDir: root }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeAgyBrainFake() {
  const dir = mkdtempSync(join(tmpdir(), 'webmcp-ai-agyfake-'));
  const script = join(dir, 'fake-agy.mjs');
  writeFileSync(script, [
    '#!/usr/bin/env node',
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const brain = process.env.FAKE_AGY_BRAIN;',
    "if (brain) { mkdirSync(join(brain, 'uuid-run'), { recursive: true }); writeFileSync(join(brain, 'uuid-run', 'answer.md'), 'FULL '.repeat(50)); }",
    "process.stdout.write('summary');",
    '',
  ].join('\n'));
  chmodSync(script, 0o755);
  return { dir, script };
}

test('AGY generate recovers the full brain artifact written during the run when opted in', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'webmcp-ai-artifact-ws-'));
  const brain = mkdtempSync(join(tmpdir(), 'webmcp-ai-brain-live-'));
  const fake = writeAgyBrainFake();
  try {
    const result = run([
      'generate', '--provider', 'agy', '--prompt', 'hi', '--workspace', workspace,
      '--resolve-artifacts', '--agy-brain-dir', brain, '--json',
    ], { env: { AGY_BIN: fake.script, FAKE_AGY_BRAIN: brain } });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.artifactsResolved, true);
    assert.equal(payload.response.text.startsWith('FULL FULL'), true);
    assert.equal(payload.artifacts.length, 1);
    assert.equal(payload.artifacts[0].kind, 'brain-md');
    assert.equal(payload.artifacts[0].path, undefined);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(brain, { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('retry-lock rejects a negative value with typed INVALID_INPUT', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'webmcp-ai-retry-invalid-'));
  try {
    const result = run([
      'generate', '--provider', 'opencode', '--prompt', 'hi', '--workspace', workspace,
      '--retry-lock', '-5', '--json',
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_INPUT');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('retry-lock rejects an empty value with typed INVALID_INPUT', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'webmcp-ai-retry-empty-'));
  try {
    const result = run([
      'generate', '--provider', 'opencode', '--prompt', 'hi', '--workspace', workspace,
      '--retry-lock', '', '--json',
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_INPUT');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('invalid retry-lock leaks no temp artifacts', () => {
  const iso = mkdtempSync(join(tmpdir(), 'webmcp-ai-tmpiso-'));
  try {
    const result = run([
      'generate', '--provider', 'agy', '--prompt', 'hi', '--tool-policy', 'compose-only',
      '--retry-lock', '-5', '--json',
    ], { env: { TMPDIR: iso } });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_INPUT');
    assert.deepEqual(readdirSync(iso), []);
  } finally {
    rmSync(iso, { recursive: true, force: true });
  }
});

function writeAlwaysLockedOpencode() {
  const dir = mkdtempSync(join(tmpdir(), 'webmcp-ai-locked-'));
  const script = join(dir, 'locked-opencode.mjs');
  const counter = join(dir, 'count.txt');
  writeFileSync(script, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { process.stdout.write('locked-opencode 1.18.30\\n'); process.exit(0); }",
    `appendFileSync(${JSON.stringify(counter)}, 'x');`,
    "process.stderr.write('Error: database is locked\\n');",
    'process.exit(1);',
    '',
  ].join('\n'));
  chmodSync(script, 0o755);
  return { dir, script, counter };
}

test('opencode lock is retried with backoff and then reported retryably', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'webmcp-ai-lock-ws-'));
  const locked = writeAlwaysLockedOpencode();
  try {
    const result = run([
      'generate', '--provider', 'opencode', '--prompt', 'hi', '--workspace', workspace,
      '--retry-lock', '2', '--json',
    ], { env: { OPENCODE_BIN: locked.script } });
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'PROVIDER_DB_LOCKED');
    assert.equal(payload.error.retryable, true);
    assert.equal(readFileSync(locked.counter, 'utf8').length, 3);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(locked.dir, { recursive: true, force: true });
  }
});

test('opencode lock retry can be disabled', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'webmcp-ai-lock-ws0-'));
  const locked = writeAlwaysLockedOpencode();
  try {
    const result = run([
      'generate', '--provider', 'opencode', '--prompt', 'hi', '--workspace', workspace,
      '--retry-lock', '0', '--json',
    ], { env: { OPENCODE_BIN: locked.script } });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).error.code, 'PROVIDER_DB_LOCKED');
    assert.equal(readFileSync(locked.counter, 'utf8').length, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(locked.dir, { recursive: true, force: true });
  }
});
