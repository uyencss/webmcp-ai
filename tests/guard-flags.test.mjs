import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { generate } from '../src/client.mjs';
import { AGY_BOUNDED_REQUIRED_FLAGS, validateAgyBoundedSupport } from '../src/providers/agy.mjs';
import { getProvider } from '../src/providers/index.mjs';
import { CLAUDE_REVIEW_ARGS, validateClaudeBoundedSupport, validateClaudeReviewSupport } from '../src/providers/claude.mjs';

const fakeBin = fileURLToPath(new URL('./fixtures/fake-ai-cli.mjs', import.meta.url));
chmodSync(fakeBin, 0o755);

function writeExecutable(path, content) {
  writeFileSync(path, content, 'utf8');
  chmodSync(path, 0o755);
}

test('AGY_BOUNDED_REQUIRED_FLAGS declares exactly --disable-slash-commands', () => {
  assert.deepEqual([...AGY_BOUNDED_REQUIRED_FLAGS], ['--disable-slash-commands']);
});

test('agy bounded argv contains --disable-slash-commands; full argv does not', () => {
  const bounded = getProvider('agy').buildInvocation({ prompt: 'x', timeoutMs: 5000 });
  assert.ok(bounded.args.includes('--disable-slash-commands'), 'bounded (provider-default) must carry the guard');
  bounded.cleanup?.();

  const composeOnly = getProvider('agy').buildInvocation({ prompt: 'x', timeoutMs: 5000, toolPolicy: 'compose-only', workspace: mkdtempSync(join(tmpdir(), 'agy-guard-compose-')) });
  assert.ok(composeOnly.args.includes('--disable-slash-commands'), 'compose-only must carry the guard');
  composeOnly.cleanup?.();

  const full = getProvider('agy').buildInvocation({ prompt: 'x', timeoutMs: 5000, accessProfile: 'full' });
  assert.equal(full.args.includes('--disable-slash-commands'), false, 'full passthrough must stay byte-identical (no new flag)');
  full.cleanup?.();
});

test('validateAgyBoundedSupport throws typed PROVIDER_CAPABILITY_DRIFT when the guard flag is missing', () => {
  assert.throws(
    () => validateAgyBoundedSupport('--sandbox --mode --print-timeout --agent --model --effort --conversation'),
    (err) => {
      assert.equal(err.code, 'PROVIDER_CAPABILITY_DRIFT');
      assert.deepEqual(err.details, { capability: 'bounded-guard', missing: ['--disable-slash-commands'] });
      return true;
    },
  );
  assert.equal(validateAgyBoundedSupport('--sandbox --disable-slash-commands --mode'), true);
});

test('agy buildInvocation validates an explicit request.agyHelpText before any side effect', () => {
  const ws = mkdtempSync(join(tmpdir(), 'agy-guard-direct-'));
  try {
    assert.throws(
      () => getProvider('agy').buildInvocation({
        prompt: 'x', timeoutMs: 5000, toolPolicy: 'compose-only', workspace: ws,
        agyHelpText: '--sandbox --mode --print-timeout',
      }),
      (err) => err.code === 'PROVIDER_CAPABILITY_DRIFT',
    );
    const ok = getProvider('agy').buildInvocation({
      prompt: 'x', timeoutMs: 5000,
      agyHelpText: '--sandbox --mode --disable-slash-commands',
    });
    assert.ok(ok.args.includes('--disable-slash-commands'));
    ok.cleanup?.();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a drifted installed agy --help fails closed before spawn (live spawn lane)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-guard-drift-spawn-'));
  const marker = join(dir, 'model-invoked.log');
  const driftedAgy = join(dir, 'fake-agy-drifted.mjs');
  writeExecutable(driftedAgy, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--help')) { process.stdout.write('--sandbox --mode --print-timeout\\n'); process.exit(0); }
if (args.includes('--version')) { process.stdout.write('agy 1.2.13\\n'); process.exit(0); }
appendFileSync(${JSON.stringify(marker)}, 'invoked\\n');
process.stdout.write('should-not-run');
`);
  try {
    await assert.rejects(
      generate({ provider: 'agy', prompt: 'x', env: { ...process.env, AGY_BIN: driftedAgy } }),
      (err) => {
        assert.equal(err.code, 'PROVIDER_CAPABILITY_DRIFT');
        assert.equal(err.details?.capability, 'bounded-guard');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('full-access agy generate does not probe --help (full passthrough unaffected)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-guard-full-'));
  const helpMarker = join(dir, 'help-invoked.log');
  const noHelpAgy = join(dir, 'fake-agy-no-help.mjs');
  writeExecutable(noHelpAgy, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--help')) { appendFileSync(${JSON.stringify(helpMarker)}, 'help\\n'); process.exit(1); }
if (args.includes('--version')) { process.stdout.write('agy 1.2.13\\n'); process.exit(0); }
process.stdout.write('reply:agy:full-ok');
`);
  const ws = mkdtempSync(join(tmpdir(), 'agy-guard-full-ws-'));
  try {
    const result = await generate({
      provider: 'agy', prompt: 'x', workspace: ws, accessProfile: 'full',
      env: { ...process.env, AGY_BIN: noHelpAgy },
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('CLAUDE_REVIEW_ARGS carries permissionPrompts none', () => {
  assert.equal(CLAUDE_REVIEW_ARGS.permissionPrompts, 'none');
});

test('claude review argv contains --disable-slash-commands and --permission-prompts none', () => {
  const invocation = getProvider('claude').buildInvocation({
    prompt: 'review this', timeoutMs: 1000, taskIntent: 'review', accessProfile: 'review-readonly',
  });
  assert.ok(invocation.args.includes('--disable-slash-commands'));
  const idx = invocation.args.indexOf('--permission-prompts');
  assert.ok(idx !== -1, '--permission-prompts must be present');
  assert.equal(invocation.args[idx + 1], 'none');
});

test('claude bounded compose argv contains --disable-slash-commands', () => {
  const invocation = getProvider('claude').buildInvocation({
    prompt: 'compose this', timeoutMs: 1000, taskIntent: 'compose',
  });
  assert.ok(invocation.args.includes('--disable-slash-commands'));
  assert.equal(invocation.args.includes('--permission-prompts'), false, 'compose lane never adds --permission-prompts');
});

test('claude legacy bounded generic argv contains --disable-slash-commands', () => {
  const locked = getProvider('claude').buildInvocation({ prompt: 'x', timeoutMs: 1000 });
  assert.ok(locked.args.includes('--disable-slash-commands'));
  // First four args stay exactly the pre-R1 shape (byte-identical prefix).
  assert.deepEqual(locked.args.slice(0, 4), ['-p', '--tools', '', '--safe-mode']);
});

test('claude full argv is unchanged: no new guard flags at all', () => {
  const full = getProvider('claude').buildInvocation({ prompt: 'x', timeoutMs: 1000, accessProfile: 'full' });
  assert.equal(full.args.includes('--disable-slash-commands'), false);
  assert.equal(full.args.includes('--permission-prompts'), false);
});

test('validateClaudeReviewSupport requires the two new flags; none must be proven adjacent to --permission-prompts', () => {
  const withoutGuard = '-p --permission-mode --tools --disallowedTools --safe-mode --no-chrome --output-format json stream-json --verbose --no-session-persistence --resume --model --effort';
  assert.throws(
    () => validateClaudeReviewSupport(withoutGuard),
    (err) => {
      assert.equal(err.code, 'PROVIDER_CAPABILITY_DRIFT');
      assert.ok(err.details.missing.includes('--disable-slash-commands'));
      assert.ok(err.details.missing.includes('--permission-prompts'));
      return true;
    },
  );
  const withGuard = `${withoutGuard} --disable-slash-commands --permission-prompts none`;
  assert.equal(validateClaudeReviewSupport(withGuard), true);

  // F3: the real 2.1.283 help wraps the value description onto a later line;
  // adjacency must tolerate whitespace/newlines within a bounded window.
  const wrapped = `${withoutGuard} --disable-slash-commands --permission-prompts <target>\n    Who answers permission prompts with --print: host | none`;
  assert.equal(validateClaudeReviewSupport(wrapped), true);

  // F3: flag present but 'none' cannot be proven adjacent -> typed drift,
  // missing reports exactly ['none'].
  const flagWithoutNone = `${withoutGuard} --disable-slash-commands --permission-prompts <target> host`;
  assert.throws(
    () => validateClaudeReviewSupport(flagWithoutNone),
    (err) => {
      assert.equal(err.code, 'PROVIDER_CAPABILITY_DRIFT');
      assert.deepEqual(err.details.missing, ['none']);
      return true;
    },
  );

  // F3 negative fixture: the word 'none' appears elsewhere in the help text
  // (an unrelated flag's choices, textually before --permission-prompts and
  // well outside any adjacency window) and must not satisfy the flag.
  const unrelatedNone = `--log-level <level> (choices: "debug", "info", "none")\n${withoutGuard} --disable-slash-commands --permission-prompts <target> host`;
  assert.throws(
    () => validateClaudeReviewSupport(unrelatedNone),
    (err) => {
      assert.equal(err.code, 'PROVIDER_CAPABILITY_DRIFT');
      assert.deepEqual(err.details.missing, ['none']);
      return true;
    },
  );
});

test('validateClaudeBoundedSupport requires only --disable-slash-commands', () => {
  assert.throws(
    () => validateClaudeBoundedSupport('-p --permission-mode --tools --safe-mode --no-chrome'),
    (err) => {
      assert.equal(err.code, 'PROVIDER_CAPABILITY_DRIFT');
      assert.deepEqual(err.details, { capability: 'bounded-guard', missing: ['--disable-slash-commands'] });
      return true;
    },
  );
  assert.equal(validateClaudeBoundedSupport('-p --disable-slash-commands --safe-mode'), true);
});

test('a drifted installed claude --help (missing guard) fails closed before spawn on the review lane', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-guard-drift-spawn-'));
  const marker = join(dir, 'model-invoked.log');
  const driftedClaude = join(dir, 'fake-claude-drifted.mjs');
  writeExecutable(driftedClaude, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('-p --permission-mode --tools --disallowedTools --safe-mode --no-chrome --output-format json stream-json --verbose --no-session-persistence --resume --model --effort\\n');
  process.exit(0);
}
if (args.includes('--version')) { process.stdout.write('claude 2.1.283\\n'); process.exit(0); }
appendFileSync(${JSON.stringify(marker)}, 'invoked\\n');
process.stdout.write(JSON.stringify({ result: 'should-not-run' }));
`);
  const ws = mkdtempSync(join(tmpdir(), 'claude-guard-drift-ws-'));
  try {
    await assert.rejects(
      generate({
        provider: 'claude', prompt: 'review me', taskIntent: 'review', accessProfile: 'review-readonly',
        workspace: ws, env: { ...process.env, CLAUDE_BIN: driftedClaude },
      }),
      (err) => {
        assert.equal(err.code, 'PROVIDER_CAPABILITY_DRIFT');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('F2: a drifted installed claude --help fails closed before spawn on the compose/generic bounded lane', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-guard-bounded-drift-'));
  const marker = join(dir, 'model-invoked.log');
  const driftedClaude = join(dir, 'fake-claude-bounded-drifted.mjs');
  writeExecutable(driftedClaude, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('-p --tools --safe-mode --no-chrome --output-format json --no-session-persistence\\n');
  process.exit(0);
}
if (args.includes('--version')) { process.stdout.write('claude 2.1.283\\n'); process.exit(0); }
appendFileSync(${JSON.stringify(marker)}, 'invoked\\n');
process.stdout.write(JSON.stringify({ result: 'should-not-run' }));
`);
  try {
    // Legacy bounded generic lane (no taskIntent, default provider-default).
    await assert.rejects(
      generate({ provider: 'claude', prompt: 'x', env: { ...process.env, CLAUDE_BIN: driftedClaude } }),
      (err) => {
        assert.equal(err.code, 'PROVIDER_CAPABILITY_DRIFT');
        assert.equal(err.details?.capability, 'bounded-guard');
        assert.deepEqual(err.details?.missing, ['--disable-slash-commands']);
        return true;
      },
    );
    assert.equal(existsSync(marker), false, 'drift must fail before any model spawn');

    // Portable compose lane (taskIntent compose + compose-only disposable workspace).
    await assert.rejects(
      generate({ provider: 'claude', prompt: 'x', taskIntent: 'compose', env: { ...process.env, CLAUDE_BIN: driftedClaude } }),
      (err) => {
        assert.equal(err.code, 'PROVIDER_CAPABILITY_DRIFT');
        assert.equal(err.details?.capability, 'bounded-guard');
        return true;
      },
    );
    assert.equal(existsSync(marker), false, 'drift must fail before any model spawn');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F2: full-access claude generate does not probe --help (full passthrough unaffected)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-guard-full-'));
  const helpMarker = join(dir, 'help-invoked.log');
  const noHelpClaude = join(dir, 'fake-claude-no-help.mjs');
  writeExecutable(noHelpClaude, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--help')) { appendFileSync(${JSON.stringify(helpMarker)}, 'help\\n'); process.exit(1); }
if (args.includes('--version')) { process.stdout.write('claude 2.1.283\\n'); process.exit(0); }
process.stdout.write(JSON.stringify({ result: 'full-ok' }));
`);
  const ws = mkdtempSync(join(tmpdir(), 'claude-guard-full-ws-'));
  try {
    const result = await generate({
      provider: 'claude', prompt: 'x', workspace: ws, accessProfile: 'full',
      env: { ...process.env, CLAUDE_BIN: noHelpClaude },
    });
    assert.equal(result.ok, true);
    assert.equal(existsSync(helpMarker), false, 'full lane must never probe --help');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('providers capabilities declare printModeGuards for agy and claude', () => {
  assert.deepEqual([...getProvider('agy').capabilities.printModeGuards], ['--disable-slash-commands']);
  assert.deepEqual([...getProvider('claude').capabilities.printModeGuards], ['--disable-slash-commands']);
});

test('CLI dry-run previews show the guard flag for agy generate and claude review', () => {
  const bin = fileURLToPath(new URL('../bin/webmcp-ai.mjs', import.meta.url));
  const genResult = spawnSync(process.execPath, [bin, 'generate', '--provider', 'agy', '--prompt', 'ping', '--dry-run', '--json'], { encoding: 'utf8' });
  assert.equal(genResult.status, 0, genResult.stderr);
  const genPayload = JSON.parse(genResult.stdout);
  assert.ok(genPayload.args.includes('--disable-slash-commands'), 'agy dry-run argv must show the guard flag');

  const ws = mkdtempSync(join(tmpdir(), 'guard-cli-review-ws-'));
  try {
    const reviewResult = spawnSync(process.execPath, [bin, 'review', '--provider', 'claude', '--prompt', 'ping', '--workspace', ws, '--dry-run', '--json'], { encoding: 'utf8' });
    assert.equal(reviewResult.status, 0, reviewResult.stderr);
    const reviewPayload = JSON.parse(reviewResult.stdout);
    assert.ok(reviewPayload.args.includes('--disable-slash-commands'), 'claude review dry-run argv must show the guard flag');
    const idx = reviewPayload.args.indexOf('--permission-prompts');
    assert.ok(idx !== -1);
    assert.equal(reviewPayload.args[idx + 1], 'none');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
