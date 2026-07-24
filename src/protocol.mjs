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
          provider: { enum: ['agy', 'claude', 'codex'] },
          prompt: { type: 'string', minLength: 1 },
          model: { type: ['string', 'null'] },
          effort: { type: ['string', 'null'] },
          timeoutMs: { type: 'number', exclusiveMinimum: 0 },
          schema: { type: ['object', 'null'] },
          sessionId: { type: ['string', 'null'] },
          agentMode: { enum: ['plan', 'accept-edits', null] },
          agent: { type: ['string', 'null'] },
        },
      },
    }],
  };
}

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

  const result = await generate({ ...request.input, ...options });
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
    },
  };
}
