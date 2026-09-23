#!/usr/bin/env node

import { runJevCli } from '../src/jev/cli.mjs';

runJevCli(process.argv.slice(2), process.env).then(
  (code) => { process.exitCode = code; },
  (error) => {
    const err = error && typeof error === 'object' ? error : {};
    process.stderr.write(`${err.code || 'INTERNAL_ERROR'}: ${err.message || String(error)}\n`);
    process.exitCode = err.exitCode || 1;
  },
);
