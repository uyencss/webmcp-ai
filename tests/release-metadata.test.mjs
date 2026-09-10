import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { listTestFiles } from "../scripts/coverage.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("package publication runs tests and includes release notes", () => {
  const gate = String(packageJson.scripts.prepublishOnly);
  const testScript = String(packageJson.scripts.test);

  assert.match(testScript, /node scripts\/coverage\.mjs --test-only/);
  assert.match(gate, /node scripts\/coverage\.mjs --test-only/);
  assert.match(gate, /node scripts\/coverage\.mjs/);
  assert.match(gate, /node scripts\/package-closure\.mjs/);
  assert.match(gate, /npm pack --dry-run/);
  assert.equal(gate.includes("tests/*.test.mjs"), false, "publish gate must not rely on shell glob expansion");
  assert.equal(testScript.includes("tests/*.test.mjs"), false, "test script must not rely on shell glob expansion");

  assert.equal(gate.includes("--test-force-exit"), false, "publish gates may not force-exit over leaked handles");
  assert.equal(gate.includes("--experimental-test-coverage"), false, "coverage thresholds come from the portable verifier");
  const verifier = readFileSync(`${root}/scripts/coverage.mjs`, "utf8");
  for (const metric of ["lines", "functions", "branches"]) {
    assert.match(verifier, new RegExp(`${metric}: 80`), `the verifier enforces the 80% ${metric} threshold`);
  }
  assert.equal(gate.includes("npm run"), false, "no recursive npm lifecycle inside prepublishOnly");
  assert.ok(packageJson.files.includes("CHANGELOG.md"));
  assert.equal(existsSync(`${root}/CHANGELOG.md`), true);
});

test("release workflow tests and publishes the public package with provenance", () => {
  const workflowPath = `${root}/.github/workflows/publish.yml`;
  assert.equal(existsSync(workflowPath), true);
  const workflow = readFileSync(workflowPath, "utf8");
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /npm publish --provenance --access public/);
});

test("default test suite discovers tests recursively", () => {
  const testFiles = listTestFiles();
  assert.ok(testFiles.length > 0, "must discover test files");
  assert.deepEqual(testFiles, [...testFiles].sort(), "test files must have deterministic ordering");

  for (const file of testFiles) {
    assert.match(file, /\.test\.mjs$/, `discovered file ${file} must end with .test.mjs`);
  }
});
