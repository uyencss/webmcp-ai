import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ORCHESTRATION_ERROR_CODES } from '../src/orchestration/constants.mjs';
import { TASK_TRANSITIONS } from '../src/orchestration/state-machine.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const schema = JSON.parse(readFileSync(`${ROOT}/src/orchestration/schemas/response.schema.json`, 'utf8'));
const schemaCodes = new Set(schema.properties.error.properties.code.enum);

test('R11G-B1: error-code parity between constants and response.schema.json (both directions)', () => {
  assert.equal(schemaCodes.size > 0, true, 'the schema must enumerate error codes');
  const missingFromSchema = [...ORCHESTRATION_ERROR_CODES].filter((code) => !schemaCodes.has(code));
  assert.deepEqual(missingFromSchema, [],
    `codes emitted by src but missing from response.schema.json: ${missingFromSchema.join(', ')}`);
  const notInConstants = [...schemaCodes].filter((code) => !ORCHESTRATION_ERROR_CODES.has(code));
  assert.deepEqual(notInConstants, [],
    `schema codes that are not part of the constants taxonomy: ${notInConstants.join(', ')}`);
});

test('R11G-B2: the packaged guide section 8 lists exactly the public taxonomy', () => {
  const guide = readFileSync(`${ROOT}/skills/webmcp-ai-cli/references/orchestration-runtime.md`, 'utf8');
  const section8 = guide.split(/##\s*8\.[^\n]*/)[1]?.split(/\n##\s/)[0] ?? '';
  assert.ok(section8.length > 0, 'guide section 8 (typed errors) must exist');
  const listed = new Set(section8.match(/[A-Z][A-Z_0-9]{4,}/g) ?? []);
  const missing = [...ORCHESTRATION_ERROR_CODES].filter((code) => !listed.has(code));
  assert.deepEqual(missing, [], `taxonomy codes missing from guide §8: ${missing.join(', ')}`);
  const extra = [...listed].filter((code) => !ORCHESTRATION_ERROR_CODES.has(code));
  assert.deepEqual(extra, [], `guide §8 lists non-taxonomy codes: ${extra.join(', ')}`);
});

test('R11G-B3: task.cancel honors the transition table — rejected tasks are cancellable', async () => {
  // The frozen table allows rejected -> cancelled; the cancel handler must
  // therefore NOT answer alreadyTerminal for a rejected task.
  assert.equal(TASK_TRANSITIONS.rejected.has('cancelled'), true,
    'rejected -> cancelled is a documented legal transition');
  assert.equal(TASK_TRANSITIONS.accepted.size, 0);
  assert.equal(TASK_TRANSITIONS.cancelled.size, 0);
});

const canaryScript = readFileSync(`${ROOT}/scripts/orchestration-live-canary.mjs`, 'utf8');

test('R11G-B4: the live canary cleanup capability requires release+settled+absence proof', () => {
  // The direct phase must request an explicit RELEASE with settlement and
  // only grant capabilities.cleanup='pass' on PROVEN absence.
  assert.match(canaryScript, /release:\s*true/, 'canary stop must pass release:true');
  assert.match(canaryScript, /settled:\s*true/, 'canary stop must pass settled:true');
  assert.match(canaryScript, /absenceProven/,
    'canary must check absenceProven before granting the cleanup capability');
});
