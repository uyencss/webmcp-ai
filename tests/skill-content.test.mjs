import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const skill = fileURLToPath(new URL('../skills/webmcp-ai-cli/SKILL.md', import.meta.url));

test('core skill documents one-shot/review behavior and companion orchestration boundary', () => {
  const content = readFileSync(skill, 'utf8');
  assert.match(content, /Use `generate` for one-shot generation/);
  assert.match(content, /ai\.review/);
  assert.match(content, /@gyga-browser\/webmcp-ai-orchestration/);
  assert.match(content, /lazy compatibility shim/i);
  assert.doesNotMatch(content, /references\/cli-subagent-orchestration\.md/);
  assert.doesNotMatch(content, /references\/orchestration-runtime\.md/);
});

test('core skill documents OpenCode v2 state and native route error handling', () => {
  const content = readFileSync(skill, 'utf8');
  assert.match(content, /PROVIDER_STATE_UNINITIALIZED/);
  assert.match(content, /PROVIDER_NO_ROUTE/);
  assert.match(content, /explicit `OPENCODE_DB` value[\s\S]*operator override/i);
  assert.match(content, /missing or empty[\s\S]*PROVIDER_STATE_UNINITIALIZED/i);
  assert.match(content, /provider\.no-route/);
});

test('core package does not ship orchestration-owned skill references', () => {
  assert.equal(existsSync(`${root}/skills/webmcp-ai-cli/references/cli-subagent-orchestration.md`), false);
  assert.equal(existsSync(`${root}/skills/webmcp-ai-cli/references/orchestration-runtime.md`), false);
});
