import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const skill = fileURLToPath(new URL('../skills/webmcp-ai-cli/SKILL.md', import.meta.url));

test('skill distinguishes the generate and tool-call JSON response envelopes', () => {
  const content = readFileSync(skill, 'utf8');
  assert.match(content, /Use `generate` for one-shot generation/);
  assert.match(content, /`generate --json`: require `ok: true`, then consume `response\.text`/);
  assert.match(content, /`tool-call --json`: require `ok: true`, then consume `output\.text`/);
  assert.match(content, /On failure, read `error\.code`/);
});
