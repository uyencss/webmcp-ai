import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package publication runs tests and includes release notes', () => {
  assert.equal(packageJson.scripts.prepublishOnly, 'npm run test:coverage');
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
