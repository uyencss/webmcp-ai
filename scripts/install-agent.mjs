#!/usr/bin/env node
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillName = 'webmcp-ai-cli';
const source = fileURLToPath(new URL(`../skills/${skillName}`, import.meta.url));
const targets = {
  codex: join(homedir(), '.codex', 'skills'),
  gemini: join(homedir(), '.gemini', 'config', 'skills'),
  claude: join(homedir(), '.claude', 'skills'),
};

function install(target) {
  const destination = join(targets[target], skillName);
  mkdirSync(targets[target], { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  process.stdout.write(`Installed ${skillName} for ${target}: ${destination}\n`);
}

const requested = process.argv[2] || 'all';
if (requested === '--help' || requested === '-h') {
  process.stdout.write('Usage: node scripts/install-agent.mjs <codex|gemini|claude|all>\n');
} else if (requested === 'all') {
  Object.keys(targets).forEach(install);
} else if (Object.hasOwn(targets, requested)) {
  install(requested);
} else {
  process.stderr.write('Target must be codex, gemini, claude, or all.\n');
  process.exitCode = 2;
}
