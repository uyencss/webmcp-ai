#!/usr/bin/env node
// Usage: node extract-responses.mjs <round-dir> [--check]
// Reads r<N>/out/<lane>.{json,md} per debate.config.json routes and writes
// normalized <round-dir>/out/<lane>.md, printing word count + SHA-256.
//
// AGY brain attribution rules (2026-09-12 hardening):
//  (a) an explicit brain path inside response.text wins when it exists;
//  (b) otherwise a brain artifact may be attributed ONLY to the lane that
//      produced it: its mtime must fall inside that lane's own execution
//      window (json mtime - timing.elapsedMs - tolerance .. json mtime) and
//      exactly ONE such candidate longer than response.text must exist;
//  (c) any ambiguity (0 or >1 candidates, missing timing) keeps response.text
//      and prints a typed warning;
//  (d) if the same artifact path would resolve for more than one lane, it is
//      dropped for every lane (never attribute another lane's file).
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolvePlan, participants, extractorFor } from './lib/config.mjs';

const args = process.argv.slice(2);
const roundDir = args.find((a) => !a.startsWith('--'));
const checkOnly = args.includes('--check');
if (!roundDir) {
  console.error('Usage: extract-responses.mjs <round-dir> [--check]');
  process.exit(2);
}
const outDir = join(roundDir, 'out');
const root = dirname(roundDir);
if (!existsSync(outDir)) {
  console.error(`Missing ${outDir}`);
  process.exit(2);
}

const plan = resolvePlan(root);
const BRAIN = join(homedir(), '.gemini', 'antigravity-cli', 'brain');
// The wrapper writes out/<lane>.json just after the child exits, so the lane's
// real start is jsonMtime - elapsedMs plus a small write latency.
const START_TOLERANCE_MS = 15 * 1000;
const sha = (s) => createHash('sha256').update(s).digest('hex');
let failed = 0;

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(join(outDir, file), 'utf8'));
  } catch (e) {
    console.error(`${file}: parse error: ${e.message}`);
    failed++;
    return null;
  }
};

function wrapperText(d) {
  if (!d) return null;
  if (d.ok === false) {
    console.error(`PROVIDER_ERROR ${d.error?.code}: ${d.error?.message ?? ''}`);
    failed++;
    return null;
  }
  return d.response?.text ?? d.text ?? '';
}

function claudeText(d) {
  if (!d) return null;
  if (d.is_error) {
    console.error(`CLAUDE_ERROR ${d.subtype ?? 'unknown'}`);
    failed++;
    return null;
  }
  return d.result ?? '';
}

function explicitBrainLink(text) {
  const m = text.match(/(\/Users\/[^\s)"']+\/antigravity-cli\/brain\/[^\s)"']+\.md)/);
  if (m && existsSync(m[1])) return { path: m[1], content: readFileSync(m[1], 'utf8') };
  return null;
}

function brainArtifactsInWindow(startMs, endMs) {
  const found = [];
  if (!existsSync(BRAIN)) return found;
  for (const id of readdirSync(BRAIN)) {
    const d = join(BRAIN, id);
    let names;
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      const p = join(d, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.mtimeMs < startMs || st.mtimeMs > endMs) continue;
      found.push({ path: p, mtime: st.mtimeMs, size: st.size });
    }
  }
  return found;
}

// Returns { path, content, via } on success or { none: true, reason } where
// reason is bounded and safe to print.
function resolveBrain(text, { refMs, elapsedMs }) {
  const link = explicitBrainLink(text);
  if (link) return { path: link.path, content: link.content, via: 'explicit-link' };
  if (!existsSync(BRAIN)) return { none: true, reason: 'dir-missing' };
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return { none: true, reason: 'no-timing' };
  const startMs = refMs - elapsedMs - START_TOLERANCE_MS;
  const endMs = refMs;
  const minBytes = Buffer.byteLength(text, 'utf8');
  const candidates = brainArtifactsInWindow(startMs, endMs).filter((c) => c.size > minBytes);
  if (candidates.length === 1) {
    const winner = candidates[0];
    return { path: winner.path, content: readFileSync(winner.path, 'utf8'), via: 'execution-window' };
  }
  return { none: true, reason: candidates.length === 0 ? 'no-candidate' : `ambiguous(${candidates.length})` };
}

// Pass 1: read every lane, resolve text without writing anything.
const entries = [];
for (const p of participants(plan)) {
  const lane = p.lane;
  const kind = extractorFor(p.route);
  const src = join(outDir, kind === 'md' ? `${lane}.md` : `${lane}.json`);
  if (!existsSync(src)) {
    console.log(`${lane}: SKIP (no ${src.split('/').pop()})`);
    continue;
  }
  let text;
  let elapsedMs = null;
  let provenance = src.split('/').pop();
  if (kind === 'md') {
    text = readFileSync(src, 'utf8');
  } else {
    const d = readJson(src.split('/').pop());
    if (d === null) continue;
    text = kind === 'claude' ? claudeText(d) : wrapperText(d);
    if (text == null) continue;
    const parsedElapsed = Number(d?.timing?.elapsedMs);
    elapsedMs = Number.isFinite(parsedElapsed) && parsedElapsed >= 0 ? parsedElapsed : null;
  }
  if (!text.trim()) {
    console.error(`${lane}: EMPTY output`);
    failed++;
    continue;
  }
  let resolved = null;
  if (p.route === 'agy') {
    const result = resolveBrain(text, { refMs: statSync(src).mtimeMs, elapsedMs });
    if (result.none) console.log(`${lane}: WARN brain-${result.reason}; keeping response.text`);
    else resolved = result;
  }
  entries.push({ lane, route: p.route, src, text, provenance, resolved });
}

// Cross-lane safety: an artifact claimed by more than one lane is never used.
const claims = new Map();
for (const e of entries) {
  if (e.resolved) claims.set(e.resolved.path, (claims.get(e.resolved.path) ?? 0) + 1);
}
for (const e of entries) {
  if (e.resolved && claims.get(e.resolved.path) > 1) {
    console.log(`${e.lane}: WARN brain-shared(${claims.get(e.resolved.path)} lanes); keeping response.text`);
    e.resolved = null;
  }
}

// Pass 2: materialize.
for (const e of entries) {
  let text = e.text;
  let provenance = e.provenance;
  if (e.resolved) {
    text = e.resolved.content;
    provenance = `brain:${e.resolved.path}`;
    console.log(`${e.lane}: using brain artifact ${e.resolved.path} (${e.resolved.via})`);
  }
  // AGY answer convention: newline-terminated. Brain artifacts already end
  // with \n; text-mode answers are normalized so extraction reproduces the
  // accepted golden files byte-for-byte. Other routes keep provider bytes
  // unchanged (their existing goldens/hashes stay byte-stable).
  if (e.route === 'agy' && !text.endsWith('\n')) text += '\n';
  const wc = text.split(/\s+/).filter(Boolean).length;
  const h = sha(text);
  if (!checkOnly) writeFileSync(join(outDir, `${e.lane}.md`), text);
  console.log(`${e.lane}: ${wc} words, sha256=${h.slice(0, 16)}… (${provenance})`);
}

process.exit(failed ? 1 : 0);
