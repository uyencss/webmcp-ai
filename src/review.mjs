import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

import {
  computeCapabilityDigests,
  validateCapabilityRequest,
} from './capabilities.mjs';
import { generate } from './client.mjs';
import { AiCliError } from './errors.mjs';
import { getProvider } from './providers/index.mjs';
import { resolveReviewTargetForRequest } from './providers/codex.mjs';
import { normalizeOpencodeProfile } from './providers/opencode.mjs';
import { parseReviewOutput, REVIEW_RESULT_SCHEMA } from './review-result.mjs';
import { mapWorkspaceToRemote, selectClaudeHost } from './remote.mjs';

export const REVIEW_TASK_DEFAULT = 'review';
export const REVIEW_PROFILE_DEFAULT = 'review-readonly';

function digestPrompt(prompt) {
  return createHash('sha256').update(String(prompt)).digest('hex').slice(0, 16);
}

function requireNonEmptyPrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new AiCliError('INVALID_INPUT', 'prompt must be a non-empty string', { exitCode: 2 });
  }
  return prompt;
}

function explicitOpencodeProfile(provider, profile) {
  if (provider.id !== 'opencode' || profile === null || profile === undefined || profile === '') return null;
  return normalizeOpencodeProfile(profile);
}

/**
 * Portable review instruction. The reviewer must answer with ONLY the
 * versioned JSON result so validateReviewResult can type malformed or
 * plan-only output as REVIEW_RESULT_INCOMPLETE. No shell, no writes, no
 * evidence execution — evidence stays Coordinator-owned. Frozen contract:
 * findings use {id,severity:critical|high|medium|low,file,line,message,
 * recommendation}; file/line may be omitted only for architectural findings.
 *
 * `reviewTarget` (Codex native Git diff review only) swaps the trailing
 * instruction: the sandbox is genuinely read-only there (enforced by
 * `-c sandbox_mode="read-only"`), so "do not run shell commands" is replaced
 * with the more precise "do not attempt any write" and the scope is named
 * explicitly, with the model told to gather the actual diff itself via
 * read-only `git` commands (Codex's own `--uncommitted`/`--base`/`--commit`
 * flags cannot be combined with this custom prompt — canary 2026-09-29 on
 * codex-cli 0.157.1 — so the scope lives in the prompt instead of argv; see
 * src/providers/codex.mjs). The target variant additionally instructs a
 * fail-closed `blocked` verdict when the named scope cannot actually be
 * resolved (unknown ref, a failing `git` command, or empty diff context) so
 * an unresolvable scope can never silently fall through to reviewing
 * whatever the model happens to see and returning a false `approve`. The
 * portable (no reviewTarget) text is unchanged byte-for-byte.
 */
export function buildReviewPrompt(prompt, { reviewTarget = null } = {}) {
  const body = requireNonEmptyPrompt(prompt);
  const contract = `Respond with ONLY compact JSON matching schema "${REVIEW_RESULT_SCHEMA}": {"schema":"${REVIEW_RESULT_SCHEMA}","verdict":"approve|request-changes|blocked|indeterminate","summary":"<one-line reason>"}. Include "blockedReason" when verdict is "blocked". Findings, when present, must be [{id:"F1",severity:"critical|high|medium|low",file:"<path>",line:<n>,message:"<defect>",recommendation:"<repair>"}]; omit file/line only for architectural findings. Do not emit plans, diffs, or prose outside that JSON.`;
  if (reviewTarget) {
    const scope = reviewTarget.type === 'uncommitted'
      ? 'the uncommitted changes (staged, unstaged, and untracked) in this Git repository; use `git status` and `git diff`/`git diff --cached` yourself to see them'
      : reviewTarget.type === 'base'
        ? `the changes in this Git repository against the base ref "${reviewTarget.ref}"; use \`git diff ${reviewTarget.ref}...HEAD\` yourself to see them`
        : `the changes introduced by commit "${reviewTarget.sha}" in this Git repository; use \`git show ${reviewTarget.sha}\` yourself to see them`;
    const failClosed = 'If you cannot determine exactly this scope via the named read-only git command (unknown ref, git error, or empty diff context), return verdict "blocked" with a "blockedReason" describing what was unresolvable — never review a different scope instead.';
    return `Review ${scope}.\n\n${body}\n\n${contract} The sandbox is read-only; do not attempt any write. ${failClosed}`;
  }
  return `${body}\n\n${contract} Do not run shell commands, edit files, or access the network.`;
}

/**
 * Strict review-only gate. ai.review and `webmcp-ai review` accept ONLY
 * taskIntent review (absent defaults to review). plan/compose/implement are
 * rejected here — before any provider lookup side effect beyond registry
 * validation and before any buildInvocation — so invalid requests never
 * spawn and never touch caller files (F1). plan is explicitly unsupported
 * for the review tool (needs a separate webmcp-ai-plan-result/1 contract).
 * Unknown intents -> TASK_INTENT_INVALID; known-but-wrong intents/profiles
 * -> TASK_INTENT_ACCESS_CONFLICT so callers can branch deterministically.
 */
function resolveReviewOnlyIntent({ taskIntent = null, accessProfile = null } = {}) {
  const hasIntent = taskIntent !== undefined && taskIntent !== null;
  if (hasIntent && typeof taskIntent !== 'string') {
    throw new AiCliError('INVALID_INPUT', 'ai.review requires taskIntent review', {
      exitCode: 2,
      details: { taskIntent: taskIntent ?? null },
    });
  }
  const intent = hasIntent ? String(taskIntent).trim() : REVIEW_TASK_DEFAULT;
  if (hasIntent && !intent) {
    throw new AiCliError('INVALID_INPUT', 'ai.review requires taskIntent review', {
      exitCode: 2,
      details: { taskIntent: taskIntent ?? null },
    });
  }
  if (!['review', 'plan', 'compose', 'implement'].includes(intent)) {
    throw new AiCliError('TASK_INTENT_INVALID', `Unknown taskIntent: ${String(taskIntent)} (ai.review requires review)`, {
      exitCode: 2,
      details: { taskIntent: taskIntent ?? null },
    });
  }
  if (intent === 'plan') {
    throw new AiCliError('UNSUPPORTED_CAPABILITY', 'ai.review does not support taskIntent plan; use a separate webmcp-ai-plan-result/1 contract', {
      exitCode: 2,
      details: { taskIntent: intent },
    });
  }
  if (intent !== 'review') {
    throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', 'ai.review requires taskIntent review', {
      exitCode: 2,
      details: { taskIntent: taskIntent ?? null },
    });
  }
  // Force review-readonly. Any explicit write-capable or alternative
  // read-only profile is a contradiction for the review tool.
  if (accessProfile !== undefined && accessProfile !== null) {
    if (typeof accessProfile !== 'string') {
      throw new AiCliError('INVALID_INPUT', `ai.review requires accessProfile ${REVIEW_PROFILE_DEFAULT}`, {
        exitCode: 2,
        details: { accessProfile: accessProfile ?? null, taskIntent: intent },
      });
    }
    const profile = String(accessProfile).trim();
    if (profile !== REVIEW_PROFILE_DEFAULT) {
      throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', `ai.review requires accessProfile ${REVIEW_PROFILE_DEFAULT}`, {
        exitCode: 2,
        details: { accessProfile: accessProfile ?? null, taskIntent: intent },
      });
    }
  }
  return { taskIntent: 'review', accessProfile: REVIEW_PROFILE_DEFAULT };
}

function rejectReviewForbiddenFields(input) {
  // ai.review is read-only. Reject every write-capable or privileged field
  // before any spawn. allowedWriteRoots is rejected when non-empty; empty
  // arrays are tolerated as explicit no-write declarations.
  const forbiddenPresent = [];
  for (const field of ['agentMode', 'agent', 'toolPolicy', 'schema', 'gatewayCapabilityHandle', 'gatewayHandle', 'mcpConfig']) {
    if (input[field] !== undefined && input[field] !== null) {
      // toolPolicy/schema/gateway/MCP must never appear for review.
      throw new AiCliError('INVALID_INPUT', `${field} is not allowed for ai.review`, {
        exitCode: 2,
        details: { field },
      });
    }
  }
  void forbiddenPresent;
  const writeRoots = input.allowedWriteRoots;
  if (writeRoots !== undefined && writeRoots !== null) {
    if (!Array.isArray(writeRoots)) {
      throw new AiCliError('INVALID_INPUT', 'allowedWriteRoots must be an array', { exitCode: 2 });
    }
    if (writeRoots.length > 0) {
      throw new AiCliError('INVALID_INPUT', 'allowedWriteRoots is not allowed for ai.review (read-only)', {
        exitCode: 2,
        details: { field: 'allowedWriteRoots' },
      });
    }
  }
  // projectId/storeRevisions are provenance, not writes — allowed.
  // allowedReadRoots/protectedPaths are read-boundary declarations — allowed
  // (protectedPaths empty or read-scoped is harmless for read-only).
}

/**
 * Resolve a portable review request without spawning any provider.
 * This is the single resolver reused by review(), the ai.review
 * tool-call, and the `review --dry-run` CLI inspection.
 *
 * Order guarantees F1: review-only gate + forbidden-field gate run before
 * provider.buildInvocation, and AGY is rejected before any preview that
 * could install/clean a compose guard against caller cwd.
 */
export function resolveReviewRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AiCliError('INVALID_INPUT', 'input must be an object', { exitCode: 2 });
  }
  // 1. Review-only gate (no spawn, no filesystem).
  const resolvedIntent = resolveReviewOnlyIntent({ taskIntent: input.taskIntent ?? null, accessProfile: input.accessProfile ?? null });
  // 2. Forbidden write/privilege fields (no spawn).
  rejectReviewForbiddenFields(input);
  // 3. Provider registry lookup (no spawn, no filesystem).
  const provider = getProvider(input.provider);
  const opencodeProfile = explicitOpencodeProfile(provider, input.opencodeProfile);
  // 4. AGY early rejection before any preview (F1/F5: never build AGY argv
  // that would embed prompt text, never install compose guard).
  if (provider.id === 'agy') {
    throw new AiCliError('UNSUPPORTED_CAPABILITY', 'AGY does not support preventive deny-write review mode', {
      exitCode: 2,
      details: { capability: 'review', taskIntent: resolvedIntent.taskIntent, accessProfile: resolvedIntent.accessProfile },
    });
  }
  // 4b. reviewTarget (Codex native Git diff review). Validated before any
  // capability/preview work: non-empty target requires provider codex and no
  // sessionId. An absent/empty-object target resolves to null and leaves the
  // portable review lane byte-identical for every provider.
  const reviewTarget = resolveReviewTargetForRequest(input.reviewTarget ?? null, {
    providerId: provider.id,
    sessionId: input.sessionId || null,
    taskIntent: resolvedIntent.taskIntent,
  });
  let sessionAction = input.sessionAction ?? (input.sessionId ? 'resume' : null);
  if (sessionAction !== null && sessionAction !== undefined) {
    if (sessionAction !== 'resume' && sessionAction !== 'fork') {
      throw new AiCliError('INVALID_INPUT', "sessionAction must be 'resume' or 'fork'", {
        exitCode: 2,
        details: { field: 'sessionAction' },
      });
    }
    if (!input.sessionId) {
      throw new AiCliError('INVALID_INPUT', 'sessionAction requires sessionId', {
        exitCode: 2,
        details: { field: 'sessionAction' },
      });
    }
  }
  const prompt = requireNonEmptyPrompt(input.prompt);
  const timeoutMs = input.timeoutMs ?? undefined;
  if (timeoutMs !== undefined) {
    const n = Number(timeoutMs);
    if (!Number.isFinite(n) || n <= 0) {
      throw new AiCliError('INVALID_INPUT', 'timeoutMs must be a positive number', { exitCode: 2 });
    }
  }
  const maxOutputBytes = input.maxOutputBytes ?? undefined;
  if (maxOutputBytes !== undefined && maxOutputBytes !== null) {
    const n = Number(maxOutputBytes);
    if (!Number.isFinite(n) || n <= 0) {
      throw new AiCliError('INVALID_INPUT', 'maxOutputBytes must be a positive number', { exitCode: 2 });
    }
  }
  // 5. Capability boundary (fail-closed, no spawn). For compatibility an
  // omitted workspace defaults to cwd inside validateCapabilityRequest; the
  // read boundary is therefore cwd and preview below never writes to it for
  // the supported review providers (claude/codex/opencode use temp dirs or
  // stdin). Callers should pass an explicit workspace so the read boundary
  // is auditable; dry-run digests prove which directory was used without
  // leaking absolute paths. Review never writes caller files.
  const capability = validateCapabilityRequest({
    accessProfile: resolvedIntent.accessProfile,
    toolPolicy: undefined,
    workspace: input.workspace,
    allowedReadRoots: input.allowedReadRoots,
    allowedWriteRoots: [],
    protectedPaths: input.protectedPaths,
    projectId: input.projectId,
    storeRevisions: input.storeRevisions,
    gatewayCapabilityHandle: undefined,
    gatewayHandle: undefined,
    mcpConfig: undefined,
  });
  // 6. Provider-level validation preview (no spawn). Build throwaway
  // invocation purely to surface provider hardening errors (e.g. Claude
  // agent rejection, OpenCode agent mapping) before real spawn, then clean
  // up temp dirs immediately. Never passes caller cwd to a mutating guard:
  // review lane never uses compose-only, and AGY already rejected.
  const previewWorkspace = capability.workspace;
  let previewArgs = null;
  const preview = provider.buildInvocation({
    prompt: buildReviewPrompt(prompt, { reviewTarget }),
    model: input.model || null,
    effort: input.effort || null,
    schema: null,
    sessionId: input.sessionId || null,
    sessionAction: sessionAction ?? null,
    agentMode: null,
    agent: null,
    toolPolicy: 'provider-default',
    accessProfile: capability.accessProfile,
    taskIntent: resolvedIntent.taskIntent,
    reviewTarget,
    workspace: previewWorkspace,
    allowedReadRoots: capability.allowedReadRoots,
    allowedWriteRoots: [],
    protectedPaths: capability.protectedPaths,
    projectId: capability.projectId,
    storeRevisions: capability.storeRevisions,
    opencodeProfile,
    timeoutMs: timeoutMs !== undefined ? Number(timeoutMs) : 600_000,
    env: input.env || {},
  });
  previewArgs = [...(preview.args || [])];
  try {
    preview.cleanup?.();
  } catch {
    // Preview cleanup must never fail the resolution.
  }
  const digests = computeCapabilityDigests({
    workspace: capability.workspace,
    allowedReadRoots: capability.allowedReadRoots,
    allowedWriteRoots: [],
    protectedPaths: capability.protectedPaths,
    projectId: capability.projectId,
    storeRevisions: capability.storeRevisions,
    accessProfile: capability.accessProfile,
  });
  return {
    provider,
    taskIntent: resolvedIntent.taskIntent,
    accessProfile: resolvedIntent.accessProfile,
    capability,
    prompt,
    reviewTarget,
    ...(provider.id === 'opencode' ? {
      opencodeProfile,
      opencodeProfileSource: opencodeProfile === null ? 'unresolved' : 'explicit',
    } : {}),
    model: input.model || null,
    effort: input.effort || null,
    sessionId: input.sessionId || null,
    sessionAction: sessionAction ?? null,
    agentMode: null,
    agent: null,
    timeoutMs: timeoutMs !== undefined ? Number(timeoutMs) : undefined,
    maxOutputBytes: maxOutputBytes !== undefined ? maxOutputBytes : undefined,
    previewArgs,
    digests,
    promptDigest: digestPrompt(prompt),
  };
}

function sanitizeDryRunArgs(args, capability, sessionId = null) {
  const roots = [
    capability.workspace,
    ...(capability.allowedReadRoots || []),
    ...(capability.protectedPaths || []),
  ].filter(Boolean).sort((a, b) => b.length - a.length);
  const tmpRoot = tmpdir();
  const sessionValue = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  return (args || []).map((arg) => {
    if (typeof arg !== 'string') return '<redacted>';
    let out = arg;
    if (sessionValue && out === sessionValue) return '<session>';
    for (const root of roots) {
      if (out === root) { out = '<workspace>'; break; }
      if (out.startsWith(`${root}/`)) { out = `<workspace>${out.slice(root.length)}`; break; }
    }
    // Codex temp output/schema paths and any tmpdir leakage -> placeholder.
    if (out.includes(tmpRoot)) return '<tmp>';
    if (out.includes('last-message.txt') || out.includes('output-schema.json')) return '<tmp>';
    // Absolute paths that survived (e.g. leaked workspace) -> placeholder.
    if (out.startsWith('/') && out.length > 1 && out !== '<workspace>' && !out.startsWith('<workspace>') && !out.startsWith('<tmp>')) {
      // Keep known-safe flags verbatim; redact path-like values.
      if (out.includes('/')) return '<path>';
    }
    return out;
  });
}

/**
 * Sanitized dry-run inspection. Reuses resolveReviewRequest so the preview
 * can never drift from the real path. Never spawns, never includes prompt
 * text, secrets, absolute workspace paths, provider temp paths or
 * output-file paths. Digests/placeholders only.
 */
export function describeReviewDryRun(input = {}) {
  const resolved = resolveReviewRequest(input);
  const resumed = resolved.sessionId !== null && resolved.sessionId !== undefined;
  let transportMeta = null;
  if (resolved.provider.id === 'claude' && selectClaudeHost(input.env || process.env) !== 'local') {
    const hostId = selectClaudeHost(input.env || process.env);
    let workspaceStatus = '<mapped>';
    try {
      mapWorkspaceToRemote({ hostId, env: input.env || process.env, localWorkspace: resolved.capability.workspace });
      workspaceStatus = '<mapped>';
    } catch {
      workspaceStatus = '<unmapped>';
    }
    transportMeta = {
      type: 'ssh',
      host: hostId,
      workspace: workspaceStatus,
      verified: false,
    };
  }
  return {
    ok: true,
    dryRun: true,
    schema: REVIEW_RESULT_SCHEMA,
    provider: resolved.provider.id,
    ...(transportMeta ? { transport: transportMeta } : {}),
    taskIntent: resolved.taskIntent,
    accessProfile: resolved.accessProfile,
    reviewTarget: resolved.reviewTarget,
    ...(resolved.provider.id === 'opencode' ? {
      opencodeProfile: resolved.opencodeProfile,
      opencodeProfileSource: resolved.opencodeProfileSource,
    } : {}),
    model: resolved.model,
    // A resumed session is intentionally represented only as a boolean. The
    // provider session identifier is a resumable capability and must not enter
    // a sanitized preview envelope or argv echo.
    sessionId: resumed ? '<resumed-session>' : null,
    sessionAction: resolved.sessionAction ?? (resolved.sessionId ? 'resume' : null),
    resumed,
    args: sanitizeDryRunArgs(resolved.previewArgs, resolved.capability, resolved.sessionId),
    capability: resolved.digests,
    promptDigest: resolved.promptDigest,
  };
}

/**
 * Shared sanitizer for generate dry-run (F6). Same redaction policy as
 * review dry-run; caller supplies already-resolved capability + args.
 */
export function sanitizePreviewArgs(args, capability) {
  return sanitizeDryRunArgs(args, capability);
}

/**
 * One-shot portable reviewer. Validates strictly, delegates execution to
 * generate() with the same resolver, then types the provider text via
 * webmcp-ai-review-result/1. Malformed, plan-only, or schema-mismatched
 * output throws REVIEW_RESULT_INCOMPLETE.
 *
 * Explicit events contract: the review lane disallows live telemetry
 * (onStream/onEvent). The review CLI rejects --stream/--events and this
 * library rejects onStream/onEvent with INVALID_INPUT, so callers cannot
 * mistake heuristic forwarding for native `stream-json --verbose` telemetry.
 * Generate remains the events-capable lane (Claude uses native stream-json
 * there when events are requested).
 *
 * Fresh-auditor note: a resumed review (input.sessionId present) returns
 * `resumed:true` and must not be treated as fresh final-auditor evidence.
 * Omit sessionId for a fresh audit. Legacy generate resume is unchanged.
 */
export async function review(input = {}) {
  if (typeof input.onStream === 'function' || typeof input.onEvent === 'function') {
    throw new AiCliError('INVALID_INPUT', 'ai.review does not support stream/events; use generate for live telemetry', {
      exitCode: 2,
      details: { field: typeof input.onStream === 'function' ? 'onStream' : 'onEvent' },
    });
  }
  const resolved = resolveReviewRequest(input);
  const env = input.env || process.env;
  const reviewPrompt = buildReviewPrompt(resolved.prompt, { reviewTarget: resolved.reviewTarget });
  const result = await generate({
    provider: resolved.provider.id,
    prompt: reviewPrompt,
    model: resolved.model,
    effort: input.effort || null,
    opencodeProfile: resolved.opencodeProfile,
    sessionId: resolved.sessionId || null,
    sessionAction: resolved.sessionAction || null,
    agentMode: null,
    agent: null,
    toolPolicy: undefined,
    accessProfile: resolved.accessProfile,
    reviewTarget: resolved.reviewTarget,
    workspace: input.workspace,
    allowedReadRoots: input.allowedReadRoots,
    allowedWriteRoots: [],
    protectedPaths: input.protectedPaths,
    projectId: input.projectId,
    storeRevisions: input.storeRevisions,
    gatewayCapabilityHandle: undefined,
    gatewayHandle: undefined,
    mcpConfig: undefined,
    timeoutMs: resolved.timeoutMs,
    maxOutputBytes: resolved.maxOutputBytes,
    taskIntent: resolved.taskIntent,
    env,
    signal: input.signal,
  });
  const parsed = parseReviewOutput({ text: result.response.text, structured: result.response.structured });
  const resumed = resolved.sessionId !== null && resolved.sessionId !== undefined;
  return {
    ok: true,
    provider: result.provider,
    model: result.model,
    ...(result.transport ? { transport: result.transport } : {}),
    resumed,
    review: {
      schema: parsed.schema, verdict: parsed.verdict, summary: parsed.summary, findings: parsed.findings,
      ...(parsed.blockedReason !== undefined ? { blockedReason: parsed.blockedReason } : {}),
    },
    response: result.response,
    // Review callers only need freshness, never a raw provider session
    // identifier. Resumption is already represented by `resumed`; keeping the
    // identifier out of library/CLI/tool envelopes prevents session leakage.
    session: { id: null, resumable: false },
    timing: result.timing,
    capability: result.capability,
  };
}
