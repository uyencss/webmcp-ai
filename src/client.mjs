import {
  accessSync, constants, mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildFullChildEnv,
  buildSafeChildEnv,
  computeCapabilityDigests,
  validateCapabilityRequest,
} from './capabilities.mjs';
import { AiCliError } from './errors.mjs';
import { runProcess } from './process-runner.mjs';
import { getProvider, listProviders, resolveProviderBin } from './providers/index.mjs';

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

function normalizeRequest(input) {
  const provider = getProvider(input.provider);
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt.trim()) {
    throw new AiCliError('INVALID_INPUT', 'prompt must be a non-empty string', { exitCode: 2 });
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
    accessProfile: input.accessProfile,
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
  // For legacy providers that only declare toolPolicies, map new profiles to unsupported
  // Only opencode is expected to support review-readonly/bounded-edit; others fail closed.
  // 'full' is explicit opt-in passthrough and is supported by every provider.
  const providerSupported = (() => {
    if (capability.accessProfile === 'gateway-tool') return false;
    if (capability.accessProfile === 'full') return true;
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
      workspace: capability.workspace,
      allowedReadRoots: capability.allowedReadRoots,
      allowedWriteRoots: capability.allowedWriteRoots,
      protectedPaths: capability.protectedPaths,
      projectId: capability.projectId,
      storeRevisions: capability.storeRevisions,
      timeoutMs,
      maxOutputBytes,
    },
  };
}

export async function generate(input) {
  const startedAt = Date.now();
  const { provider, request, capability } = normalizeRequest(input);
  const env = input.env || process.env;
  const command = resolveProviderBin(provider, env);
  // compose-only uses disposable temp workspace; otherwise use validated workspace
  const isComposeOnly = request.accessProfile === 'compose-only' || request.toolPolicy === 'compose-only';
  const policyWorkspace = isComposeOnly && !capability.workspace
    ? mkdtempSync(join(tmpdir(), `webmcp-ai-${provider.id}-compose-`))
    : null;
  const workspace = policyWorkspace || capability.workspace || process.cwd();
  // The effective environment is handed to the provider adapter so env-derived
  // settings (e.g. the isolated OpenCode database) resolve from what actually
  // reaches the child process, never from process.env behind the caller.
  const invocation = provider.buildInvocation({
    ...request, workspace, env, allowedReadRoots: capability.allowedReadRoots, allowedWriteRoots: capability.allowedWriteRoots, protectedPaths: capability.protectedPaths, projectId: capability.projectId, storeRevisions: capability.storeRevisions,
  });

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
  const onStream = typeof input.onStream === 'function' ? input.onStream : null;
  const streamForward = (stream) => onStream
    ? (chunk) => onStream({ stream, chunk })
    : null;

  try {
    const processResult = await runProcess(command, invocation.args, {
      stdin: invocation.stdin,
      cwd: workspace,
      env: childEnv,
      timeoutMs: request.timeoutMs,
      maxOutputBytes,
      signal: input.signal,
      onStdout: streamForward('stdout'),
      onStderr: streamForward('stderr'),
    });
    const parsed = provider.parseOutput({ ...processResult, invocation, request });
    if (!parsed.text) {
      throw new AiCliError('EMPTY_RESPONSE', `${provider.name} returned an empty response`, {
        retryable: true,
      });
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
    return {
      ok: true,
      provider: { id: provider.id, name: provider.name },
      model: request.model,
      response: { text: parsed.text, structured: parsed.structured },
      session: { id: parsed.sessionId, resumable: Boolean(parsed.sessionId) },
      timing: { elapsedMs: Date.now() - startedAt },
      capability: digests,
    };
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
