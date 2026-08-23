#!/usr/bin/env node
// Deterministic fake Codex CLI for fixture tests. Enforces the documented
// exec --json contract and refuses forbidden flags such as
// --skip-git-repo-check or ambient config dependence.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const inferredMode = args.includes('--help')
  ? (args.includes('resume') ? 'resume-help' : 'help')
  : 'assert-args';
const mode = process.env.FAKE_CODEX_MODE ?? inferredMode;
const cliArgs = args;

if (mode === 'help') {
  if (!cliArgs.includes('exec') || !cliArgs.includes('--help')) {
    process.stderr.write('expected exec --help\n');
    process.exit(2);
  }
  process.stdout.write('Usage: codex exec [--json] [--sandbox <mode>] ...\n');
  process.exit(0);
}

if (mode === 'resume-help') {
  if (!cliArgs.includes('resume') || !cliArgs.includes('--help')) {
    process.stderr.write('expected exec resume --help\n');
    process.exit(2);
  }
  process.stdout.write('Usage: codex exec resume [--json] <thread-id> -\n');
  process.exit(0);
}

if (mode === 'assert-args' || mode === 'run') {
  const violations = [];
  const expectedCore = ['--json', '--sandbox', '--ignore-user-config', '--ignore-rules', '--color', 'never'];
  for (const flag of expectedCore) {
    if (!cliArgs.includes(flag)) violations.push(`missing ${flag}`);
  }
  const sandboxIndex = cliArgs.indexOf('--sandbox');
  if (sandboxIndex !== -1 && cliArgs[sandboxIndex + 1] !== 'read-only') {
    violations.push('alpha sandbox must be read-only');
  }
  if (has('--skip-git-repo-check')) violations.push('--skip-git-repo-check is forbidden');

  // The prompt always arrives on stdin as the final '-' target implies.
  let prompt = '';
  try {
    prompt = readFileSync(0, 'utf8').trim();
  } catch {
    prompt = '';
  }
  if (!prompt && !process.env.FAKE_CODEX_ALLOW_EMPTY_STDIN) violations.push('stdin prompt required');

  const isResume = cliArgs[0] === 'resume' || (cliArgs[1] === 'resume');
  const threadId = isResume ? cliArgs.find((arg, index) => index > 0 && arg.startsWith('thr_')) : null;
  if (isResume && !threadId) violations.push('resume requires an explicit runtime-created thread id');

  if (violations.length > 0) {
    process.stderr.write(`FAKE_ARG_VIOLATIONS: ${violations.join('; ')}\n`);
    process.exit(3);
  }

  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: threadId ?? 'thr_new_1' })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { total_tokens: 3 } })}\n`);
  process.stdout.write(`PROMPT_ECHO:${prompt.slice(0, 40)}\n`);
  process.exit(0);
}

process.stderr.write(`unsupported FAKE_CODEX_MODE: ${mode}\n`);
process.exit(4);
