import assert from 'node:assert/strict';
import test from 'node:test';

import { describeTools, handleToolCall, TOOL_PROTOCOL } from '../src/protocol.mjs';

test('tool description declares the protocol, risk, and input schema', () => {
  const description = describeTools();
  assert.equal(description.protocol, TOOL_PROTOCOL);
  assert.equal(description.tools[0].risk, 'generate');
  assert.deepEqual(description.tools[0].inputSchema.required, ['provider', 'prompt']);
  assert.deepEqual(description.tools[0].inputSchema.properties.agentMode, {
    enum: ['plan', 'accept-edits', null],
  });
  assert.deepEqual(description.tools[0].inputSchema.properties.agent, {
    type: ['string', 'null'],
  });
  assert.deepEqual(description.tools[0].inputSchema.properties.toolPolicy, {
    enum: ['provider-default', 'compose-only', null],
  });
});

for (const [name, request, code] of [
  ['non-object', null, 'INVALID_TOOL_REQUEST'],
  ['protocol', { protocol: 'v0', requestId: 'r', tool: 'ai.generate', input: {} }, 'UNSUPPORTED_PROTOCOL'],
  ['request id', { protocol: TOOL_PROTOCOL, tool: 'ai.generate', input: {} }, 'INVALID_TOOL_REQUEST'],
  ['tool', { protocol: TOOL_PROTOCOL, requestId: 'r', tool: 'other', input: {} }, 'UNKNOWN_TOOL'],
]) {
  test(`tool-call rejects invalid ${name}`, async () => {
    await assert.rejects(handleToolCall(request), (error) => error.code === code);
  });
}

test('tool-call rejects CLI-only stream and events as unknown input fields', async () => {
  for (const field of ['stream', 'events']) {
    await assert.rejects(
      handleToolCall({
        protocol: TOOL_PROTOCOL,
        requestId: `cli-only-${field}`,
        tool: 'ai.generate',
        input: { provider: 'opencode', prompt: 'x', [field]: true },
      }),
      (error) => error.code === 'INVALID_INPUT' && error.message.includes(`unknown input field: ${field}`),
    );
  }
});

test('tool-call validates input shape and scalar field types', async () => {
  await assert.rejects(
    handleToolCall({ protocol: TOOL_PROTOCOL, requestId: 'shape-1', tool: 'ai.generate' }),
    (error) => error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    handleToolCall({
      protocol: TOOL_PROTOCOL, requestId: 'shape-2', tool: 'ai.generate', input: 'oops',
    }),
    (error) => error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    handleToolCall({
      protocol: TOOL_PROTOCOL,
      requestId: 'types-1',
      tool: 'ai.generate',
      input: { provider: 'opencode', prompt: 'x', accessProfile: 123 },
    }),
    (error) => error.code === 'INVALID_INPUT' && /accessProfile must be a string/.test(error.message),
  );
  await assert.rejects(
    handleToolCall({
      protocol: TOOL_PROTOCOL,
      requestId: 'types-2',
      tool: 'ai.generate',
      input: { provider: 'opencode', prompt: 'x', workspace: 123 },
    }),
    (error) => error.code === 'INVALID_INPUT' && /workspace must be a string/.test(error.message),
  );
  await assert.rejects(
    handleToolCall({
      protocol: TOOL_PROTOCOL,
      requestId: 'types-3',
      tool: 'ai.generate',
      input: { provider: 'opencode', prompt: 'x', projectId: 123 },
    }),
    (error) => error.code === 'INVALID_INPUT' && /projectId must be a string/.test(error.message),
  );
  await assert.rejects(
    handleToolCall({
      protocol: TOOL_PROTOCOL,
      requestId: 'types-4',
      tool: 'ai.generate',
      input: { provider: 'opencode', prompt: 'x', storeRevisions: 'oops' },
    }),
    (error) => error.code === 'INVALID_INPUT' && /storeRevisions must be an object/.test(error.message),
  );
  await assert.rejects(
    handleToolCall({
      protocol: TOOL_PROTOCOL,
      requestId: 'types-5',
      tool: 'ai.generate',
      input: { provider: 'opencode', prompt: 'x', allowedReadRoots: 'oops' },
    }),
    (error) => error.code === 'INVALID_INPUT' && /allowedReadRoots must be an array/.test(error.message),
  );
  await assert.rejects(
    handleToolCall({
      protocol: TOOL_PROTOCOL,
      requestId: 'types-6',
      tool: 'ai.generate',
      input: { provider: 'opencode', prompt: 'x', allowedWriteRoots: [123] },
    }),
    (error) => error.code === 'INVALID_INPUT' && /allowedWriteRoots\[0\] must be a string/.test(error.message),
  );
});
