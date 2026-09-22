#!/usr/bin/env node
// Usage:
//   node debate-init.mjs <program-slug> [--dir <base>] [--force]
//        [--strategy <id>] [--roles <file.json>]
//        [--moderator <route:model:effort:lane>]
//        [--debaters "<route:model:effort:lane>;<...>"]
//
// Roles can come from: default file (roles.default.json) < --roles override <
// inline --moderator/--debaters. Strategy: --strategy or default.
import { mkdirSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SKILL_DIR, DEFAULT_TEMP, CONFIG_NAME, defaultRoles, loadStrategies,
  validateRoles, writeJson,
} from './lib/config.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);
const VALUE_FLAGS = ['--dir', '--strategy', '--roles', '--moderator', '--debaters', '--plan'];
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1]));

if (!positional[0]) {
  console.error('Usage: debate-init.mjs <program-slug> [--dir base] [--force] [--plan file] [--strategy id] [--roles file] [--moderator route:model:effort:lane] [--debaters "...;..."]');
  process.exit(2);
}
const program = positional[0];
const base = flag('--dir') || DEFAULT_TEMP;
const force = has('--force');
const root = join(base, program);
const planFlag = flag('--plan');
const existingDraft = join(root, 'debate-plan.draft.md');
const onlyHasDraftPlan = existsSync(root) && !existsSync(join(root, CONFIG_NAME)) && (Boolean(planFlag) || existsSync(existingDraft));

if (existsSync(root) && !force && !onlyHasDraftPlan) {
  console.error(`REFUSE: ${root} already exists (pass --force to scaffold into it)`);
  process.exit(1);
}

const strategies = loadStrategies();
const compose = (d) => {
  const laneFallback = d.route === 'claude-cli' ? 'claude-cli' : d.route === 'coordinator' ? 'coordinator' : d.route;
  if (d.lane) return d;
  return { ...d, lane: laneFallback };
};
const parseSpec = (spec, i = 1) => {
  const [route, model, effort, lane] = spec.split(':');
  return compose({
    id: `D${i}`,
    label: `Phản biện ${i}`,
    route,
    model: model || null,
    effort: effort && effort !== '-' ? effort : null,
    lane: lane || (route === 'claude-cli' ? 'claude-cli' : route === 'coordinator' ? 'coordinator' : route),
    options: route === 'codex' ? { sandbox: 'read-only', ephemeral: true } : route === 'agy' || route === 'opencode' ? { agentMode: 'plan' } : {},
    stance: 'neutral',
  });
};

let roles = defaultRoles();
const rolesFile = flag('--roles');
if (rolesFile) {
  if (!existsSync(rolesFile)) {
    console.error(`Missing roles file: ${rolesFile}`);
    process.exit(1);
  }
  roles = { ...roles, ...JSON.parse(readFileSync(rolesFile, 'utf8')) };
}
if (flag('--strategy')) roles.strategy = flag('--strategy');
if (flag('--moderator')) {
  const m = parseSpec(flag('--moderator'), 0);
  roles.moderator = { ...m, id: 'M0', label: 'Chủ trì', debaterIndex: undefined };
}
if (flag('--debaters')) {
  roles.debaters = flag('--debaters').split(';').filter(Boolean).map((s, i) => parseSpec(s.trim(), i + 1));
}

const errs = validateRoles(roles);
if (errs.length) {
  console.error('INVALID ROLES:\n  ' + errs.join('\n  '));
  process.exit(1);
}
const strategy = strategies[roles.strategy] || strategies['cross-exam'];
roles.strategy = strategy.id;

const rounds = strategy.rounds;

const dirs = ['', 'parts', 'baseline'];
for (const r of rounds) dirs.push(`r${r.n}/out`);
for (const d of roles.debaters) dirs.push(`lanes/${d.lane}`);
if (roles.moderator?.route && roles.moderator.route !== 'coordinator') dirs.push(`lanes/${roles.moderator.lane}`);
for (const d of dirs) mkdirSync(join(root, d), { recursive: true });

const copy = (src, dst) => {
  const from = join(SKILL_DIR, 'templates', src);
  if (!existsSync(from)) throw new Error(`Missing template: ${from}`);
  copyFileSync(from, join(root, dst));
};

copy('context-brief.template.md', 'context-brief.md');
copy('ledger.template.md', 'debate-ledger.md');
copy('final-report.template.md', 'parts/final-report.template.md');

if (planFlag && existsSync(planFlag)) {
  copyFileSync(planFlag, join(root, 'debate-plan.approved.md'));
} else if (existsSync(existingDraft)) {
  copyFileSync(existingDraft, join(root, 'debate-plan.approved.md'));
}

// Map round position -> template set. First = r1, middle = r2, last = r3.
rounds.forEach((r, idx) => {
  const first = idx === 0;
  const last = idx === rounds.length - 1;
  const mid = !first && !last;
  const header = first ? 'r1-header' : mid ? 'r2-header' : 'r3-header';
  const footer = first ? 'r1-footer' : mid ? 'r2-footer' : null;
  copy(`${header}.template.md`, `parts/r${r.n}-header.md`);
  if (footer) copy(`${footer}.template.md`, `parts/r${r.n}-footer.md`);
  if (mid) copy('r2-agenda.template.md', `parts/r${r.n}-agenda.md`);
  if (last) copy('r3-vote.template.md', `parts/r${r.n}-vote.md`);
});

writeJson(join(root, CONFIG_NAME), {
  program,
  created: new Date().toISOString(),
  strategy: strategy.id,
  plan: existsSync(join(root, 'debate-plan.approved.md')) ? 'debate-plan.approved.md' : null,
  moderator: roles.moderator,
  debaters: roles.debaters,
});

const S = join(SKILL_DIR, 'scripts');
console.log(`Debate program scaffolded: ${root}`);
console.log(`Strategy: ${strategy.id} — ${strategy.name} (${rounds.length} vòng)`);
console.log(`Debaters: ${roles.debaters.map((d) => `${d.id}=${d.lane}(${d.route}:${d.model})`).join(', ')}`);
console.log(`Moderator: ${roles.moderator?.route === 'coordinator' ? 'coordinator (agent đang chạy)' : roles.moderator?.lane}`);
console.log('Next steps:');
console.log(`  1. Fill ${join(root, 'context-brief.md')}`);
console.log(`  2. node ${S}/assemble-round.mjs ${root} 1`);
console.log(`     node ${S}/dispatch-round.mjs ${root} 1`);
console.log(`     node ${S}/extract-responses.mjs ${root}/r1`);
