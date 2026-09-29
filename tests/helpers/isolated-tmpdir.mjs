import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Eliminates global-tmpdir races across concurrent test files under `npm test`.
 *
 * Concurrent test processes share the system temporary directory. When a test
 * asserts that no temporary artifacts leak by inspecting `tmpdir()`, sibling test
 * processes legitimately creating their own temp directories (e.g. `webmcp-ai-agy-*`,
 * `webmcp-ai-codex-*`, `webmcp-ai-*-compose-`, `webmcp-ai-dryrun-*`) cause spurious
 * race failures.
 *
 * This helper isolates `node:os` `tmpdir()` for the duration of the test: `tmpdir()`
 * reads `process.env.TMPDIR` fresh on POSIX on every call. Because Node test files
 * run in separate processes, mutating `process.env.TMPDIR` isolates per-file
 * concurrency without affecting sibling test processes.
 *
 * @param {import('node:test').TestContext} t - Test context providing a `.after()` hook.
 * @param {string} [prefix='webmcp-ai-isolated-tmp-'] - Prefix for the private temp directory.
 * @returns {string} Absolute path to the isolated temporary directory.
 */
export function isolateTmpdir(t, prefix = 'webmcp-ai-isolated-tmp-') {
  const previous = process.env.TMPDIR;
  const isolated = mkdtempSync(join(tmpdir(), prefix));
  process.env.TMPDIR = isolated;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previous;
    }
    rmSync(isolated, { recursive: true, force: true });
  });
  return isolated;
}
