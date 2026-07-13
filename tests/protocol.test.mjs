import assert from 'node:assert/strict';
import test from 'node:test';

import { describeTools, handleToolCall, TOOL_PROTOCOL } from '../src/protocol.mjs';

test('tool description declares the protocol, risk, and input schema', () => {
  const description = describeTools();
  assert.equal(description.protocol, TOOL_PROTOCOL);
  assert.equal(description.tools[0].risk, 'generate');
  assert.deepEqual(description.tools[0].inputSchema.required, ['provider', 'prompt']);
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
