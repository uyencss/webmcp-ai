import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_AGY_BRAIN_DIR = join('.gemini', 'antigravity-cli', 'brain');

function walkMarkdown(root, depth, out) {
  if (depth < 0) return;
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkMarkdown(path, depth - 1, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(path);
  }
}

/**
 * Collect AGY brain artifacts written during a bounded window. AGY's print
 * mode can return only a short summary while the full answer is persisted as a
 * Markdown file under the brain directory; this recovers it without leaking the
 * machine-local path to the caller. Returns newest-first with internal text.
 */
export function resolveAgyArtifacts({ brainDir, sinceMs, untilMs, maxDepth = 2 } = {}) {
  if (!brainDir || !Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) return [];
  const files = [];
  walkMarkdown(brainDir, maxDepth, files);
  const artifacts = [];
  for (const path of files) {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.mtimeMs < sinceMs || stats.mtimeMs > untilMs) continue;
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    artifacts.push({
      path,
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
      mtimeMs: stats.mtimeMs,
      digest: createHash('sha256').update(text).digest('hex').slice(0, 16),
    });
  }
  return artifacts.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
