import { AiCliError } from './errors.mjs';
import { generate } from './client.mjs';

export const TOOL_PROTOCOL = 'webmcp-tool-v1';

export function describeTools() {
  return {
    protocol: TOOL_PROTOCOL,
    tools: [{
      id: 'ai.generate',
      risk: 'generate',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['provider', 'prompt'],
        properties: {
          provider: { enum: ['agy', 'claude', 'codex', 'opencode'] },
          prompt: { type: 'string', minLength: 1 },
          model: { type: ['string', 'null'] },
          effort: { type: ['string', 'null'] },
          timeoutMs: { type: 'number', exclusiveMinimum: 0 },
          maxOutputBytes: { type: ['number', 'null'] },
          schema: { type: ['object', 'null'] },
          sessionId: { type: ['string', 'null'] },
          agentMode: { enum: ['plan', 'accept-edits', null] },
          agent: { type: ['string', 'null'] },
          toolPolicy: { enum: ['provider-default', 'compose-only', null] },
          accessProfile: { enum: ['provider-default', 'compose-only', 'review-readonly', 'bounded-edit', 'gateway-tool', 'full', null] },
          workspace: { type: ['string', 'null'] },
          allowedReadRoots: { type: ['array', 'null'], items: { type: 'string' } },
          allowedWriteRoots: { type: ['array', 'null'], items: { type: 'string' } },
          protectedPaths: { type: ['array', 'null'], items: { type: 'string' } },
          projectId: { type: ['string', 'null'] },
          storeRevisions: { type: ['object', 'null'], additionalProperties: { type: 'string' } },
          gatewayCapabilityHandle: { type: ['string', 'null'] },
        },
      },
    }],
  };
}

const ALLOWED_INPUT_FIELDS = new Set([
  'provider', 'prompt', 'model', 'effort', 'timeoutMs', 'maxOutputBytes', 'schema', 'sessionId', 'agentMode', 'agent', 'toolPolicy',
  'accessProfile', 'workspace', 'allowedReadRoots', 'allowedWriteRoots', 'protectedPaths', 'projectId', 'storeRevisions', 'gatewayCapabilityHandle', 'gatewayHandle', 'mcpConfig',
]);

export async function handleToolCall(request, options = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new AiCliError('INVALID_TOOL_REQUEST', 'Tool request must be a JSON object', { exitCode: 2 });
  }
  if (request.protocol !== TOOL_PROTOCOL) {
    throw new AiCliError('UNSUPPORTED_PROTOCOL', `Expected protocol ${TOOL_PROTOCOL}`, { exitCode: 2 });
  }
  if (!request.requestId || typeof request.requestId !== 'string') {
    throw new AiCliError('INVALID_TOOL_REQUEST', 'requestId must be a non-empty string', { exitCode: 2 });
  }
  if (request.tool !== 'ai.generate') {
    throw new AiCliError('UNKNOWN_TOOL', `Unknown tool: ${request.tool || '(missing)'}`, { exitCode: 2 });
  }
  if (!request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
    throw new AiCliError('INVALID_INPUT', 'input must be an object', { exitCode: 2 });
  }
  // Strict input field validation – reject unknown properties and invalid types
  for (const key of Object.keys(request.input)) {
    if (!ALLOWED_INPUT_FIELDS.has(key)) {
      throw new AiCliError('INVALID_INPUT', `unknown input field: ${key}`, { exitCode: 2, details: { field: key } });
    }
  }
  // Basic type checks for new fields (detailed canonicalization happens in capabilities)
  if (request.input.accessProfile !== undefined && request.input.accessProfile !== null && typeof request.input.accessProfile !== 'string') {
    throw new AiCliError('INVALID_INPUT', 'accessProfile must be a string', { exitCode: 2 });
  }
  if (request.input.workspace !== undefined && request.input.workspace !== null && typeof request.input.workspace !== 'string') {
    throw new AiCliError('INVALID_INPUT', 'workspace must be a string', { exitCode: 2 });
  }
  for (const arrField of ['allowedReadRoots', 'allowedWriteRoots', 'protectedPaths']) {
    const v = request.input[arrField];
    if (v !== undefined && v !== null && !Array.isArray(v)) {
      throw new AiCliError('INVALID_INPUT', `${arrField} must be an array`, { exitCode: 2 });
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i += 1) {
        if (typeof v[i] !== 'string') throw new AiCliError('INVALID_INPUT', `${arrField}[${i}] must be a string`, { exitCode: 2 });
      }
    }
  }
  if (request.input.projectId !== undefined && request.input.projectId !== null && typeof request.input.projectId !== 'string') {
    throw new AiCliError('INVALID_INPUT', 'projectId must be a string', { exitCode: 2 });
  }
  if (request.input.storeRevisions !== undefined && request.input.storeRevisions !== null && (typeof request.input.storeRevisions !== 'object' || Array.isArray(request.input.storeRevisions))) {
    throw new AiCliError('INVALID_INPUT', 'storeRevisions must be an object', { exitCode: 2 });
  }

  const result = await generate({ ...request.input, ...options });
  // Return only non-secret capability metadata with stable digests – no absolute paths or prompt text
  const cap = result.capability || {};
  return {
    protocol: TOOL_PROTOCOL,
    requestId: request.requestId,
    ok: true,
    output: result.response,
    metadata: {
      provider: result.provider.id,
      model: result.model,
      sessionId: result.session.id,
      elapsedMs: result.timing.elapsedMs,
      capability: {
        accessProfile: cap.accessProfile ?? null,
        fullPassthrough: (cap.accessProfile ?? null) === 'full',
        workspaceDigest: cap.workspaceDigest ?? null,
        readRootsDigest: cap.readRootsDigest ?? null,
        writeRootsDigest: cap.writeRootsDigest ?? null,
        protectedPathsDigest: cap.protectedPathsDigest ?? null,
        projectDigest: cap.projectDigest ?? null,
        storeRevisionsDigest: cap.storeRevisionsDigest ?? null,
      },
    },
  };
}
