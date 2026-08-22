import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const skill = fileURLToPath(new URL('../skills/webmcp-ai-cli/SKILL.md', import.meta.url));
const orchestrationReference = fileURLToPath(
  new URL('../skills/webmcp-ai-cli/references/cli-subagent-orchestration.md', import.meta.url),
);
const openaiMetadata = fileURLToPath(
  new URL('../skills/webmcp-ai-cli/agents/openai.yaml', import.meta.url),
);

test('skill distinguishes the generate and tool-call JSON response envelopes', () => {
  const content = readFileSync(skill, 'utf8');
  assert.match(content, /Use `generate` for one-shot generation/);
  assert.match(content, /`generate --json`: require `ok: true`, then consume `response\.text`/);
  assert.match(content, /`tool-call --json`: require `ok: true`, then consume `output\.text`/);
  assert.match(content, /On failure, read `error\.code`/);
});

test('skill routes CLI-agent orchestration through a packaged reference', () => {
  const content = readFileSync(skill, 'utf8');

  assert.equal(existsSync(orchestrationReference), true);
  const localLinks = [...content.matchAll(/\]\((?!https?:|mailto:|#)([^)]+)\)/g)]
    .map((match) => match[1]);
  assert.ok(localLinks.includes('references/cli-subagent-orchestration.md'));
  for (const link of localLinks) {
    assert.equal(existsSync(resolve(dirname(skill), link)), true, `unresolved skill link: ${link}`);
  }
  assert.match(content, /spawn|delegate|supervise/i);
  assert.match(content, /coordinator.+role/i);
  assert.match(content, /buffers provider output until process exit/i);
});

test('orchestration reference defines portable supervision and evidence gates', () => {
  const content = readFileSync(orchestrationReference, 'utf8');
  const taskPacket = content.match(/Every CLI dispatch[\s\S]*?```text\n([\s\S]*?)```/)?.[1];
  const terminalReport = content.match(/terminal report[\s\S]*?```text\n([\s\S]*?)```/)?.[1];

  assert.ok(taskPacket, 'task packet code block is missing');
  assert.ok(terminalReport, 'terminal report code block is missing');

  for (const field of [
    'Objective',
    'Initial dirty paths / hashes',
    'Allowed writes',
    'Protected paths',
    'Focused test',
    'Stop conditions',
    'Session / resume policy',
    'Delegation depth',
    'Lifecycle / cleanup owner',
    'Required final report',
  ]) {
    assert.match(taskPacket, new RegExp(field.replaceAll('/', '\\/'), 'i'));
  }

  for (const field of [
    'Outcome',
    'Task ID / dispatch ID',
    'Actual provider / executable / model / session',
    'Files modified',
    'Tests run and exact results',
    'Unresolved blockers / questions',
    'Recommended disposition',
  ]) {
    assert.match(terminalReport, new RegExp(field.replaceAll('/', '\\/'), 'i'));
  }

  assert.match(content, /Coordinator is a role/i);
  assert.match(content, /full handoff/i);
  assert.match(content, /supervised orchestration/i);
  assert.match(content, /Full handoff transfers[\s\S]{0,120}lifecycle\/cleanup ownership/i);
  assert.match(content, /sending Coordinator does not wait for, monitor, or release/i);
  assert.match(content, /telemetry.+not.+control/i);
  assert.match(content, /timeout.+checkpoint/i);
  assert.match(content, /heartbeat.+not.+completion/i);
  assert.match(content, /do not silently (?:substitute|fall back)/i);
  assert.match(content, /explicit session/i);
  assert.match(content, /independent.+acceptance/i);
  assert.match(content, /AGY/);
  assert.match(content, /Claude Code/);
  assert.match(content, /Codex/);
  assert.match(content, /OpenCode/);
  assert.match(content, /Never open or copy provider credential stores/i);
});

test('orchestration reference preserves capability and enforcement boundaries', () => {
  const content = readFileSync(orchestrationReference, 'utf8');

  assert.match(content, /`doctor --json` proves that an executable responded to a version probe/i);
  assert.match(content, /current adapters support it for AGY and OpenCode/i);
  assert.match(content, /Telemetry also cannot prevent a side effect/i);
  assert.match(content, /block the mutable supervised dispatch/i);
  assert.match(content, /time out or\s+exit with code 1/i);
  assert.match(content, /Brief v1 cannot enforce\s+exactly-once delivery/i);
  assert.match(content, /requested model verified; actual resolved model indeterminate/i);
});

test('skill picker metadata advertises portable CLI-agent orchestration', () => {
  const content = readFileSync(openaiMetadata, 'utf8');

  assert.match(content, /OpenCode/);
  assert.match(content, /orchestrat|supervis|delegat/i);
  assert.match(content, /\$webmcp-ai-cli/);
});
