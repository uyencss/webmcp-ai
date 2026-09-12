import {
  accessSync, constants, mkdtempSync, rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { DEFAULT_AGY_BRAIN_DIR, resolveAgyArtifacts } from './artifacts.mjs';
import {
  buildFullChildEnv,
  buildSafeChildEnv,
  computeCapabilityDigests,
  validateCapabilityRequest,
} from './capabilities.mjs';
import { describeModel, effortRejection } from './model-capabilities.mjs';
import {
  classifyProviderLine,
  createLineSplitter,
  terminalStateForError,
} from './events.mjs';
import { AiCliError } from './errors.mjs';
import { runProcess } from './process-runner.mjs';
import { getProvider, listProviders, resolveProviderBin } from './providers/index.mjs';
import { validateClaudeReviewSupport } from './providers/claude.mjs';
import { validateCodexReviewSupport } from './providers/codex.mjs';
import { opencodeProfileForVersion, validateOpencodeReviewSupport } from './providers/opencode.mjs';
import { parseReviewOutput } from './review-result.mjs';
import { resolveTaskIntent } from './task-intent.mjs';
import { createHash } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const FULL_DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

// Backward-compat legacy mapping for toolPolicy values
const TOOL_POLICIES = new Set(['provider-default', 'compose-only']);

function normalizeToolPolicy(value) {
  const policy = value ?? 'provider-default';
  if (!TOOL_POLICIES.has(policy)) {
    throw new AiCliError('INVALID_INPUT', 'toolPolicy must be provider-default or compose-only', { exitCode: 2 });
  }
  return policy;
}

function rejectAgyVNext(provider, request) {
  if (provider.id !== 'agy' || request.taskIntent === null || request.taskIntent === undefined) return;
  throw new AiCliError('UNSUPPORTED_CAPABILITY', 'AGY does not support preventive deny-write review mode', {
    exitCode: 2,
    details: { capability: 'review', taskIntent: request.taskIntent, accessProfile: request.accessProfile ?? null },
  });
}

const LOCK_RETRY_DEFAULT = 3;

function lockRetryCount(value) {
  if (typeof value === 'string' && value.trim() === '') {
    throw new AiCliError('INVALID_INPUT', 'retryLock must be a non-negative integer', { exitCode: 2 });
  }
  if (value === undefined || value === null || value === true) return LOCK_RETRY_DEFAULT;
  if (value === false) return 0;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new AiCliError('INVALID_INPUT', 'retryLock must be a non-negative integer', { exitCode: 2 });
  }
  return count;
}

// Retry only the transient concurrent-storage lock; every other provider error
// (quota, auth, timeout, generic exit) propagates on the first attempt.
async function runWithLockRetry(run, attempts, onRetry) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (error?.code !== 'PROVIDER_DB_LOCKED' || attempt >= attempts) throw error;
      onRetry?.(attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

function normalizeRequest(input) {
  const provider = getProvider(input.provider);
  const rejectedEffort = effortRejection({ providerId: provider.id, modelId: input.model, effort: input.effort });
  if (rejectedEffort) {
    throw new AiCliError('UNSUPPORTED_EFFORT', `${provider.name} model ${input.model} does not accept --effort`, {
      exitCode: 2,
      details: {
        provider: provider.id,
        model: input.model,
        effort: input.effort,
        allowedEfforts: rejectedEffort.allowedEfforts,
        note: rejectedEffort.note ?? null,
      },
    });
  }
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt.trim()) {
    throw new AiCliError('INVALID_INPUT', 'prompt must be a non-empty string', { exitCode: 2 });
  }
  // Strict portable taskIntent validation. When taskIntent is present the
  // pair is validated (including defaulting and contradiction checks)
  // BEFORE any capability work or provider spawn. Legacy callers without
  // taskIntent keep the exact prior path.
  let effectiveAccessProfile = input.accessProfile;
  let taskIntent = input.taskIntent ?? null;
  if (taskIntent !== null && taskIntent !== undefined) {
    const resolved = resolveTaskIntent(
      effectiveAccessProfile === undefined || effectiveAccessProfile === null
        ? { taskIntent }
        : { taskIntent, accessProfile: effectiveAccessProfile },
    );
    taskIntent = resolved.taskIntent;
    effectiveAccessProfile = resolved.accessProfile;
  }
  // Review is a strictly read-only result-contract lane. Reject privileged
  // or write-capable fields before capability canonicalization so an invalid
  // request cannot even inspect/create a workspace-derived capability.
  if (taskIntent === 'review') {
    const forbiddenReviewFields = ['agentMode', 'agent', 'toolPolicy', 'schema', 'gatewayCapabilityHandle', 'gatewayHandle', 'mcpConfig'];
    for (const field of forbiddenReviewFields) {
      if (input[field] !== undefined && input[field] !== null) {
        throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', `${field} is not allowed for taskIntent review`, {
          exitCode: 2,
          details: { field, taskIntent },
        });
      }
    }
    if (input.allowedWriteRoots !== undefined && input.allowedWriteRoots !== null) {
      if (!Array.isArray(input.allowedWriteRoots)) {
        throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', 'allowedWriteRoots must be an array for taskIntent review', {
          exitCode: 2,
          details: { field: 'allowedWriteRoots', taskIntent },
        });
      }
      if (input.allowedWriteRoots.length > 0) {
        throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', 'allowedWriteRoots is not allowed for taskIntent review', {
          exitCode: 2,
          details: { field: 'allowedWriteRoots', taskIntent },
        });
      }
    }
  }
  const timeoutMs = Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AiCliError('INVALID_INPUT', 'timeoutMs must be a positive number', { exitCode: 2 });
  }
  let maxOutputBytes;
  if (input.maxOutputBytes != null) {
    maxOutputBytes = Number(input.maxOutputBytes);
    if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new AiCliError('INVALID_INPUT', 'maxOutputBytes must be a positive number', { exitCode: 2 });
    }
  }
  // Validate capability fields with strict canonicalization and profile handling.
  // validateCapabilityRequest handles accessProfile/toolPolicy merging, workspace, roots, protectedPaths, projectId/storeRevisions, and gateway-tool fail-closed.
  const capability = validateCapabilityRequest({
    accessProfile: taskIntent !== null && taskIntent !== undefined ? effectiveAccessProfile : input.accessProfile,
    toolPolicy: input.toolPolicy,
    workspace: input.workspace,
    allowedReadRoots: input.allowedReadRoots,
    allowedWriteRoots: input.allowedWriteRoots,
    protectedPaths: input.protectedPaths,
    projectId: input.projectId,
    storeRevisions: input.storeRevisions,
    gatewayCapabilityHandle: input.gatewayCapabilityHandle,
    gatewayHandle: input.gatewayHandle,
    mcpConfig: input.mcpConfig,
  });

  // Derive the effective toolPolicy for legacy provider capability checks and compose-only temp workspace handling
  const toolPolicy = capability.accessProfile === 'compose-only' ? 'compose-only' : (input.toolPolicy ?? (capability.accessProfile === 'provider-default' ? 'provider-default' : capability.accessProfile));
  // Provider support matrix. Legacy (no taskIntent) keeps the exact prior
  // rule: only opencode supports review-readonly/bounded-edit. The portable
  // reviewer lane (taskIntent present) exposes review-readonly on
  // claude/codex/opencode via their new review hardening; bounded-edit stays
  // opencode-only; full stays universal. AGY review fails at the provider
  // adapter with UNSUPPORTED_CAPABILITY (preventive deny-write unproven).
  const providerSupported = (() => {
    if (capability.accessProfile === 'gateway-tool') return false;
    if (capability.accessProfile === 'full') return true;
    if (taskIntent !== null && taskIntent !== undefined) {
      if (capability.accessProfile === 'review-readonly') {
        return provider.id === 'opencode' || provider.id === 'claude' || provider.id === 'codex';
      }
      if (capability.accessProfile === 'bounded-edit') {
        return provider.id === 'opencode';
      }
      if (capability.accessProfile === 'compose-only') return true;
      return true;
    }
    if (['review-readonly', 'bounded-edit'].includes(capability.accessProfile)) {
      return provider.id === 'opencode';
    }
    return true;
  })();
  if (!providerSupported) {
    throw new AiCliError('UNSUPPORTED_CAPABILITY', `${provider.name} does not support accessProfile ${capability.accessProfile}`, {
      exitCode: 2,
      details: { capability: 'accessProfile', accessProfile: capability.accessProfile },
    });
  }
  // Retain legacy toolPolicy validation for backward compat
  // 'full' maps onto provider-default for the legacy capability check; the
  // provider adapter branches on accessProfile === 'full' for passthrough.
  const legacyPolicy = normalizeToolPolicy(toolPolicy === 'review-readonly' || toolPolicy === 'bounded-edit' || toolPolicy === 'full' ? 'provider-default' : toolPolicy);
  if (!provider.capabilities?.toolPolicies?.includes(legacyPolicy) && !['review-readonly', 'bounded-edit', 'full'].includes(capability.accessProfile)) {
    throw new AiCliError('UNSUPPORTED_CAPABILITY', `${provider.name} does not support toolPolicy ${legacyPolicy}`, {
      exitCode: 2,
      details: { capability: 'toolPolicy', toolPolicy: legacyPolicy },
    });
  }
  // For old providers, keep toolPolicy for workspace handling; for opencode, capability.accessProfile drives config
  const effectiveToolPolicy = capability.accessProfile === 'compose-only' ? 'compose-only' : legacyPolicy;

  return {
    provider,
    capability,
    request: {
      prompt,
      model: input.model || null,
      effort: input.effort || null,
      schema: input.schema || null,
      sessionId: input.sessionId || null,
      agentMode: input.agentMode || null,
      agent: input.agent || null,
      toolPolicy: effectiveToolPolicy,
      accessProfile: capability.accessProfile,
      taskIntent,
      workspace: capability.workspace,
      allowedReadRoots: capability.allowedReadRoots,
      allowedWriteRoots: capability.allowedWriteRoots,
      protectedPaths: capability.protectedPaths,
      projectId: capability.projectId,
      storeRevisions: capability.storeRevisions,
      opencodeProfile: input.opencodeProfile ?? null,
      timeoutMs,
      maxOutputBytes,
    },
  };
}

/**
 * Bounded, read-only reviewer capability probes for the spawn lane.
 * Runs `<bin> --help` through the existing safe-env/runProcess/
 * resolveProviderBin seams (no shell), validates the installed reviewer
 * flags via the provider validator, and maps drift/unavailable to
 * typed errors without leaking executable paths or raw help text. No model
 * is invoked. Called only for taskIntent review on claude/codex/opencode;
 * legacy generate paths never probe. Dry-run never reaches here
 * (describe*DryRun returns before generate).
 */
async function ensureClaudeReviewSupport({ provider, env }) {
  const command = resolveProviderBin(provider, env);
  const safeEnv = buildSafeChildEnv(env, {});
  let helpText = null;
  try {
    const help = await runProcess(command, ['--help'], {
      env: safeEnv, timeoutMs: 5_000, maxOutputBytes: 256 * 1024,
    });
    helpText = `${help.stdout}\n${help.stderr}`;
  } catch (error) {
    if (error?.code === 'CLI_NOT_INSTALLED') {
      throw new AiCliError('CLI_NOT_INSTALLED', 'Claude CLI binary not installed or not executable', {
        exitCode: 2,
        details: { capability: 'review' },
      });
    }
    throw new AiCliError('PROVIDER_CAPABILITY_DRIFT', `Installed Claude CLI reviewer capability unproven: ${error?.code || 'probe failed'}`, {
      exitCode: 2,
      details: { capability: 'review' },
    });
  }
  // validateClaudeReviewSupport throws typed PROVIDER_CAPABILITY_DRIFT with
  // only flag names in details; never leaks paths or raw help.
  validateClaudeReviewSupport(helpText);
}

/**
 * Shared bounded help probe used by the Codex/OpenCode review spawn lane.
 * `label` is the human name for messages only; `validate` is the provider
 * validator (throws typed drift with bounded missing names). No model is
 * spawned. Missing binary maps to CLI_NOT_INSTALLED; any other probe
 * failure maps to PROVIDER_CAPABILITY_DRIFT. Never leaks paths/raw help.
 */
async function ensureHelpReviewSupport({ provider, env, label, validate, helpArgs = ['--help'] }) {
  const command = resolveProviderBin(provider, env);
  const safeEnv = buildSafeChildEnv(env, {});
  let helpText = null;
  try {
    const help = await runProcess(command, helpArgs, {
      env: safeEnv, timeoutMs: 5_000, maxOutputBytes: 256 * 1024,
    });
    helpText = `${help.stdout}\n${help.stderr}`;
  } catch (error) {
    if (error?.code === 'CLI_NOT_INSTALLED') {
      throw new AiCliError('CLI_NOT_INSTALLED', `${label} CLI binary not installed or not executable`, {
        exitCode: 2,
        details: { capability: 'review' },
      });
    }
    throw new AiCliError('PROVIDER_CAPABILITY_DRIFT', `Installed ${label} CLI reviewer capability unproven: ${error?.code || 'probe failed'}`, {
      exitCode: 2,
      details: { capability: 'review' },
    });
  }
  validate(helpText);
}

/**
 * Bounded `<bin> --version` probe used once per opencode spawn to select the
 * adapter profile (v1 = 1.x argv/config, v2 = 2.x argv/config). Never spawns
 * a model. Missing binary maps to CLI_NOT_INSTALLED; probe failure or an
 * unrecognized major version maps to typed PROVIDER_CAPABILITY_DRIFT.
 */
async function detectOpencodeProfile({ command, env }) {
  const safeEnv = buildSafeChildEnv(env, {});
  let output = null;
  try {
    const probe = await runProcess(command, ['--version'], {
      env: safeEnv, timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
    });
    output = `${probe.stdout}\n${probe.stderr}`;
  } catch (error) {
    if (error?.code === 'CLI_NOT_INSTALLED') {
      throw new AiCliError('CLI_NOT_INSTALLED', 'opencode CLI binary not installed or not executable', {
        exitCode: 2,
        details: { capability: 'profile' },
      });
    }
    throw new AiCliError('PROVIDER_CAPABILITY_DRIFT', `Installed opencode profile unproven: ${error?.code || 'probe failed'}`, {
      exitCode: 2,
      details: { capability: 'profile' },
    });
  }
  const profile = opencodeProfileForVersion(output);
  if (!profile) {
    throw new AiCliError('PROVIDER_CAPABILITY_DRIFT', 'Installed opencode version is not a recognized v1/v2 profile', {
      exitCode: 2,
      details: { capability: 'profile' },
    });
  }
  return profile;
}

// AGY print mode can return only a summary while the full answer is written to
// its brain directory. When the caller opts in (`resolveArtifacts`), recover
// the artifact written during this run. A single match longer than stdout
// replaces the summary text; several matches are exposed but never guessed at.
function resolveProviderArtifacts({ provider, input, parsed, startedAt }) {
  if (provider.id !== 'agy' || !input.resolveArtifacts) {
    return { text: parsed.text, artifacts: [], resolved: false };
  }
  const brainDir = input.agyBrainDir || join(homedir(), DEFAULT_AGY_BRAIN_DIR);
  const found = resolveAgyArtifacts({
    brainDir,
    sinceMs: startedAt,
    untilMs: Date.now() + 2000,
  });
  if (!found.length) return { text: parsed.text, artifacts: [], resolved: false };
  const useSingle = found.length === 1 && found[0].text.length > parsed.text.length;
  return {
    text: useSingle ? found[0].text : parsed.text,
    resolved: useSingle,
    artifacts: found.map((entry) => ({
      kind: 'brain-md',
      name: basename(entry.path),
      bytes: entry.bytes,
      digest: entry.digest,
    })),
  };
}

export async function generate(input) {
  const startedAt = Date.now();
  const { provider, request, capability } = normalizeRequest(input);
  // Reject every portable AGY intent before allocating a compose workspace.
  // The adapter remains the final defence for direct callers, but generate's
  // policy workspace must not be created for a request that cannot spawn.
  rejectAgyVNext(provider, request);
  // Validate retryLock before any side-effectful setup (policy workspace
  // mkdtemp, provider buildInvocation temp artifacts) so an invalid value
  // cannot leak a temp directory outside the try/finally cleanup.
  const lockRetries = lockRetryCount(input.retryLock);
  const env = input.env || process.env;
  const command = resolveProviderBin(provider, env);
  // OpenCode dual-profile detection: one bounded `<bin> --version` probe per
  // spawn (no model). An explicit request.opencodeProfile (tests/advanced
  // callers) skips the probe. Unknown/unparseable versions fail closed with
  // typed drift before any temp artifact or argv is created.
  if (provider.id === 'opencode' && (request.opencodeProfile === null || request.opencodeProfile === undefined)) {
    request.opencodeProfile = await detectOpencodeProfile({ command, env });
  }
  // compose-only uses disposable temp workspace; otherwise use validated workspace
  const isComposeOnly = request.accessProfile === 'compose-only' || request.toolPolicy === 'compose-only';
  const policyWorkspace = isComposeOnly && !capability.workspace
    ? mkdtempSync(join(tmpdir(), `webmcp-ai-${provider.id}-compose-`))
    : null;
  const workspace = policyWorkspace || capability.workspace || process.cwd();
  // Library-only observers are inspected before invocation so provider-native
  // telemetry (Claude stream-json --verbose) can be selected without a second
  // pass. Telemetry only — never control.
  const onStreamEarly = typeof input.onStream === 'function' ? input.onStream : null;
  const onEventEarly = typeof input.onEvent === 'function' ? input.onEvent : null;
  const eventsRequested = onEventEarly !== null;
  // The effective environment is handed to the provider adapter so env-derived
  // settings (e.g. the isolated OpenCode database) resolve from what actually
  // reaches the child process, never from process.env behind the caller.
  const invocation = provider.buildInvocation({
    ...request, workspace, env, allowedReadRoots: capability.allowedReadRoots, allowedWriteRoots: capability.allowedWriteRoots, protectedPaths: capability.protectedPaths, projectId: capability.projectId, storeRevisions: capability.storeRevisions,
    eventsRequested,
  });

  // Reviewer spawn-lane probes: before any model spawn, validate the
  // installed flags via a bounded `<bin> --help` (no model invocation).
  // Dry-run never reaches here (describe*DryRun returns before generate);
  // legacy generate without taskIntent review never probes. Probe failures
  // clean up the preview invocation + compose workspace before rethrow so
  // drifted review never leaks temp dirs.
  if (provider.id === 'claude' && request.taskIntent === 'review') {
    try {
      await ensureClaudeReviewSupport({ provider, env });
    } catch (error) {
      try { invocation.cleanup?.(); } catch {}
      if (policyWorkspace) { try { rmSync(policyWorkspace, { recursive: true, force: true }); } catch {} }
      throw error;
    }
  }
  if (provider.id === 'codex' && request.taskIntent === 'review') {
    try {
      await ensureHelpReviewSupport({ provider, env, label: 'Codex', helpArgs: ['exec', '--help'], validate: validateCodexReviewSupport });
    } catch (error) {
      try { invocation.cleanup?.(); } catch {}
      if (policyWorkspace) { try { rmSync(policyWorkspace, { recursive: true, force: true }); } catch {} }
      throw error;
    }
  }
  if (provider.id === 'opencode' && request.taskIntent === 'review') {
    try {
      await ensureHelpReviewSupport({
        provider,
        env,
        label: 'opencode',
        helpArgs: ['run', '--help'],
        validate: (helpText) => validateOpencodeReviewSupport(helpText, { profile: request.opencodeProfile }),
      });
    } catch (error) {
      try { invocation.cleanup?.(); } catch {}
      if (policyWorkspace) { try { rmSync(policyWorkspace, { recursive: true, force: true }); } catch {} }
      throw error;
    }
  }

  // Child environment: bounded profiles use the explicit safe allowlist and
  // never receive arbitrary env or secrets. Full passthrough uses native-CLI
  // env parity (ambient env minus the explicit WebMCP/server/Vault authority
  // denylist in buildFullChildEnv); private invocation values (e.g.
  // OPENCODE_DB) still take precedence over ambient values. Env parity does
  // not imply config parity for every provider: Codex full still passes
  // --ephemeral --ignore-user-config --ignore-rules with --sandbox
  // workspace-write and does not inherit ambient user config/MCP — only the
  // opencode provider keeps ambient operator config/MCP in full mode.
  const isFull = request.accessProfile === 'full';
  const buildEnv = isFull ? buildFullChildEnv : buildSafeChildEnv;
  const safeBase = buildEnv(env, {});
  const privateEnv = buildEnv(invocation.env || {}, {});
  const childEnv = { ...safeBase, ...privateEnv };

  // Output cap: explicit caller value wins; full defaults higher than the
  // runner default so long generations are not cut mid-stream.
  const maxOutputBytes = request.maxOutputBytes
    ?? (isFull ? FULL_DEFAULT_MAX_OUTPUT_BYTES : DEFAULT_MAX_OUTPUT_BYTES);

  // Library-only live stream: input.onStream({ stream: 'stdout'|'stderr', chunk })
  // forwards provider bytes as they arrive. Not part of the JSON protocol
  // (functions cannot cross it); CLI exposes the same via --stream.
  const onStream = onStreamEarly;
  // Library-only advisory events: input.onEvent({ seq, stream, state, summary,
  // provider }). Telemetry only — never control. CLI exposes via --events.
  const onEvent = onEventEarly;
  let eventSeq = 0;
  const emitEvent = (stream, state, summary) => {
    if (!onEvent) return;
    eventSeq += 1;
    try {
      onEvent({ seq: eventSeq, stream, state, summary: summary ?? '', provider: provider.id });
    } catch {
      // Observer errors are swallowed by design, like onStream above.
    }
  };
  const splitters = onEvent ? {
    stdout: createLineSplitter((line) => {
      const classified = classifyProviderLine(provider.id, line);
      if (classified) emitEvent('stdout', classified.state, classified.summary);
    }),
    stderr: createLineSplitter((line) => {
      const classified = classifyProviderLine(provider.id, line);
      if (classified) emitEvent('stderr', classified.state, classified.summary);
    }),
  } : null;
  const streamForward = (stream) => (chunk) => {
    splitters?.[stream]?.push(chunk);
    if (onStream) onStream({ stream, chunk });
  };

  emitEvent('stdout', 'queued', `${provider.id}${request.model ? ` model ${request.model}` : ''} workspace ${workspace}`);
  try {
    const processResult = await runWithLockRetry(
      () => runProcess(command, invocation.args, {
        stdin: invocation.stdin,
        cwd: workspace,
        env: childEnv,
        timeoutMs: request.timeoutMs,
        maxOutputBytes,
        signal: input.signal,
        onStdout: streamForward('stdout'),
        onStderr: streamForward('stderr'),
      }),
      lockRetries,
      (attempt) => emitEvent('stdout', 'retrying', `provider storage locked; retry ${attempt}/${lockRetries}`),
    );
    splitters?.stdout.flush();
    splitters?.stderr.flush();
    const parsed = provider.parseOutput({ ...processResult, invocation, request });
    const resolved = resolveProviderArtifacts({ provider, input, parsed, startedAt });
    const responseText = resolved.text;
    if (!responseText) {
      throw new AiCliError('EMPTY_RESPONSE', `${provider.name} returned an empty response`, {
        retryable: true,
      });
    }
    // A portable review intent is a result-contract lane, even when a caller
    // reaches it through generate/ai.generate instead of the dedicated review
    // helper. Never allow arbitrary non-empty prose (including a plan-only
    // response) to become transport success.
    let reviewResult = null;
    if (request.taskIntent === 'review') {
      const parsedReview = parseReviewOutput({ text: responseText, structured: parsed.structured });
      reviewResult = {
        schema: parsedReview.schema,
        verdict: parsedReview.verdict,
        summary: parsedReview.summary,
        ...(parsedReview.blockedReason !== undefined ? { blockedReason: parsedReview.blockedReason } : {}),
        ...(parsedReview.findings !== undefined && parsedReview.findings !== null ? { findings: parsedReview.findings } : {}),
      };
    }
    const digests = computeCapabilityDigests({
      workspace: workspace || capability.workspace,
      allowedReadRoots: capability.allowedReadRoots,
      allowedWriteRoots: capability.allowedWriteRoots,
      protectedPaths: capability.protectedPaths,
      projectId: capability.projectId,
      storeRevisions: capability.storeRevisions,
      accessProfile: capability.accessProfile,
    });
    emitEvent('stdout', 'completed', `exit 0 in ${Date.now() - startedAt}ms`);
    return {
      ok: true,
      provider: { id: provider.id, name: provider.name },
      model: request.model,
      response: { text: responseText, structured: parsed.structured },
      ...(resolved.artifacts.length ? { artifacts: resolved.artifacts, artifactsResolved: resolved.resolved } : {}),
      ...(reviewResult ? { review: reviewResult } : {}),
      // Review envelopes expose only freshness metadata. Legacy generate keeps
      // its existing resumable session identity behavior.
      session: request.taskIntent === 'review'
        ? { id: null, resumable: false }
        : { id: parsed.sessionId, resumable: Boolean(parsed.sessionId) },
      timing: { elapsedMs: Date.now() - startedAt },
      capability: digests,
    };
  } catch (error) {
    splitters?.stdout.flush();
    splitters?.stderr.flush();
    emitEvent('stdout', terminalStateForError(error), error?.code || error?.message || 'failed');
    throw error;
  } finally {
    invocation.cleanup?.();
    if (policyWorkspace) rmSync(policyWorkspace, { recursive: true, force: true });
  }
}

function executablePathAvailable(command) {
  if (command.includes('/')) {
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

// A bare provider name (the default `defaultBin`) must be resolved against
// PATH, not assumed present. No spawn: one X_OK stat per POSIX PATH entry.
function pathExecutableAvailable(command, env) {
  const rawPath = env?.PATH ?? env?.Path ?? '';
  const separator = process.platform === 'win32' ? ';' : ':';
  for (const dir of String(rawPath).split(separator)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // try the next PATH entry
    }
  }
  return false;
}

function sanitizeGenerateArgs(args, capability, sessionId = null) {
  const roots = [
    capability.workspace,
    ...(capability.allowedReadRoots || []),
    ...(capability.allowedWriteRoots || []),
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
    if (out.includes(tmpRoot)) return '<tmp>';
    if (out.includes('last-message.txt') || out.includes('output-schema.json')) return '<tmp>';
    if (out.startsWith('/') && out.length > 1 && out !== '<workspace>' && !out.startsWith('<workspace>') && !out.startsWith('<tmp>')) {
      if (out.includes('/')) return '<path>';
    }
    return out;
  });
}

/**
 * Sanitized generate dry-run. Reuses normalizeRequest + provider preview
 * without spawning. Never includes prompt text, secrets, absolute paths or
 * temp output paths — digests/placeholders only.
 */
export function describeGenerateDryRun(input = {}) {
  const { provider, request, capability } = normalizeRequest(input);
  // Keep dry-run side-effect free even when a provider rejects a vNext intent
  // before returning an invocation cleanup hook.
  rejectAgyVNext(provider, request);
  // Dry-run must never mutate caller files. AGY compose-only installs a
  // workspace-local `.agents` guard; preview it inside a disposable temp
  // dir so neither the real workspace nor cwd is touched.
  const needsTempPreview = provider.id === 'agy' && (request.toolPolicy === 'compose-only' || request.accessProfile === 'compose-only');
  const tempPreviewDir = needsTempPreview ? mkdtempSync(join(tmpdir(), 'webmcp-ai-dryrun-')) : null;
  const workspace = needsTempPreview ? tempPreviewDir : (capability.workspace || process.cwd());
  const preview = provider.buildInvocation({
    ...request,
    workspace,
    env: input.env || {},
    allowedReadRoots: capability.allowedReadRoots,
    allowedWriteRoots: capability.allowedWriteRoots,
    protectedPaths: capability.protectedPaths,
    projectId: capability.projectId,
    storeRevisions: capability.storeRevisions,
  });
  let args = sanitizeGenerateArgs(preview.args || [], capability, request.sessionId);
  // AGY carries the prompt as `-p <prompt>` argv; never leak it in dry-run.
  if (provider.id === 'agy') {
    args = args.map((a) => (a === request.prompt ? '<prompt>' : a));
    // Also redact any arg that contains a long prompt substring (defence).
    args = args.map((a) => (typeof a === 'string' && request.prompt && a.includes(request.prompt.slice(0, 32)) && a.length > 32 ? '<prompt>' : a));
  }
  try {
    preview.cleanup?.();
  } catch {
    // Preview cleanup must never fail inspection.
  }
  if (tempPreviewDir) {
    try { rmSync(tempPreviewDir, { recursive: true, force: true }); } catch {}
  }
  const promptDigest = createHash('sha256').update(String(request.prompt)).digest('hex').slice(0, 16);
  return {
    ok: true,
    dryRun: true,
    provider: provider.id,
    taskIntent: request.taskIntent ?? null,
    accessProfile: capability.accessProfile,
    model: request.model,
    sessionId: request.sessionId ? '<resumed-session>' : null,
    args,
    capability: computeCapabilityDigests({
      workspace: capability.workspace,
      allowedReadRoots: capability.allowedReadRoots,
      allowedWriteRoots: capability.allowedWriteRoots,
      protectedPaths: capability.protectedPaths,
      projectId: capability.projectId,
      storeRevisions: capability.storeRevisions,
      accessProfile: capability.accessProfile,
    }),
    promptDigest,
  };
}

export async function probeProviders({ env = process.env } = {}) {
  return Promise.all(listProviders().map(async (metadata) => {
    const provider = getProvider(metadata.id);
    const command = resolveProviderBin(provider, env);
    if (!executablePathAvailable(command)) {
      return { ...metadata, command, available: false, version: null };
    }
    try {
      const safeEnv = buildSafeChildEnv(env, {});
      const result = await runProcess(command, ['--version'], { env: safeEnv, timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
      return { ...metadata, command, available: true, version: result.stdout.trim() || result.stderr.trim() || null };
    } catch (error) {
      if (error.code === 'CLI_NOT_INSTALLED') return { ...metadata, command, available: false, version: null };
      return { ...metadata, command, available: false, version: null, error: error.code || 'PROBE_FAILED' };
    }
  }));
}

/**
 * Read-only dispatch preflight. Reports what each provider can do and where
 * quota lives without spawning any provider, so a multi-lane caller can pick a
 * route before spending a single call.
 */
export function describePreflight({ env = process.env } = {}) {
  const providers = listProviders().map((metadata) => {
    const provider = getProvider(metadata.id);
    const command = resolveProviderBin(provider, env);
    const surface = describeModel(metadata.id, null);
    return {
      id: metadata.id,
      name: metadata.name,
      installed: command.includes('/') ? executablePathAvailable(command) : pathExecutableAvailable(command, env),
      capabilities: { ...metadata.capabilities },
      maxPromptBytes: surface?.maxPromptBytes ?? null,
      artifacts: surface?.artifacts ?? 'inline',
    };
  });
  return {
    ok: true,
    providers,
    quota: {
      owner: 'companion',
      service: 'http://127.0.0.1:8421/api/quotas',
      cluster: 'http://127.0.0.1:8421/api/quotas?all=1',
      devices: 'http://127.0.0.1:8421/api/devices',
      app: 'apps/ai-cli-usage-tray',
      skill: 'ai-cli-usage',
      note: 'Quota is not owned by webmcp-ai; query the companion service or skill separately before heavy dispatch.',
    },
  };
}

export async function listModels(providerId, { env = process.env } = {}) {
  const provider = getProvider(providerId);
  if (!provider.modelsInvocation) {
    throw new AiCliError('UNSUPPORTED_CAPABILITY', `${provider.name} does not expose model discovery`, {
      exitCode: 2,
    });
  }
  const command = resolveProviderBin(provider, env);
  const invocationEnv = provider.invocationEnv?.(env) ?? {};
  const safeEnv = buildSafeChildEnv(env, invocationEnv);
  const result = await runProcess(command, provider.modelsInvocation.args, {
    stdin: provider.modelsInvocation.stdin,
    env: safeEnv,
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
  });
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function listAgents(providerId, { env = process.env } = {}) {
  const provider = getProvider(providerId);
  if (!provider.agentsInvocation) {
    throw new AiCliError('UNSUPPORTED_CAPABILITY', `${provider.name} does not expose agent discovery`, {
      exitCode: 2,
    });
  }
  const command = resolveProviderBin(provider, env);
  const invocationEnv = provider.invocationEnv?.(env) ?? {};
  const safeEnv = buildSafeChildEnv(env, invocationEnv);
  const result = await runProcess(command, provider.agentsInvocation.args, {
    stdin: provider.agentsInvocation.stdin,
    env: safeEnv,
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
  });
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line.toLowerCase() !== 'available agents:');
}
