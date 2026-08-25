import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package publication runs tests and includes release notes', () => {
  const gate = String(packageJson.scripts.prepublishOnly);
  // The permanent publish lifecycle: unit suite, coverage thresholds,
  // installed-package closure and pack dry-run — no nested npm lifecycles and
  // NO fixed-SHA git gate (one-time remediation checks never block releases).
  assert.match(gate, /node --test tests\/\*\.test\.mjs/);
  assert.match(gate, /node scripts\/orchestration-coverage\.mjs/);
  assert.match(gate, /node scripts\/orchestration-package-closure\.mjs/);
  assert.match(gate, /npm pack --dry-run/);
  // Node 18 portability: the runner must NEVER mask leaked handles and must
  // NOT rely on coverage flags that only exist on newer Node lines.
  assert.equal(gate.includes('--test-force-exit'), false, 'publish gates may not force-exit over leaked handles');
  assert.equal(gate.includes('--experimental-test-coverage'), false, 'coverage thresholds come from the portable verifier');
  const verifier = readFileSync(`${root}/scripts/orchestration-coverage.mjs`, 'utf8');
  for (const metric of ['lines', 'functions', 'branches']) {
    assert.match(verifier, new RegExp(`${metric}: 80`), `the verifier enforces the 80% ${metric} threshold`);
  }
  assert.equal(/git diff --check 47bfccee/.test(gate), false, 'the one-time SHA gate stays out of the publish lifecycle');
  assert.equal(gate.includes('npm run'), false, 'no recursive npm lifecycle inside prepublishOnly');
  assert.ok(packageJson.files.includes('CHANGELOG.md'));
  assert.equal(existsSync(`${root}/CHANGELOG.md`), true);
});

test('release workflow tests and publishes the public package with provenance', () => {
  const workflowPath = `${root}/.github/workflows/publish.yml`;
  assert.equal(existsSync(workflowPath), true);
  const workflow = readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /npm publish --provenance --access public/);
});
