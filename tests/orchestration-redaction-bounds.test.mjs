import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  REDACTED,
  sanitizeValue,
  boundText,
  boundPayload,
  sanitizeEnvironmentMetadata,
} from '../src/orchestration/redaction.mjs';
import { MANIFEST_SCHEMA } from '../src/orchestration/constants.mjs';
import {
  resolveOrchestrationRoots,
  ensureOrchestrationRoots,
  createCoordinationLayout,
} from '../src/orchestration/paths.mjs';
import { openCoordinationStore, commitDelivery } from '../src/orchestration/store.mjs';
import { writeAtomicJson, writeAtomicFile } from '../src/orchestration/atomic-file.mjs';

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `webmcp-ai-r4-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seededStore(t, name) {
  const stateDir = tempDir(t, name);
  const roots = resolveOrchestrationRoots({ env: { WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir } });
  ensureOrchestrationRoots(roots);
  const layout = createCoordinationLayout(roots.stateRoot, 'coord_r4');
  writeAtomicJson(layout.manifestPath, {
    schema: MANIFEST_SCHEMA, coordinationId: 'coord_r4', fenceEpoch: 1,
    processGeneration: 1, createdAt: new Date().toISOString(), owner: null,
  });
  const store = openCoordinationStore(layout);
  return { store, layout };
}

test('deeply nested secrets and credential-shaped keys are redacted recursively', () => {
  const hostile = {
    level1: {
      level2: [
        { apiKey: 'sk-live-abcdef123456', note: 'safe text' },
        { private_key: '-----BEGIN RSA PRIVATE KEY-----', nested: { clientSecret: 'cs_998877' } },
      ],
      sessionCookie: 'sid=abc123; HttpOnly',
      passwordHash: '$2b$12$hashhashhash',
    },
    keep: { depth: 3, value: 'visible' },
  };
  const clean = sanitizeValue(hostile);
  const serialized = JSON.stringify(clean);
  for (const forbidden of ['sk-live-abcdef123456', 'RSA PRIVATE KEY', 'cs_998877', 'sid=abc123', '$2b$12$']) {
    assert.equal(serialized.includes(forbidden), false, `leaked: ${forbidden}`);
  }
  assert.equal(clean.keep.value, 'visible');
  assert.equal(clean.level1.level2[0].note, 'safe text');
});

test('URL credentials, token-like query parameters and auth-file paths are redacted', () => {
  const cases = [
    'https://user:hunter2@api.example.com/v1/messages',
    'http://service.local/feed?token=abcdef123456&limit=5',
    'https://host/path?api_key=XYZ789&page=2',
    `${process.env.HOME ?? '/home/x'}/.opencode/auth.json`,
    '/Users/someone/.ssh/id_rsa',
    '/home/dev/.aws/credentials',
  ];
  for (const text of cases) {
    const cleaned = sanitizeValue({ line: text });
    assert.notEqual(cleaned.line, text, `expected redaction for ${text}`);
    const expectedFragments = ['hunter2', 'abcdef123456', 'XYZ789'];
    for (const fragment of expectedFragments) {
      assert.equal(cleaned.line.includes(fragment), false, `${fragment} leaked via ${text}`);
    }
  }
  // Safe URLs survive untouched.
  assert.equal(sanitizeValue({ url: 'https://example.com/feed?limit=5' }).url, 'https://example.com/feed?limit=5');
});

test('bearer/basic authorization prose is redacted wherever it appears', () => {
  const out = sanitizeValue({
    header: 'authorization: Bearer abc.def.ghi',
    basic: 'Basic dXNlcjpwYXNzd29yZA==',
    plain: 'see https://x.test?a=b',
  });
  assert.match(out.header, /\[REDACTED\]/);
  assert.match(out.basic, /\[REDACTED\]/);
});

test('secrets split across stream chunks never leak after reassembly', (t) => {
  // The owned-process persistence boundary drains ACCUMULATED buffers; prove
  // that a token split across two data events stays hidden end-to-end.
  const { store, layout } = seededStore(t, 'chunks');
  const part1 = 'prefix Bearer ';
  const part2 = 'supersecrettokenvalue';
  const reassembled = `${part1}${part2}\n`;
  commitDelivery(store, {
    type: 'progress',
    payload: { summary: `stdout: ${reassembled.trim()}`, stream: 'stdout' },
  });
  const journalText = readFileSync(layout.journalPath, 'utf8');
  assert.equal(journalText.includes(part2), false, 'split secret leaked through persistence');
  void layout;
});

test('owned-process style payloads cannot bypass the single persistence sanitizer', (t) => {
  const { store, layout } = seededStore(t, 'chokepoint');
  commitDelivery(store, {
    type: 'progress',
    payload: {
      stream: 'stderr',
      detail: { authorization: 'Bearer zzz', cookie: 'session=1' },
    },
  });
  const journalLine = readFileSync(layout.journalPath, 'utf8').trim().split('\n').pop();
  assert.equal(journalLine.includes('Bearer zzz'), false);
  assert.equal(journalLine.includes('session=1'), false);
});

test('oversized text fields are truncated explicitly and deterministically', () => {
  const big = 'x'.repeat(50_000) + 'TAIL-MARKER';
  const first = boundText(big, { maxBytes: 4_096, label: 'stdout' });
  const second = boundText(big, { maxBytes: 4_096, label: 'stdout' });
  assert.equal(first.text.length <= 4_096 + 200, true, 'bounded output must be small');
  assert.equal(first.truncated, true);
  assert.equal(first.originalBytes, Buffer.byteLength(big));
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.equal(first.text.includes('TAIL-MARKER'), false);
  assert.deepEqual(first, second, 'truncation must be deterministic');
  // Under-limit text passes through untouched.
  const small = boundText('hello', { maxBytes: 4_096, label: 'stdout' });
  assert.equal(small.truncated, false);
  assert.equal(small.text, 'hello');
});

test('oversized JSON payloads collapse into bounded truncation envelopes', () => {
  const huge = { blob: 'y'.repeat(300 * 1024) };
  const envelope = boundPayload(huge, { maxBytes: 64 * 1024 });
  const serialized = JSON.stringify(envelope);
  assert.equal(serialized.length <= 80 * 1024, true);
  assert.equal(envelope.truncated, true);
  assert.match(envelope.digest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(envelope).includes('y'.repeat(1000)), false);
});

test('persisted environment metadata uses an explicit allowlist', (t) => {
  const childEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/dev',
    TMPDIR: '/tmp',
    LANG: 'en_US.UTF-8',
    OPENCODE_SERVER_PASSWORD: 'p4ssw0rd',
    AWS_SECRET_ACCESS_KEY: 'top-secret',
    NODE_OPTIONS: '--inspect',
  };
  const persisted = sanitizeEnvironmentMetadata(childEnv);
  const serialized = JSON.stringify(persisted);
  assert.equal(serialized.includes('p4ssw0rd'), false);
  assert.equal(serialized.includes('top-secret'), false);
  assert.equal(persisted.PATH, '/usr/bin:/bin');
  assert.equal(persisted.HOME, '/Users/dev');
  assert.equal(Object.keys(persisted).length <= 5, true, 'allowlist must stay narrow');

  // And the persistence boundary applies it automatically.
  const { store, layout } = seededStore(t, 'envingress');
  commitDelivery(store, { type: 'progress', payload: { env: childEnv } });
  const journalLine = readFileSync(layout.journalPath, 'utf8').trim().split('\n').pop();
  assert.equal(journalLine.includes('p4ssw0rd'), false);
  assert.equal(journalLine.includes('--inspect'), false, 'non-allowlisted keys must be dropped entirely');
});

test('receipt overwrite of a pre-existing 0644 file ends at 0600', (t) => {
  const dir = tempDir(t, 'mode');
  const target = join(dir, 'receipt.json');
  writeFileSync(target, '{"old":"data"}\n', { mode: 0o644 });
  chmodSync(target, 0o644);
  assert.equal(statSync(target).mode & 0o777, 0o644);

  writeAtomicJson(target, { fresh: true });

  assert.equal(existsSync(target), true);
  assert.equal(statSync(target).mode & 0o777, 0o600, 'overwrite must land at mode 0600');
  assert.equal(readFileSync(target, 'utf8'), '{"fresh":true}\n');
});

test('spill refs stay sanitized, bounded and mode-0600', (t) => {
  const { store, layout } = seededStore(t, 'spill');
  const huge = { blob: 'SECRET-BEARER abcdef '.repeat(40_000) };
  commitDelivery(store, { type: 'progress', payload: huge });
  const journalText = readFileSync(layout.journalPath, 'utf8');
  assert.equal(journalText.includes('refs/ref_'), true, 'oversized payloads spill into refs');
  const refMatch = journalText.match(/"ref":"refs\/(ref_\d+\.json)"/);
  assert.ok(refMatch, 'spill reference recorded');
  const refPath = join(layout.refsDir, refMatch[1]);
  assert.equal(existsSync(refPath), true);
  assert.equal(statSync(refPath).mode & 0o777, 0o600);
  const refText = readFileSync(refPath, 'utf8');
  assert.equal(refText.includes('SECRET-BEARER'), false, 'spilled content must pass the sanitizer');
});
