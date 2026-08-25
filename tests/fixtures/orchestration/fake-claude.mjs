#!/usr/bin/env node
// Deterministic fake Claude CLI for fixture tests. Asserts the exact core
// argument contract and refuses unsafe or undocumented invocations.

const args = process.argv.slice(2);
const has = (flag) => cliArgs.includes(flag);
const valueOf = (flag) => {
  const index = cliArgs.indexOf(flag);
  return index === -1 ? null : args[index + 1];
};

const mode = process.env.FAKE_CLAUDE_MODE ?? args[0] ?? 'run';
const cliArgs = process.env.FAKE_CLAUDE_MODE ? args : args.slice(1);

function emit(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

if (mode === 'assert-args') {
  const violations = [];
  if (!has('-p')) violations.push('missing -p');
  if (!has('--output-format') || valueOf('--output-format') !== 'stream-json') violations.push('missing stream-json');
  if (!has('--verbose')) violations.push('missing --verbose');
  if (!has('--no-chrome')) violations.push('missing --no-chrome');

  const hookMode = has('--include-hook-events');
  const safeMode = has('--safe-mode');
  if (hookMode) {
    // Hook mode must NOT include --safe-mode and MUST be fully isolated.
    if (safeMode) violations.push('--safe-mode forbidden with hooks');
    if (!has('--bare')) violations.push('missing --bare');
    if (!has('--settings')) violations.push('missing --settings');
    if (!has('--strict-mcp-config')) violations.push('missing --strict-mcp-config');
    if (!has('--mcp-config')) violations.push('missing --mcp-config');
    const settingsPath = valueOf('--settings');
    try {
      const fs = await import('node:fs');
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const hookDef = parsed?.hooks?.PreToolUse?.[0]?.hooks?.[0];
      if (!hookDef || !Array.isArray(hookDef.args) || typeof hookDef.command !== 'string') {
        violations.push('settings lack a command hook with args array');
      } else if (hookDef.args[0] !== process.argv[1] && !hookDef.args.join(' ').includes('orchestration-hook')) {
        violations.push('command hook does not reference the packaged orchestration hook');
      }
    } catch (error) {
      violations.push(`unreadable settings: ${error.code ?? error.message}`);
    }
  } else if (!safeMode) {
    violations.push('baseline run requires --safe-mode');
  }

  const sessionId = valueOf('--session-id');
  const resumeId = valueOf('--resume');
  if (!sessionId && !resumeId) violations.push('explicit --session-id or --resume required');
  if (has('--continue')) violations.push('--continue is forbidden');

  if (violations.length > 0) {
    process.stderr.write(`FAKE_ARG_VIOLATIONS: ${violations.join('; ')}\n`);
    process.exit(3);
  }

  const effectiveSession = sessionId ?? resumeId;
  emit({ type: 'system', subtype: 'init', session_id: effectiveSession });
  emit({ type: 'result', subtype: 'success', result: `args-ok:${effectiveSession}`, usage: { total_tokens: 5 }, session_id: effectiveSession });
  process.exit(0);
}

if (mode === 'trap-signals') {
  // Stays alive through SIGINT+SIGTERM for a bounded window so tests can
  // prove that signal delivery alone NEVER counts as a stop. When
  // FAKE_QUIET=1 the fixture emits NOTHING: a crashed owner closes our
  // stdio pipes and any write would kill us via EPIPE.
  const quiet = process.env.FAKE_QUIET === '1';
  const say = (line) => {
    if (!quiet) {
      try { process.stdout.write(`${JSON.stringify(line)}\n`); } catch { /* owner gone */ }
    }
  };
  const effectiveSession = valueOf('--session-id') ?? valueOf('--resume');
  say({ type: 'system', subtype: 'init', session_id: effectiveSession });
  let trapped = 0;
  const onSignal = (signal) => {
    trapped += 1;
    say({ type: 'user', trapped, signal });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const holdMs = Number(process.env.FAKE_CLAUDE_TRAP_MS ?? 6000);
  setTimeout(() => {
    say({ type: 'result', subtype: 'success', result: `released:${trapped}`, session_id: effectiveSession });
    process.exit(0);
  }, holdMs);
} else if (mode === 'busy-followup') {
  // First turn stays alive briefly; a second stdin write is a queued follow-up.
  const effectiveSession = valueOf('--session-id') ?? valueOf('--resume');
  emit({ type: 'system', subtype: 'init', session_id: effectiveSession });
  let firstPromptSeen = false;
  let buffer = '';
  if (process.env.WEBMCP_FAKE_STDIN_LOG) {
    const { appendFileSync } = await import('node:fs');
    process.stdin.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        try { appendFileSync(process.env.WEBMCP_FAKE_STDIN_LOG, `${line}\n`); } catch { /* best effort */ }
      }
    });
  }
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      if (!firstPromptSeen) {
        firstPromptSeen = true;
        setTimeout(() => {
          emit({ type: 'result', subtype: 'success', result: `first:${line}`, session_id: effectiveSession });
          process.exit(0);
        }, 200);
      }
    }
  });
} else {
  process.stderr.write(`unsupported FAKE_CLAUDE_MODE: ${mode}\n`);
  process.exit(4);
}
