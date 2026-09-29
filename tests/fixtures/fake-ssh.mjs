#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const mode = process.env.FAKE_SSH_MODE || 'ok';

if (process.env.FAKE_SSH_LOG) {
  try {
    appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ mode, argv: process.argv.slice(2) }) + '\n');
  } catch {}
}

if (mode === 'unreachable') {
  process.stderr.write('ssh: connect to host remote port 22: Connection refused\n');
  process.exit(255);
}

if (mode === 'hang') {
  // Sleep longer than the outer timeout (outer timeout is timeoutMs + 30s)
  await new Promise((resolve) => setTimeout(resolve, 120_000));
  process.exit(0);
}

if (mode === 'fail-nonzero') {
  process.stderr.write('ssh: fatal error\n');
  process.exit(1);
}

// Parse args: drop -o <val> pairs
const rawArgs = process.argv.slice(2);
let i = 0;
while (i < rawArgs.length) {
  if (rawArgs[i] === '-o' && i + 1 < rawArgs.length) {
    i += 2;
  } else {
    break;
  }
}

// Next is sshHost
const sshHost = rawArgs[i];
const trailing = rawArgs.slice(i + 1);

if (!trailing.length) {
  process.exit(0);
}

const targetBin = trailing[0];
const targetArgs = trailing.slice(1);

try {
  execFileSync(targetBin, targetArgs, { stdio: 'inherit' });
  process.exit(0);
} catch (err) {
  if (err.status != null) {
    process.exit(err.status);
  }
  if (err.signal) {
    process.kill(process.pid, err.signal);
  }
  process.exit(1);
}
