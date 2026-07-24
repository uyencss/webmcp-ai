#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const args = process.argv.slice(2);
const provider = process.env.FAKE_PROVIDER || basename(process.argv[1]).split('-')[0];

if (args.includes('--version') || args.includes('-V') || args.includes('-v')) {
  process.stdout.write(`${provider}-cli 9.9.9\n`);
  process.exit(0);
}

if (args[0] === 'models') {
  process.stdout.write('model-one\nmodel-two\n');
  process.exit(0);
}

if (args[0] === 'agents' || args[0] === 'agent') {
  process.stdout.write('Available agents:\n  webmcp-node-executor\n  code-reviewer\n');
  process.exit(0);
}

if (process.env.FAKE_DELAY_MS) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_DELAY_MS)));
}

if (process.env.FAKE_EXIT_CODE) {
  process.stderr.write('simulated provider failure with secret=redact-me\n');
  process.exit(Number(process.env.FAKE_EXIT_CODE));
}

if (process.env.FAKE_EMPTY === '1') {
  process.exit(0);
}

const stdin = readFileSync(0, 'utf8');
const promptIndex = args.indexOf('-p');
const prompt = stdin || (promptIndex >= 0 ? args[promptIndex + 1] : '');
const reply = `reply:${provider}:${prompt}`;
const outputIndex = args.indexOf('--output-last-message');

if (outputIndex >= 0) {
  writeFileSync(args[outputIndex + 1], reply);
  process.stdout.write('{"type":"completed"}\n');
} else if (provider === 'claude') {
  process.stdout.write(JSON.stringify({ result: reply, session_id: 'claude-session' }));
} else {
  process.stdout.write(reply);
}
