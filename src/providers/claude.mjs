import { AiCliError } from '../errors.mjs';

// Defence-in-depth reviewer flags. Read tools are allowlisted; writes are
// explicitly denied; Chrome stays disabled; safe-mode stays on for bounded
// reviewer sessions. The exact flag set is validated against `claude --help`
// via validateClaudeReviewSupport (used by providers inspect
// --task-intent review); drift never falls back to full.
export const CLAUDE_REVIEW_ARGS = Object.freeze({
  permissionMode: 'dontAsk',
  tools: 'Read,Glob,Grep',
  disallowedTools: 'Edit,Write,NotebookEdit',
});

function helpContainsToken(helpText, token) {
  const escaped = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s,=<>()[\\]"'])${escaped}(?=$|[\\s,=<>()[\\]"'])`).test(String(helpText ?? ''));
}

export function validateClaudeReviewSupport(helpText) {
  const text = String(helpText ?? '');
  const required = [
    '-p', '--permission-mode', '--tools', '--disallowedTools', '--safe-mode', '--no-chrome',
    '--output-format', 'json', 'stream-json', '--verbose', '--no-session-persistence',
    '--resume', '--model', '--effort',
  ];
  const missing = required.filter((flag) => !helpContainsToken(text, flag));
  if (missing.length > 0) {
    throw new AiCliError('PROVIDER_CAPABILITY_DRIFT', `Installed Claude CLI lacks reviewer flags: ${missing.join(', ')}`, {
      exitCode: 2,
      details: { capability: 'review', missing },
    });
  }
  return true;
}

export const claudeProvider = {
  id: 'claude',
  name: 'Claude Code',
  envBin: 'CLAUDE_BIN',
  defaultBin: 'claude',
  capabilities: {
    structuredOutput: true,
    stdinPrompt: true,
    explicitResume: true,
    modelDiscovery: false,
    toolPolicies: ['provider-default'],
    // Machine-readable mirror of buildInvocation below: no AGY agentMode;
    // review/compose/implement are supported vNext intents (review needs the
    // installed help probe); plan needs a separate contract and is rejected.
    // Compose rides the portable lane only: the client gate exempts
    // `taskIntent compose` + `compose-only` from the legacy toolPolicy check,
    // so the adapter's text-only, disposable-workspace branch is reachable
    // while `toolPolicies` stays ['provider-default'] and the legacy
    // no-taskIntent compose-only lane remains rejected (F6 follow-up).
    agentModes: { supported: false, values: [], default: null, reason: 'Claude does not support AGY agentMode' },
    taskIntents: {
      review: { supported: true, accessProfile: 'review-readonly', probe: 'help' },
      compose: { supported: true, accessProfile: 'compose-only' },
      implement: { supported: true, accessProfiles: ['full'] },
      plan: { supported: false, reason: 'requires a separate webmcp-ai-plan-result/1 contract' },
    },
  },
  buildInvocation(request) {
    if (request.agentMode) {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'Claude does not support AGY agentMode', {
        exitCode: 2,
      });
    }
    if (request.agent) {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'Claude does not support AGY custom agents', {
        exitCode: 2,
      });
    }
    // Portable vNext intents. No vNext intent selects provider Plan mode
    // (Claude has none). `plan` is uniformly rejected until a separate
    // webmcp-ai-plan-result/1 contract exists. `review` uses the exact
    // defence-in-depth mapping; `compose` falls through to the generic
    // text-only path with a disposable workspace; `implement` requires
    // explicit `full` (native passthrough) and never silently widens.
    const taskIntent = request.taskIntent ?? null;
    if (typeof taskIntent === 'string' && !['review', 'compose', 'implement', 'plan'].includes(taskIntent)) {
      throw new AiCliError('TASK_INTENT_INVALID', `Unknown taskIntent: ${taskIntent}`, {
        exitCode: 2,
        details: { taskIntent },
      });
    }
    if (taskIntent === 'plan') {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'Claude does not support taskIntent plan; use a separate webmcp-ai-plan-result/1 contract', {
        exitCode: 2,
        details: { taskIntent },
      });
    }
    if (taskIntent === 'compose') {
      const profile = request.accessProfile ?? 'compose-only';
      if (profile !== 'compose-only') {
        throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', `Claude compose requires accessProfile compose-only (got ${profile})`, {
          exitCode: 2,
          details: { taskIntent, accessProfile: profile },
        });
      }
      // Fall through to generic text-only compose path below (no Plan mode).
    }
    if (taskIntent === 'implement') {
      const profile = request.accessProfile ?? null;
      if (profile !== 'full') {
        throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', 'Claude implement requires an explicit write accessProfile (full)', {
          exitCode: 2,
          details: { taskIntent, accessProfile: profile },
        });
      }
      // Fall through to full passthrough below.
    }
    // Portable reviewer lane (taskIntent review only): the live spawn lane
    // (generate with taskIntent review, covering review()/ai.review/CLI
    // review) version-probes `claude --help` before spawn via
    // ensureClaudeReviewSupport in src/client.mjs; providers inspect
    // --task-intent review probes the same way. An explicit
    // request.claudeHelpText, when supplied, is still validated here for
    // direct adapter callers. Here we emit the exact defence-in-depth set:
    // dontAsk + read-tools allowlist + explicit write deny + safe-mode +
    // no-chrome + no-session-persistence. MCP stays disabled by never
    // passing --mcp-config and by the safe child-env allowlist (MCP vars are
    // not in SAFE_EXACT). No provider Plan mode (agentMode already rejected
    // above). Auth behavior preserved (no auth flags touched). Drift throws
    // PROVIDER_CAPABILITY_DRIFT via the validator; this lane never falls
    // back to full.
    if (taskIntent === 'review') {
      const profile = request.accessProfile ?? 'review-readonly';
      if (profile !== 'review-readonly') {
        throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', `Claude review requires accessProfile review-readonly (got ${profile})`, {
          exitCode: 2,
          details: { taskIntent, accessProfile: profile },
        });
      }
      if (request.claudeHelpText !== undefined && request.claudeHelpText !== null) {
        validateClaudeReviewSupport(request.claudeHelpText);
      }
      // Native telemetry: when the caller requested advisory events, use
      // `stream-json --verbose`; otherwise use single-blob `json`.
      // process-forwarding a final JSON blob is not live telemetry.
      // The review CLI intentionally disallows --stream/--events (explicit
      // contract, see src/cli.mjs reviewInput); library review() rejects
      // onStream/onEvent for the same reason. Generate with events uses the
      // native stream form here.
      const wantsEvents = request.eventsRequested === true;
      const args = [
        '-p',
        '--permission-mode', CLAUDE_REVIEW_ARGS.permissionMode,
        '--tools', CLAUDE_REVIEW_ARGS.tools,
        '--disallowedTools', CLAUDE_REVIEW_ARGS.disallowedTools,
        '--safe-mode',
        '--no-chrome',
        ...(wantsEvents ? ['--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json']),
        ...(request.sessionId ? ['--resume', request.sessionId] : ['--no-session-persistence']),
        ...(request.model ? ['--model', request.model] : []),
        ...(request.effort ? ['--effort', request.effort] : []),
        ...(request.schema ? ['--json-schema', JSON.stringify(request.schema)] : []),
      ];
      return { args, stdin: request.prompt };
    }
    // Full passthrough (opt-in via --full): drop the text-only hard deny so
    // the child runs like the native CLI with full folder + tool access.
    // MCP stays disabled by omission (no --mcp-config) and safe-env filtering.
    const isFull = request.accessProfile === 'full';
    const wantsStream = request.eventsRequested === true;
    const args = [
      '-p',
      ...(!isFull ? ['--tools', '', '--safe-mode'] : []),
      '--no-chrome',
      ...(wantsStream ? ['--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json']),
      ...(request.sessionId ? ['--resume', request.sessionId] : ['--no-session-persistence']),
      ...(request.model ? ['--model', request.model] : []),
      ...(request.effort ? ['--effort', request.effort] : []),
      ...(request.schema ? ['--json-schema', JSON.stringify(request.schema)] : []),
    ];
    return { args, stdin: request.prompt };
  },
  parseOutput({ stdout }) {
    const trimmed = stdout.trim();
    // Single-blob `json` fast path.
    try {
      const parsed = JSON.parse(trimmed);
      const structured = parsed.structured_output ?? null;
      const rawText = parsed.result ?? parsed.response ?? parsed.text ?? structured ?? '';
      return {
        text: typeof rawText === 'string' ? rawText.trim() : JSON.stringify(rawText),
        structured,
        sessionId: parsed.session_id ? String(parsed.session_id) : null,
      };
    } catch {
      // Fall through to NDJSON stream-json handling below.
    }
    // Native `stream-json --verbose` NDJSON: scan lines for the final result
    // payload. Each line is an independent JSON event; the last event
    // carrying result/response/text wins. session_id is captured when present.
    let text = '';
    let structured = null;
    let sessionId = null;
    for (const line of trimmed.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      let event;
      try {
        event = JSON.parse(t);
      } catch {
        continue;
      }
      if (event && typeof event === 'object') {
        if (event.session_id) sessionId = String(event.session_id);
        if (event.sessionID) sessionId = String(event.sessionID);
        const candidate = event.result ?? event.response ?? event.text ?? event.structured_output ?? null;
        if (typeof candidate === 'string' && candidate.trim()) text = candidate.trim();
        else if (candidate !== null && candidate !== undefined && typeof candidate === 'object') {
          try {
            text = JSON.stringify(candidate);
          } catch {}
        }
        if (event.structured_output !== undefined && event.structured_output !== null) structured = event.structured_output;
      }
    }
    if (text) return { text, structured, sessionId };
    return { text: trimmed, structured: null, sessionId };
  },
};
