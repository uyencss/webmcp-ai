#!/usr/bin/env node
// Deterministic fake CLI worker used only by fixture tests. Modes are selected
// through FAKE_WORKER_MODE; every mode exits deterministically.

const mode = process.env.FAKE_WORKER_MODE ?? 'ordered';

function write(text) {
  process.stdout.write(`${text}\n`);
}

switch (mode) {
  case 'ordered': {
    process.stderr.write('hello-from-stderr\n', () => {
      process.stdout.write('hello-from-stdout\n', () => {
        process.stdout.write('second-line\n', () => process.exit(0));
      });
    });
    break;
  }
  case 'big': {
    // Wait for the full flush before exiting or the output is truncated.
    process.stdout.write('x'.repeat(300 * 1024), () => process.exit(0));
    break;
  }
  case 'child': {
    const { spawn } = await import('node:child_process');
    const sleeping = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
      detached: false,
    });
    write(`child-started:${sleeping.pid}`);
    // Stay alive until interrupted; the child is killed with the group.
    setInterval(() => {}, 1000);
    break;
  }
  case 'ignore-sigint': {
    process.on('SIGINT', () => {
      write('sigint-ignored');
    });
    write('ready');
    setInterval(() => {}, 500);
    break;
  }
  default: {
    write('ready');
    setTimeout(() => process.exit(0), 200);
  }
}
