import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const installer = fileURLToPath(new URL('../scripts/install-agent.mjs', import.meta.url));

test('installs the companion skill into Codex, Gemini, and Claude homes', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'webmcp-ai-skill-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [installer, 'all'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  for (const skillRoot of [
    '.codex/skills/webmcp-ai-cli',
    '.gemini/config/skills/webmcp-ai-cli',
    '.claude/skills/webmcp-ai-cli',
  ]) {
    const installedSkill = join(home, skillRoot, 'SKILL.md');
    const installedReference = join(
      home,
      skillRoot,
      'references/cli-subagent-orchestration.md',
    );
    const installedMetadata = join(home, skillRoot, 'agents/openai.yaml');

    assert.equal(
      readFileSync(installedSkill, 'utf8'),
      readFileSync(join(root, 'skills/webmcp-ai-cli/SKILL.md'), 'utf8'),
    );
    assert.equal(existsSync(installedReference), true, `${skillRoot} is missing the reference`);
    assert.equal(
      readFileSync(installedReference, 'utf8'),
      readFileSync(
        join(root, 'skills/webmcp-ai-cli/references/cli-subagent-orchestration.md'),
        'utf8',
      ),
    );
    assert.equal(
      readFileSync(installedMetadata, 'utf8'),
      readFileSync(join(root, 'skills/webmcp-ai-cli/agents/openai.yaml'), 'utf8'),
    );
  }
});

test('rejects an unknown agent target', () => {
  const result = spawnSync(process.execPath, [installer, 'unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /codex, gemini, claude, or all/);
});
