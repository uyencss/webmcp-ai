import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AiCliError } from '../errors.mjs';
import { REVIEW_RESULT_JSON_SCHEMA } from '../review-result.mjs';

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

// Bounded, safe review-target capability requirements for the Codex native
// Git diff reviewer (`codex exec review`). Verified 2026-09-29 against
// installed codex-cli 0.157.1 `exec review --help`: it exposes
// --uncommitted/--base/--commit/--ephemeral/--ignore-user-config/
// --ignore-rules/--output-schema/--output-last-message/-c/--config but does
// NOT expose --sandbox or --color (those belong to the portable `exec`
// lane's CODEX_REVIEW_REQUIRED_FLAGS above, never reused here — sandboxing
// for `exec review` is expressed only via `-c sandbox_mode="..."`).
// --skip-git-repo-check is available on `exec review` too but is
// intentionally never passed on the target lane: the wrapper proves the
// workspace is a Git repository itself (typed REVIEW_TARGET_NOT_GIT) before
// ever building this invocation, so codex never needs to be told to skip the
// check it exists to enforce.
//
// IMPORTANT real-CLI finding (canary 2026-09-29, codex-cli 0.157.1): despite
// `exec review --help` listing --uncommitted/--base/--commit as ordinary
// options, the installed binary hard-rejects combining any of them with a
// custom `[PROMPT]` argument — including the `-` stdin marker this wrapper
// needs to deliver the JSON-contract instructions — with a clap argument
// conflict (exit 2, "the argument '--uncommitted' cannot be used with
// '[PROMPT]'"), before any model spawn. Separately, even *without* a custom
// prompt, the built-in --uncommitted/--base/--commit review flow does not
// honor --output-schema at all: its final message is free prose from a
// hardcoded review scaffold, not a schema-shaped object, so it can never
// satisfy webmcp-ai-review-result/1. Both behaviors were confirmed against
// the real binary, not assumed. buildCodexReviewTargetInvocation below
// therefore never emits --uncommitted/--base/--commit as argv: the diff
// scope is instead named in the prompt (buildReviewPrompt's reviewTarget
// branch in src/review.mjs) and the model gathers it itself via `git diff`/
// `git show` inside the read-only sandbox, while --output-schema/
// --output-last-message stay fully effective. These three flags remain in
// the required-capability probe below purely as an installed-CLI drift
// signal (proof the `exec review` subcommand still knows about target
// scoping conceptually), not because the adapter passes them.
export const CODEX_REVIEW_TARGET_REQUIRED_FLAGS = Object.freeze([
  '--uncommitted',
  '--base',
  '--commit',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--output-schema',
  '--output-last-message',
  '-c',
  '--config',
]);

export function validateCodexReviewTargetSupport(helpText) {
  const text = String(helpText ?? '');
  const missing = CODEX_REVIEW_TARGET_REQUIRED_FLAGS.filter((flag) => !helpContainsToken(text, flag));
  if (missing.length > 0) {
    throw new AiCliError('PROVIDER_CAPABILITY_DRIFT', `Installed Codex CLI lacks review-target flags: ${missing.join(', ')}`, {
      exitCode: 2,
      details: { capability: 'reviewTarget', missing },
    });
  }
  return true;
}

const REVIEW_TARGET_TYPES = Object.freeze(['uncommitted', 'base', 'commit']);
// Never starts `-` (argv injection guard for a value that flows straight
// into `--base <ref>` / `--commit <sha>`), bounded length, no path
// separators beyond what a real branch/ref name uses.
const REVIEW_TARGET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/**
 * Validate and canonicalize a caller-supplied `reviewTarget`. Returns null
 * for an absent/empty-object target (the empty object is an explicit
 * "no target" declaration so the portable review lane stays byte-identical),
 * or the canonical `{type}` / `{type,ref}` / `{type,sha}` shape. Throws typed
 * INVALID_INPUT for any malformed shape (unknown/extra keys, wrong type,
 * missing/unsafe ref or sha, null bytes) before any spawn or filesystem
 * side effect. Idempotent: re-normalizing an already-canonical object is
 * safe, so both the client/review resolver and this adapter's buildInvocation
 * can each call it as their own layer of defense.
 */
export function normalizeReviewTarget(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AiCliError('INVALID_INPUT', 'reviewTarget must be an object', { exitCode: 2 });
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return null;
  const type = value.type;
  if (typeof type !== 'string' || !REVIEW_TARGET_TYPES.includes(type)) {
    throw new AiCliError('INVALID_INPUT', `reviewTarget.type must be one of ${REVIEW_TARGET_TYPES.join('|')}`, {
      exitCode: 2,
      details: { field: 'reviewTarget.type' },
    });
  }
  const allowedKeys = type === 'uncommitted' ? ['type'] : type === 'base' ? ['type', 'ref'] : ['type', 'sha'];
  const extra = keys.filter((key) => !allowedKeys.includes(key));
  if (extra.length > 0) {
    throw new AiCliError('INVALID_INPUT', `reviewTarget has unknown field(s): ${extra.join(', ')}`, {
      exitCode: 2,
      details: { field: 'reviewTarget', extra },
    });
  }
  if (type === 'uncommitted') return { type: 'uncommitted' };
  const field = type === 'base' ? 'ref' : 'sha';
  const raw = value[field];
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\u0000') || !REVIEW_TARGET_REF_PATTERN.test(raw)) {
    throw new AiCliError('INVALID_INPUT', `reviewTarget.${field} must be a non-empty safe ${field === 'ref' ? 'branch/ref' : 'commit sha'} name`, {
      exitCode: 2,
      details: { field: `reviewTarget.${field}` },
    });
  }
  return { type, [field]: raw };
}

/**
 * Shared gate reused by both the client/review resolver (before any spawn or
 * temp allocation) and, redundantly, by this adapter's buildInvocation (final
 * defense for direct callers). A non-empty reviewTarget requires taskIntent
 * review, provider codex, and the absence of sessionId (resume scope is not
 * provable for a native diff review). Returns null when there is nothing to
 * enforce (absent/empty target).
 */
export function resolveReviewTargetForRequest(rawReviewTarget, { providerId, sessionId = null, taskIntent = null } = {}) {
  const normalized = normalizeReviewTarget(rawReviewTarget);
  if (!normalized) return null;
  if (taskIntent !== 'review') {
    throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', 'reviewTarget requires taskIntent review', {
      exitCode: 2,
      details: { capability: 'reviewTarget', taskIntent: taskIntent ?? null },
    });
  }
  if (providerId !== 'codex') {
    throw new AiCliError('UNSUPPORTED_CAPABILITY', `Provider ${providerId} does not support reviewTarget`, {
      exitCode: 2,
      details: { capability: 'reviewTarget' },
    });
  }
  if (sessionId) {
    throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', 'reviewTarget cannot be combined with sessionId; resume scope is not provable for a native diff review', {
      exitCode: 2,
      details: { capability: 'reviewTarget' },
    });
  }
  return normalized;
}

/**
 * Build the native `exec review` invocation for a validated reviewTarget.
 * Never copies flags from the portable `exec` lane: no --sandbox, --color,
 * or --skip-git-repo-check. Sandboxing is expressed only via
 * `-c sandbox_mode="read-only" -c approval_policy="never"`. The prompt is
 * still delivered over stdin via the trailing `-` positional, exactly like
 * the portable lane. Reuses the same webmcp-ai-codex-* temp-dir lifecycle
 * (mode 0600, unconditional cleanup) as the portable lane, but the schema
 * file always carries the frozen REVIEW_RESULT_JSON_SCHEMA rather than a
 * caller-supplied schema (review never accepts a caller schema).
 *
 * Never emits --uncommitted/--base/--commit (see the real-CLI finding above
 * CODEX_REVIEW_TARGET_REQUIRED_FLAGS): `target` only shapes the prompt
 * (src/review.mjs buildReviewPrompt), which instructs the model to gather
 * the named diff itself via read-only `git` commands.
 */
function buildCodexReviewTargetInvocation(request) {
  const dir = mkdtempSync(join(tmpdir(), 'webmcp-ai-codex-'));
  const outputFile = join(dir, 'last-message.txt');
  const schemaFile = join(dir, 'output-schema.json');
  try {
    writeFileSync(schemaFile, `${JSON.stringify(REVIEW_RESULT_JSON_SCHEMA, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    throw error;
  }
  const args = [
    'exec', 'review',
    '-c', 'sandbox_mode="read-only"',
    '-c', 'approval_policy="never"',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--output-schema', schemaFile,
    '--output-last-message', outputFile,
    ...(request.model ? ['-m', request.model] : []),
    ...(request.effort ? ['-c', `model_reasoning_effort="${request.effort}"`] : []),
    '-',
  ];
  return {
    args,
    stdin: request.prompt,
    readOutput: () => readFileSync(outputFile, 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
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
    // Final-defense re-normalization for direct adapter callers (mirrors the
    // client/review resolver's resolveReviewTargetForRequest gate, which
    // already ran for every normal generate()/review() path). A non-empty
    // reviewTarget outside taskIntent review is a contradiction, never a
    // silently-ignored extra field.
    const normalizedReviewTarget = normalizeReviewTarget(request.reviewTarget);
    if (normalizedReviewTarget && taskIntent !== 'review') {
      throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', 'Codex reviewTarget requires taskIntent review', {
        exitCode: 2,
        details: { taskIntent: taskIntent ?? null, capability: 'reviewTarget' },
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
      if (normalizedReviewTarget) {
        if (request.sessionId) {
          throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', 'Codex reviewTarget cannot be combined with sessionId; resume scope is not provable for a native diff review', {
            exitCode: 2,
            details: { taskIntent, capability: 'reviewTarget' },
          });
        }
        if (request.codexReviewTargetHelpText !== undefined && request.codexReviewTargetHelpText !== null) {
          validateCodexReviewTargetSupport(request.codexReviewTargetHelpText);
        }
        return buildCodexReviewTargetInvocation(request);
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
