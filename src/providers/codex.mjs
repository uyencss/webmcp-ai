import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AiCliError } from '../errors.mjs';

// Bounded, safe review-lane capability requirements for the Codex reviewer.
// Probed via `codex exec --help` (no model) before spawn and in
// `providers inspect --task-intent review`. The fresh path uses
// `exec --sandbox read-only --ephemeral --ignore-user-config --ignore-rules
// --skip-git-repo-check --output-last-message --color`; the resume path uses `exec resume -c
// sandbox_mode="..."` (and omits --sandbox/--color). We require the fresh
// primitives plus the resume mapping requirements that are exposed by the
// installed help (`resume` subcommand and `-c/--config`). The
// `sandbox_mode="..."` key is a config value rather than a CLI flag, so it
// cannot be proven by substring matching; the adapter owns that mapping and
// tests it separately. Missing flags fail closed with typed drift; only
// bounded flag names are reported, never paths or raw help.
export const CODEX_REVIEW_REQUIRED_FLAGS = Object.freeze([
  'exec',
  '--sandbox',
  'read-only',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--skip-git-repo-check',
  '--output-last-message',
  '--color',
  'resume',
  '-c',
  '--config',
]);

function helpContainsToken(helpText, token) {
  const escaped = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // CLI help commonly renders short options as `-c, --config`; accept the
  // punctuation around an option but never let `--color` satisfy `-c`.
  return new RegExp(`(?:^|[\\s,=<>()[\\]"'])${escaped}(?=$|[\\s,=<>()[\\]"'])`).test(String(helpText ?? ''));
}

export function validateCodexReviewSupport(helpText) {
  const text = String(helpText ?? '');
  const missing = CODEX_REVIEW_REQUIRED_FLAGS.filter((flag) => !helpContainsToken(text, flag));
  if (missing.length > 0) {
    throw new AiCliError('PROVIDER_CAPABILITY_DRIFT', `Installed Codex CLI lacks reviewer flags: ${missing.join(', ')}`, {
      exitCode: 2,
      details: { capability: 'review', missing },
    });
  }
  return true;
}

export const codexProvider = {
  id: 'codex',
  name: 'Codex CLI',
  envBin: 'CODEX_BIN',
  defaultBin: 'codex',
  capabilities: {
    structuredOutput: true,
    stdinPrompt: true,
    explicitResume: true,
    modelDiscovery: false,
    toolPolicies: ['provider-default', 'compose-only'],
    // Machine-readable mirror of buildInvocation below: Codex has no AGY
    // agentMode; review/compose/implement are supported vNext intents (review
    // needs the installed help probe); plan needs a separate contract. Writes
    // exist only as `full` (workspace-write); bounded-edit is rejected.
    agentModes: { supported: false, values: [], default: null, reason: 'Codex does not support AGY agentMode' },
    taskIntents: {
      review: { supported: true, accessProfile: 'review-readonly', probe: 'help' },
      compose: { supported: true, accessProfile: 'compose-only' },
      implement: { supported: true, accessProfiles: ['full'], note: 'bounded-edit is unsupported; use full' },
      plan: { supported: false, reason: 'requires a separate webmcp-ai-plan-result/1 contract' },
    },
  },
  buildInvocation(request) {
    if (request.agentMode) {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'Codex does not support AGY agentMode', {
        exitCode: 2,
      });
    }
    if (request.agent) {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'Codex does not support AGY custom agents', {
        exitCode: 2,
      });
    }
    // Portable intents: no vNext intent selects provider Plan mode (Codex has
    // none; sandbox is the authority). `plan` is uniformly rejected until a
    // separate webmcp-ai-plan-result/1 contract exists — never silently
    // executed through the read-only sandbox.
    // Validation runs before any filesystem side effect so a rejected vNext
    // request never leaks an empty temp directory.
    const taskIntent = request.taskIntent ?? null;
    if (typeof taskIntent === 'string' && !['review', 'compose', 'implement', 'plan'].includes(taskIntent)) {
      throw new AiCliError('TASK_INTENT_INVALID', `Unknown taskIntent: ${taskIntent}`, {
        exitCode: 2,
        details: { taskIntent },
      });
    }
    if (taskIntent === 'plan') {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'Codex does not support taskIntent plan; use a separate webmcp-ai-plan-result/1 contract', {
        exitCode: 2,
        details: { taskIntent },
      });
    }
    if (taskIntent === 'compose') {
      const profile = request.accessProfile ?? 'compose-only';
      if (profile !== 'compose-only') {
        throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', `Codex compose requires accessProfile compose-only (got ${profile})`, {
          exitCode: 2,
          details: { taskIntent, accessProfile: profile },
        });
      }
    }
    if (taskIntent === 'review') {
      const profile = request.accessProfile ?? 'review-readonly';
      if (profile !== 'review-readonly') {
        throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', `Codex review requires accessProfile review-readonly (got ${profile})`, {
          exitCode: 2,
          details: { taskIntent, accessProfile: profile },
        });
      }
      if (request.codexHelpText !== undefined && request.codexHelpText !== null) {
        validateCodexReviewSupport(request.codexHelpText);
      }
    }
    if (taskIntent === 'implement' && request.accessProfile !== 'full' && request.accessProfile !== 'bounded-edit') {
      throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', 'Codex implement requires an explicit write accessProfile', {
        exitCode: 2,
        details: { taskIntent, accessProfile: request.accessProfile ?? null },
      });
    }
    // Codex writes are proven only via `full` (workspace-write). bounded-edit
    // has no Codex-native primitive and is rejected at the client admission
    // layer; a direct adapter call with bounded-edit fails here rather than
    // silently running read-only.
    if (taskIntent === 'implement' && request.accessProfile === 'bounded-edit') {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'Codex does not support bounded-edit; use full or opencode', {
        exitCode: 2,
        details: { taskIntent, accessProfile: request.accessProfile },
      });
    }

    // Serialize the schema before allocating the temp dir: a circular or
    // BigInt schema must fail without stranding webmcp-ai-codex-*.
    const schemaPayload = request.schema ? `${JSON.stringify(request.schema, null, 2)}\n` : null;
    const dir = mkdtempSync(join(tmpdir(), 'webmcp-ai-codex-'));
    const outputFile = join(dir, 'last-message.txt');
    const schemaFile = request.schema ? join(dir, 'output-schema.json') : null;
    try {
      if (schemaFile) writeFileSync(schemaFile, schemaPayload, { mode: 0o600 });
    } catch (error) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      throw error;
    }

    // Full passthrough (opt-in via --full): explicit workspace-write sandbox.
    // Omitting the sandbox would fall back to the config default (usually
    // read-only), so full must state workspace-write to get real folder +
    // tool access. danger-full-access is never used.
    // Truthful scope: full still passes --ephemeral --ignore-user-config
    // --ignore-rules, so ambient user config/MCP is NOT inherited — only the
    // workspace-write sandbox (folder + tools) is granted. Only the opencode
    // provider keeps ambient operator config/MCP in full mode.
    // Resume limitation (codex 0.152.1): `exec resume` rejects --sandbox/-s
    // and --color, so the resume path expresses the same sandbox via
    // `-c sandbox_mode="..."` (accepted on both exec and resume) and omits
    // --color. Bounded resume stays read-only; full resume stays
    // workspace-write.
    const isFull = request.accessProfile === 'full';
    const sandboxMode = isFull ? 'workspace-write' : 'read-only';
    const shared = [
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--output-last-message', outputFile,
      ...(schemaFile ? ['--output-schema', schemaFile] : []),
      ...(request.model ? ['--model', request.model] : []),
      ...(request.effort ? ['-c', `model_reasoning_effort="${request.effort}"`] : []),
    ];

    const args = request.sessionId
      ? ['exec', 'resume', '-c', `sandbox_mode="${sandboxMode}"`, ...shared, request.sessionId, '-']
      : ['exec', '--sandbox', sandboxMode, ...shared, '--color', 'never', '-'];

    return {
      args,
      stdin: request.prompt,
      readOutput: () => readFileSync(outputFile, 'utf8'),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  },
  parseOutput({ stdout, invocation }) {
    let text = stdout.trim();
    try {
      text = invocation.readOutput().trim();
    } catch {
      // Fall back to stdout for forward compatibility and test doubles.
    }
    let structured = null;
    try {
      structured = JSON.parse(text);
    } catch {
      // Plain text is a valid response when no schema was requested.
    }
    // Codex `exec` does not echo a resumable session id. Resume is still
    // supported via an explicitly supplied --session-id (obtained out of band),
    // so this adapter never surfaces one to auto-continue.
    return { text, structured, sessionId: null };
  },
};
