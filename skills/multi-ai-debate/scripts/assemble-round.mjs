#!/usr/bin/env node
// Usage: node assemble-round.mjs <program-root> <round-number>
// Builds r<N>/prompt[-D<k>|-moderator].md from parts/ templates per the
// effective strategy (round kind, per-debater mode, stances, prior context).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePlan, stanceLine } from './lib/config.mjs';

const [root, rArg] = process.argv.slice(2);
const R = Number(rArg);
if (!root || !Number.isInteger(R)) {
  console.error('Usage: assemble-round.mjs <program-root> <round-number>');
  process.exit(2);
}

const plan = resolvePlan(root);
const round = plan.strategy.rounds.find((r) => r.n === R);
if (!round) {
  console.error(`Round ${R} not in strategy '${plan.strategy.id}' (rounds: ${plan.strategy.rounds.map((r) => r.n).join(',')})`);
  process.exit(2);
}

const readPart = (name) => {
  const p = join(root, 'parts', name);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

function priorContext() {
  if (R === 1) return '';
  // Delphi/aggregate strategies may provide an explicit anonymized digest.
  const explicit = readPart(`r${R}-input.md`);
  if (explicit) return explicit;
  const prevDir = join(root, `r${R - 1}`, 'out');
  let body = '';
  plan.debaters.forEach((d, i) => {
    const f = join(prevDir, `${d.lane}.md`);
    if (existsSync(f)) body += `## Debater ${i + 1}\n\n${readFileSync(f, 'utf8')}\n\n`;
  });
  return body;
}

const contextBody = R === 1 ? readFileSync(join(root, 'context-brief.md'), 'utf8') : '';
const prior = priorContext();
const agenda = readPart(`r${R}-agenda.md`);
const footer = readPart(`r${R}-footer.md`);
const baseHeader = readPart(`r${R}-header.md`);
const priorTitle = R > 1 ? `# NGỮ CẢNH VÒNG ${R - 1} (ẩn danh)` : '';

const joinParts = (xs) => xs.filter((x) => x && x.trim()).join('\n\n---\n\n');

// Inject debater line + stance, adding them as a preamble when the template
// has no placeholder (e.g. r2-header reused for a per-debater strategy round).
function personalize(header, debaterLine, stance) {
  const hasDeb = header.includes('{{DEBATER_LINE}}');
  const hasStance = header.includes('{{STANCE}}');
  let h = header.replaceAll('{{DEBATER_LINE}}', debaterLine).replaceAll('{{STANCE}}', stanceLine(stance));
  const pre = [];
  if (!hasDeb) pre.push(debaterLine);
  if (!hasStance) pre.push(stanceLine(stance));
  return pre.length ? `${pre.join('\n\n')}\n\n${h}` : h;
}

const perDebater = round.perDebater || plan.debaters.some((d) => d.stance !== 'neutral');
mkdirSync(join(root, `r${R}`), { recursive: true });

if (perDebater) {
  plan.debaters.forEach((d, i) => {
    const head = personalize(baseHeader, `Bạn là Debater ${i + 1} (${d.label}).`, d.stance);
    const prompt = joinParts([head, R === 1 ? contextBody : '', priorTitle, prior, agenda, footer]);
    writeFileSync(join(root, `r${R}`, `prompt-D${i + 1}.md`), prompt);
  });
  console.log(`wrote r${R}/prompt-D1..D${plan.debaters.length}.md (per-debater)`);
} else {
  const head = baseHeader.replaceAll('{{DEBATER_LINE}}', '').replaceAll('{{STANCE}}', '');
  const prompt = joinParts([head, contextBody, priorTitle, prior, agenda, footer]);
  writeFileSync(join(root, `r${R}`, 'prompt.md'), prompt);
  console.log(`wrote r${R}/prompt.md`);
}

const modPart = readPart(`r${R}-moderator.md`);
if (modPart) {
  const head = personalize(baseHeader, 'Bạn là Chủ trì (trọng tài).', 'neutral');
  writeFileSync(join(root, `r${R}`, 'prompt-moderator.md'), joinParts([head, priorTitle, prior, modPart]));
  console.log(`wrote r${R}/prompt-moderator.md`);
}
