#!/usr/bin/env node
// Usage: node dispatch-round.mjs <program-root> <round-number>
// Env: LANES=lane1,lane2 (subset), plus WEBMCP_AI_CLI/AGY_BIN/CLAUDE_BIN/CODEX_BIN/OPENCODE_BIN.
// Reads debate.config.json + strategy, runs every participant with a prompt file
// for the round in parallel, each into r<N>/out/<lane>.{json,md,events.jsonl,stderr.log}.
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { resolvePlan, participants, routeCommand, promptFileFor } from './lib/config.mjs';

const [root, rArg] = process.argv.slice(2);
const R = Number(rArg);
if (!root || !Number.isInteger(R)) {
  console.error('Usage: dispatch-round.mjs <program-root> <round-number>');
  process.exit(2);
}

const plan = resolvePlan(root);
const only = (process.env.LANES || '').split(',').map((s) => s.trim()).filter(Boolean);
const outDir = join(root, `r${R}`, 'out');
mkdirSync(outDir, { recursive: true });

await quotaPeek();

console.log(`== dispatch round ${R} (strategy=${plan.strategy.id}) ==`);
const jobs = [];
for (const p of participants(plan)) {
  if (only.length && !only.includes(p.lane)) continue;
  const promptFile = promptFileFor(root, R, p);
  if (!existsSync(promptFile)) {
    console.log(`SKIP ${p.id} ${p.lane}: no prompt (${promptFile})`);
    continue;
  }
  const spec = routeCommand(p, { promptFile, outDir, workspace: join(root, 'lanes', p.lane) });
  mkdirSync(spec.workspace, { recursive: true });
  jobs.push(run(p, spec));
}

const results = await Promise.all(jobs);
const failed = results.filter((r) => r.code !== 0);
console.log(`ROUND ${R} DONE (${results.length - failed.length}/${results.length} ok)`);
if (failed.length) {
  console.error('FAILED LANES: ' + failed.map((f) => `${f.lane}(exit=${f.code})`).join(', '));
  process.exitCode = 1;
}

function run(p, spec) {
  return new Promise((resolvePromise) => {
    const out = openSync(spec.stdout, 'w');
    const err = openSync(spec.stderr, 'w');
    const stdin = spec.stdinFile ? openSync(spec.stdinFile, 'r') : 'ignore';
    let child;
    try {
      child = spawn(spec.cmd, spec.args, {
        cwd: spec.workspace,
        env: { ...process.env, ...spec.env },
        stdio: [stdin, out, err],
      });
    } catch (e) {
      closeSync(out); closeSync(err);
      console.log(`${p.id} ${p.lane} SPAWN ERROR ${e.message}`);
      return resolvePromise({ lane: p.lane, code: -1 });
    }
    const t = setTimeout(() => child.kill('SIGKILL'), spec.timeoutSec * 1000);
    child.on('close', (code) => {
      clearTimeout(t);
      closeSync(out); closeSync(err); if (spec.stdinFile) closeSync(stdin);
      console.log(`${p.id} ${p.lane} exit=${code}`);
      resolvePromise({ lane: p.lane, code });
    });
    child.on('error', (e) => {
      clearTimeout(t);
      console.log(`${p.id} ${p.lane} SPAWN ERROR ${e.message}`);
      resolvePromise({ lane: p.lane, code: -1 });
    });
  });
}

async function quotaPeek() {
  console.log('== quota peek ==');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch('http://127.0.0.1:8421/api/quotas?all=1', { signal: ac.signal });
    const d = await res.json();
    for (const dev of d.devices || []) {
      for (const a of dev.accounts || []) {
        if (!['codex', 'claude', 'antigravity'].includes(a.provider)) continue;
        const q = a.quotas || {};
        const p = (q.primary || q.gemini || {}).remainingPercent;
        const cg = (q.claudeGpt || {}).remainingPercent;
        const name = (a.displayName || '').slice(0, 36);
        console.log(`  ${(dev.id || '?').padEnd(8)} ${a.provider.padEnd(11)} ${name.padEnd(36)} primary=${p} claudeGpt=${cg}`);
      }
    }
  } catch (e) {
    console.log(`  quota server unreachable (${e.message})`);
  } finally {
    clearTimeout(timer);
  }
}
