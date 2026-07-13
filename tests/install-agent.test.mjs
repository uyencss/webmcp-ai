import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const installer = fileURLToPath(new URL('../scripts/install-agent.mjs', import.meta.url));

test('installs the companion skill into Codex, Gemini, and Claude homes', () => {
  const home = mkdtempSync(join(tmpdir(), 'webmcp-ai-skill-'));
  const result = spawnSync(process.execPath, [installer, 'all'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  for (const relativePath of [
    '.codex/skills/webmcp-ai-cli/SKILL.md',
    '.gemini/config/skills/webmcp-ai-cli/SKILL.md',
    '.claude/skills/webmcp-ai-cli/SKILL.md',
  ]) {
    assert.match(readFileSync(join(home, relativePath), 'utf8'), /^---/);
  }
});

test('rejects an unknown agent target', () => {
  const result = spawnSync(process.execPath, [installer, 'unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /codex, gemini, claude, or all/);
});
