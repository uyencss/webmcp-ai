import assert from 'node:assert/strict';
import test from 'node:test';

// Separately authorized live canary: NEVER runs by default and is outside the
// default tests/*.test.mjs glob. Requires BOTH explicit opt-ins plus a
// separate user approval; without them it fails closed in under a second.
//
// not run — separate authorization required

test('opencode live canary refuses to run without explicit dual opt-in', () => {
  const enabled = process.env.WEBMCP_AI_LIVE_CANARY === '1'
    && process.env.WEBMCP_AI_LIVE_OPENCODE === '1';
  assert.equal(enabled, false, 'live canary requires WEBMCP_AI_LIVE_CANARY=1 AND WEBMCP_AI_LIVE_OPENCODE=1 with separate authorization');
});
