import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { classifyProviderLine } from '../src/events.mjs';
import { getProvider } from '../src/providers/index.mjs';
import { runProcess } from '../src/process-runner.mjs';

// Real JSONL captured against the installed opencode v2.0.19 binary (canary
// 2026-09-29; see the R4 report for exact commands). These are not
// hand-constructed shapes: they are the literal bytes the CLI emitted, kept
// small (one bounded scenario per file) so classification/parsing is proven
// against ground truth instead of an assumed schema. `session.jsonl` is
// intentionally absent: `opencode run --standalone --format json` on 2.0.19
// never emitted a dedicated `session.created`/`session.idle` event type in
// any of the captured canaries (text, tool, error) — only
// step_start/tool_use/step_finish/text/error — so there is nothing real to
// fixture. The `sessionID` field present on every line is still exercised by
// the text/tool fixtures below and by the pre-existing bare-`sessionID`
// classifier test in tests/events.test.mjs.
function loadFixture(name) {
  const path = fileURLToPath(new URL(`./fixtures/opencode-v2-jsonl/${name}`, import.meta.url));
  return readFileSync(path, 'utf8');
}

const opencodeProvider = getProvider('opencode');

test('real opencode v2 text.jsonl classifies researching and parses to the final answer', () => {
  const raw = loadFixture('text.jsonl');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  const classified = classifyProviderLine('opencode', lines[0]);
  assert.deepEqual(classified, { state: 'researching', summary: 'OK' });

  const parsed = opencodeProvider.parseOutput({ stdout: raw });
  assert.equal(parsed.text, 'OK');
  assert.equal(parsed.sessionId, 'ses_f144f3cdfffeZ7xPhEmDlxzg73');
  assert.equal(parsed.structured, null);
});

test('real opencode v2 tool.jsonl classifies the bounded shell tool call and parses the final answer', () => {
  const raw = loadFixture('tool.jsonl');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 4, 'expected the full multi-line canary transcript');

  const classifiedLines = lines.map((line) => classifyProviderLine('opencode', line));
  // tool_use for a bounded read-only `ls` (not a test runner) maps to editing.
  const toolClassified = classifiedLines.find((c, i) => lines[i].includes('"tool_use"'));
  assert.equal(toolClassified.state, 'editing');
  assert.match(toolClassified.summary, /shell/);
  // The final natural-language answer line still classifies as researching.
  const textClassified = classifiedLines.at(-1);
  assert.equal(textClassified.state, 'researching');
  assert.equal(textClassified.summary, 'sample.txt');

  const parsed = opencodeProvider.parseOutput({ stdout: raw });
  assert.equal(parsed.text, 'sample.txt');
  assert.equal(parsed.sessionId, 'ses_f144ede65ffe7R3mxEfdWZeHz5');
});

test('real opencode v2 error.jsonl (provider.no-route) classifies blocked and maps to typed PROVIDER_NO_ROUTE', async () => {
  const raw = loadFixture('error.jsonl');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  const classified = classifyProviderLine('opencode', lines[0]);
  assert.equal(classified.state, 'blocked');
  assert.match(classified.summary, /Model unavailable: opencode-go\/does-not-exist/);

  // The same real bytes, replayed through a bounded exit-1 process, must map
  // to the typed no-route error via process-runner's structured classifier —
  // proving the real shape (top-level `type:"error"`, nested `error.type`)
  // satisfies the existing provider.no-route contract end to end.
  await assert.rejects(
    runProcess(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(raw)}); process.exit(1)`], {
      timeoutMs: 1000,
    }),
    (error) => error.code === 'PROVIDER_NO_ROUTE'
      && error.retryable === false
      && error.details.providerCode === 'provider.no-route'
      && !JSON.stringify(error).includes('does-not-exist'),
  );
});

test('SQLite lock diagnostics (node:sqlite / opencode CLI wording) map to typed PROVIDER_DB_LOCKED', async () => {
  // These are the two real wordings this codebase already treats as
  // authoritative for a concurrent-storage lock: the exact node:sqlite
  // DatabaseSync error text checked in src/providers/opencode.mjs
  // (`inspectOpencodeDb`) and the generic "database is locked" phrasing the
  // process-runner classifier matches. A live concurrent SQLITE_BUSY is
  // flaky-by-nature to canary; the regex is proven directly against both
  // real wordings instead.
  await assert.rejects(
    runProcess(process.execPath, ['-e', "process.stderr.write('SQLITE_BUSY: database is locked'); process.exit(1)"], {
      timeoutMs: 1000,
    }),
    (error) => error.code === 'PROVIDER_DB_LOCKED' && error.retryable === true,
  );
  await assert.rejects(
    runProcess(process.execPath, ['-e', "process.stderr.write('Error: database is locked'); process.exit(1)"], {
      timeoutMs: 1000,
    }),
    (error) => error.code === 'PROVIDER_DB_LOCKED' && error.retryable === true,
  );
});
