import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { getProvider, resolveProviderBin } from '../src/providers/index.mjs';

test('resolveProviderBin canonicalizes symlinked absolute paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bin-resolve-'));
  try {
    const real = join(dir, 'real-bin.mjs');
    writeFileSync(real, '#!/usr/bin/env node\n', { mode: 0o755 });
    chmodSync(real, 0o755);
    const link = join(dir, 'link-bin');
    symlinkSync(real, link);
    const provider = getProvider('codex');
    // realpathSync resolves the full chain (on macOS even tmpdir's /var
    // prefix), so compare against the canonical expectation, not the raw join.
    assert.equal(resolveProviderBin(provider, { CODEX_BIN: link }), realpathSync(link));
    assert.notEqual(link, realpathSync(link));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveProviderBin keeps missing absolute paths verbatim for CLI_NOT_INSTALLED', () => {
  const provider = getProvider('codex');
  const missing = '/definitely/not/here/codex-missing-bin';
  assert.equal(resolveProviderBin(provider, { CODEX_BIN: missing }), missing);
});

test('resolveProviderBin leaves bare names to PATH lookup', () => {
  const provider = getProvider('opencode');
  assert.equal(resolveProviderBin(provider, {}), 'opencode');
  assert.equal(resolveProviderBin(provider, { OPENCODE_BIN: 'opencode' }), 'opencode');
});
