import { accessSync, constants } from 'node:fs';

import { AiCliError } from './errors.mjs';
import { runProcess } from './process-runner.mjs';
import { getProvider, listProviders, resolveProviderBin } from './providers/index.mjs';

const DEFAULT_TIMEOUT_MS = 600_000;

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
  return {
    provider,
    request: {
      prompt,
      model: input.model || null,
      effort: input.effort || null,
      schema: input.schema || null,
      sessionId: input.sessionId || null,
      timeoutMs,
    },
  };
}

export async function generate(input) {
  const startedAt = Date.now();
  const { provider, request } = normalizeRequest(input);
  const env = input.env || process.env;
  const command = resolveProviderBin(provider, env);
  const invocation = provider.buildInvocation(request);

  try {
    const processResult = await runProcess(command, invocation.args, {
      stdin: invocation.stdin,
      cwd: input.workspace || process.cwd(),
      env,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      signal: input.signal,
    });
    const parsed = provider.parseOutput({ ...processResult, invocation, request });
    if (!parsed.text) {
      throw new AiCliError('EMPTY_RESPONSE', `${provider.name} returned an empty response`, {
        retryable: true,
      });
    }
    return {
      ok: true,
      provider: { id: provider.id, name: provider.name },
      model: request.model,
      response: { text: parsed.text, structured: parsed.structured },
      session: { id: parsed.sessionId, resumable: Boolean(parsed.sessionId) },
      timing: { elapsedMs: Date.now() - startedAt },
    };
  } finally {
    invocation.cleanup?.();
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
      const result = await runProcess(command, ['--version'], { env, timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
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
  const result = await runProcess(command, provider.modelsInvocation.args, {
    stdin: provider.modelsInvocation.stdin,
    env,
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
  });
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
