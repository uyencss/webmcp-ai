import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// RED: these exports do not exist until the closure harness is refactored.
import {
  auditShippedPaths,
  evaluateRangeDiffCheck,
  rangeCheckApplies,
  runPackageClosure,
} from '../scripts/orchestration-package-closure.mjs';

const OWNER_BASE = '29eed4d18f7797dfd24bf9e6aa2ce1f314d57f0e';

function tempRoot(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r7-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('R7: removing any required orchestration module fails the manifest audit', (t) => {
  const schemasDir = join(t.tmpdir ?? '.', '.');
  const repoSchemas = new URL('../src/orchestration/schemas/', import.meta.url).pathname;
  const shipped = new Set([
    'bin/webmcp-ai.mjs',
    'src/cli.mjs',
    'src/orchestration/client.mjs',
    // supervisor-entry.mjs deliberately missing → must fail
    'src/orchestration/guide.mjs',
    'scripts/orchestration-hook.mjs',
    'scripts/install-agent.mjs',
    'skills/webmcp-ai-cli/SKILL.md',
    'skills/webmcp-ai-cli/references/orchestration-runtime.md',
    'package.json',
    'README.md',
  ]);
  const report = auditShippedPaths(shipped, repoSchemas);
  assert.equal(report.ok, false, 'missing supervisor entry must fail');
  assert.ok(
    report.violations.some((violation) => String(violation).includes('supervisor-entry')),
    `violations mention the missing module: ${JSON.stringify(report.violations)}`,
  );

  // The complete manifest passes the same audit.
  const complete = new Set([
    ...shipped,
    'src/orchestration/supervisor-entry.mjs',
    'skills/webmcp-ai-cli/agents/openai.yaml',
    'skills/webmcp-ai-cli/references/cli-subagent-orchestration.md',
    'CHANGELOG.md',
    'LICENSE',
  ]);
  for (const schemaName of readdirSync(repoSchemas)) {
    complete.add(`src/orchestration/schemas/${schemaName}`);
  }
  const okReport = auditShippedPaths(complete, repoSchemas);
  assert.equal(okReport.ok, true, JSON.stringify(okReport.violations));
});

test('R7: a missing schema or skill asset fails the manifest audit', () => {
  const repoSchemas = new URL('../src/orchestration/schemas/', import.meta.url).pathname;
  const shipped = new Set([
    'bin/webmcp-ai.mjs',
    'src/cli.mjs',
    'src/orchestration/client.mjs',
    'src/orchestration/supervisor-entry.mjs',
    'skills/webmcp-ai-cli/SKILL.md',
    'skills/webmcp-ai-cli/references/orchestration-runtime.md',
    'scripts/orchestration-hook.mjs',
    'package.json',
  ]);
  for (const name of readdirSync(repoSchemas)) shipped.add(`src/orchestration/schemas/${name}`);

  // Drop one schema file.
  const withoutSchema = new Set(shipped);
  const dropped = [...shipped].find((entry) => entry.startsWith('src/orchestration/schemas/'));
  withoutSchema.delete(dropped);
  assert.equal(auditShippedPaths(withoutSchema, repoSchemas).ok, false, 'missing schema asset fails');

  // Drop the runtime guide.
  const withoutGuide = new Set(shipped);
  withoutGuide.delete('skills/webmcp-ai-cli/references/orchestration-runtime.md');
  const guideReport = auditShippedPaths(withoutGuide, repoSchemas);
  assert.equal(guideReport.ok, false);
  assert.ok(guideReport.violations.some((v) => String(v).includes('orchestration-runtime')));
});

test('R7: range diff-check evaluation flags whitespace errors in any commit of the range', () => {
  const clean = evaluateRangeDiffCheck('');
  assert.deepEqual(clean, { ok: true, violations: [] });

  const dirty = evaluateRangeDiffCheck(
    [
      'src/orchestration/verifier.mjs:450: new blank line at EOF.',
      'tests/fixtures/orchestration/fake-claude.mjs:94: new blank line at EOF.',
      '',
    ].join('\n'),
  );
  assert.equal(dirty.ok, false);
  assert.equal(dirty.violations.length, 2);
  assert.match(dirty.violations[0], /verifier\.mjs:450/);
});

test('R7: installed artifact closes the package: install, imports, CLI and public lifecycle', { timeout: 300_000 }, async (t) => {
  const consumerDir = tempRoot(t, 'consumer');
  const receipt = await runPackageClosure({
    consumerDir,
    ownerBaseRange: `${OWNER_BASE}..HEAD`,
  });

  assert.equal(receipt.ok, true, JSON.stringify({ violations: receipt.violations }, null, 2));

  const byCheck = Object.fromEntries(receipt.checks.map((check) => [check.check, check.ok]));
  assert.equal(byCheck['npm pack --json exits successfully under an isolated environment'], true);
  assert.equal(byCheck['clean install of the packed tarball succeeds in an isolated consumer project'], true);
  assert.equal(byCheck['installed public entrypoints import through bare specifiers'], true);
  assert.equal(byCheck['installed CLI answers orchestration capabilities'], true);
  assert.equal(byCheck['installed supervisor completes a fixture-backed public dispatch lifecycle'], true);
  assert.equal(byCheck['schemas, skills and scripts assets exist after installation'], true);

  // Hermeticity: ambient user config never participates; HOME untouched.
  assert.equal(receipt.hermetic.userConfigScoped, true);
  assert.equal(receipt.hermetic.cacheScoped, true);
  assert.equal(receipt.hermetic.prefixScoped, true);
  assert.equal(receipt.hermetic.homeRepurposed, false);

  assert.equal(receipt.rangeDiffCheck.ok, true, JSON.stringify(receipt.rangeDiffCheck));
});

test('R8D: range gate applies only when the owner base exists locally', () => {
  const repoRoot = new URL('..', import.meta.url).pathname;
  // A historical commit that IS present in a full checkout.
  assert.equal(rangeCheckApplies(repoRoot, '29eed4d18f7797dfd24bf9e6aa2ce1f314d57f0e'), true);
  // An arbitrary absent SHA must not break the permanent lifecycle.
  assert.equal(rangeCheckApplies(repoRoot, '0'.repeat(40)), false);
});
