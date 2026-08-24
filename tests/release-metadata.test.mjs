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
  assert.match(gate, /--test-coverage-lines=80 --test-coverage-functions=80 --test-coverage-branches=80/);
  assert.match(gate, /node scripts\/orchestration-package-closure\.mjs/);
  assert.match(gate, /npm pack --dry-run/);
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
