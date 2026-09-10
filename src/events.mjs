import { AiCliError } from './errors.mjs';

// Event-level progress lane (advisory-only telemetry, never control).
//
// Vocabulary follows the portable coordination contract owned by the companion
// orchestration package; the core wrapper keeps this event taxonomy advisory.
// queued → researching → editing → testing → verifying → completed, plus
// question | blocked | failed | cancelled. `working` is the fallback for
// provider activity with no machine-readable signal. `escalation` is reserved
// and not emitted by the v1 classifier.
//
// Grounded shapes (no quota spent): opencode `run --format json` emits one raw
// JSON event per line (session.created, message.part.updated/delta with
// part.type text|tool|..., permission.asked|replied, file.edited,
// session.diff, session.error, session.idle). Everything else is conservative
// text heuristics. A mislabel is harmless by contract: orchestrators must only
// observe these states, never gate/approve/kill on them.

export const EVENT_STATES = new Set([
  'queued',
  'researching',
  'editing',
  'testing',
  'verifying',
  'working',
  'question',
  'escalation',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);

const SUMMARY_MAX_LENGTH = 200;

function summarize(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > SUMMARY_MAX_LENGTH ? `${text.slice(0, SUMMARY_MAX_LENGTH)}…` : text;
}

function partText(part) {
  if (!part || typeof part !== 'object') return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.data?.text === 'string') return part.data.text;
  return '';
}

function toolIdentity(part) {
  if (!part || typeof part !== 'object') return '';
  for (const key of ['tool', 'name', 'command', 'title']) {
    if (typeof part[key] === 'string' && part[key].trim()) return part[key].trim();
  }
  return '';
}

const TEST_TOOL_PATTERN = /(npm|pnpm|yarn|bun|node|vitest|jest|pytest|py.test|go) (test|run test)|--test\b|test\.mjs\b/i;
const PASS_PATTERN = /(\b\d+\s+(pass|passed|ok)\b|\bPASS\b|\bAll tests passed\b|\bok \d+)/i;
const QUESTION_PATTERN = /(permission|approv\w+|confirm\w*|need (your |more )?input|please (confirm|approve|provide|clarify|specify)).{0,80}[?？]\s*$|^(approve|allow|deny)[?？]?\s*$/i;

function classifyJsonEvent(event) {
  const type = typeof event?.type === 'string' ? event.type : '';
  const part = event?.part && typeof event.part === 'object' ? event.part : null;
  const partType = typeof part?.type === 'string' ? part.type : '';

  if (type === 'permission.asked' || type === 'permission.v2.asked') {
    const what = toolIdentity(event?.permission) || toolIdentity(part) || type;
    return { state: 'question', summary: summarize(`permission asked: ${what}`) };
  }
  if (type === 'permission.replied' || type === 'permission.v2.replied') {
    return { state: 'researching', summary: summarize('permission replied, resuming') };
  }
  if (type === 'file.edited' || type === 'session.diff') {
    return { state: 'editing', summary: summarize(event?.file || event?.path || type) };
  }
  if (type === 'session.error') {
    return { state: 'blocked', summary: summarize(event?.error || event?.message || type) };
  }
  if (type === 'session.created' || type === 'session.idle' || event?.sessionID) {
    if (!type.startsWith('message.')) {
      return { state: 'researching', summary: summarize(event?.sessionID ? `session ${event.sessionID}` : type) };
    }
  }
  if (partType === 'tool' || type.includes('tool')) {
    const identity = toolIdentity(part) || toolIdentity(event) || summarize(JSON.stringify(event)).slice(0, 80);
    if (TEST_TOOL_PATTERN.test(identity) || TEST_TOOL_PATTERN.test(JSON.stringify(event))) {
      return { state: 'testing', summary: summarize(`test tool: ${identity}`) };
    }
    return { state: 'editing', summary: summarize(`tool: ${identity}`) };
  }
  // Text lives in part.type for server events but in event.type for the
  // legacy `run --format json` text lines the provider parser already reads.
  if (partType === 'text' || partType === 'reasoning' || type === 'text' || type === 'reasoning') {
    return { state: 'researching', summary: summarize(partText(part)) };
  }
  if (type) {
    return { state: 'working', summary: summarize(`event ${type}`) };
  }
  return { state: 'working', summary: summarize(JSON.stringify(event)) };
}

function classifyTextLine(line) {
  if (QUESTION_PATTERN.test(line)) {
    return { state: 'question', summary: summarize(line) };
  }
  if (TEST_TOOL_PATTERN.test(line)) {
    return { state: 'testing', summary: summarize(line) };
  }
  if (PASS_PATTERN.test(line)) {
    return { state: 'verifying', summary: summarize(line) };
  }
  if (/(^|\b)(edit|write|create|update|patch|appl(y|ied|ying))\b.{0,60}\b(file|path|to )\b/i.test(line)) {
    return { state: 'editing', summary: summarize(line) };
  }
  return { state: 'working', summary: summarize(line) };
}

export function classifyProviderLine(provider, line) {
  const text = String(line ?? '').trim();
  if (!text) return null;
  let parsed = null;
  if (text.startsWith('{')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (parsed && typeof parsed === 'object') {
    return classifyJsonEvent(parsed);
  }
  return classifyTextLine(text);
}

// Split raw byte chunks into complete lines. Chunks may cut mid-line and may
// use \r\n; empty lines are dropped. Flush at process end for the tail.
export function createLineSplitter(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += String(chunk ?? '');
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.replace(/\r$/, '').trim();
        if (line) onLine(line);
      }
    },
    flush() {
      const line = buffer.replace(/\r$/, '').trim();
      buffer = '';
      if (line) onLine(line);
    },
  };
}

// Map a thrown/returned run outcome to a terminal advisory state.
export function terminalStateForError(error) {
  if (error instanceof AiCliError) {
    if (error.code === 'PROVIDER_ABORTED') return 'cancelled';
    if (error.code === 'PROVIDER_TIMEOUT' || error.code === 'PROVIDER_OUTPUT_LIMIT') return 'blocked';
  }
  return 'failed';
}
