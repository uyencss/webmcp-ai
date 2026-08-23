import assert from 'node:assert/strict';
import test from 'node:test';

// Separately authorized live canary: NEVER runs by default and lives outside
// the default tests/*.test.mjs glob.
//
// not run — separate authorization required

test('claude live canary refuses to run without explicit dual opt-in', () => {
  const enabled = process.env.WEBMCP_AI_LIVE_CANARY === '1'
    && process.env.WEBMCP_AI_LIVE_CLAUDE === '1';
  assert.equal(enabled, false, 'live canary requires WEBMCP_AI_LIVE_CANARY=1 AND WEBMCP_AI_LIVE_CLAUDE=1 with separate authorization');
});
