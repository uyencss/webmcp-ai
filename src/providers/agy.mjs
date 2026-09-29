import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AiCliError } from '../errors.mjs';

// `-p <prompt>` argv lane. AGY 1.1.1 accepts prompts only as command
// arguments over this lane; a prompt above the cap does not fail outright,
// it moves to the stream-json lane below (see MAX_STREAM_PROMPT_BYTES).
export const MAX_PROMPT_ARG_BYTES = 128 * 1024;
// `--input-format stream-json --output-format stream-json` lane, verified on
// AGY 1.2.13 (canary 2026-09-29): a single `{"event":"user",...}` NDJSON line
// on stdin, no prompt text in argv. A prompt above this bound is rejected
// with PROMPT_TOO_LARGE before spawn; there is no larger lane.
export const MAX_STREAM_PROMPT_BYTES = 4 * 1024 * 1024;
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Print-mode guard: every bounded (non-full) AGY lane disables slash-command
// expansion so a prompt cannot trigger interactive-only skill behavior in a
// headless print session. Verified present in the installed `agy --help`
// (1.2.13) via validateAgyBoundedSupport before spawn.
export const AGY_BOUNDED_REQUIRED_FLAGS = Object.freeze(['--disable-slash-commands']);

function helpContainsToken(helpText, token) {
  const escaped = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s,=<>()[\\]"'])${escaped}(?=$|[\\s,=<>()[\\]"'])`).test(String(helpText ?? ''));
}

export function validateAgyBoundedSupport(helpText) {
  const text = String(helpText ?? '');
  const missing = AGY_BOUNDED_REQUIRED_FLAGS.filter((flag) => !helpContainsToken(text, flag));
  if (missing.length > 0) {
    throw new AiCliError('PROVIDER_CAPABILITY_DRIFT', `Installed AGY CLI lacks bounded print-mode guard flags: ${missing.join(', ')}`, {
      exitCode: 2,
      details: { capability: 'bounded-guard', missing },
    });
  }
  return true;
}

function installComposeOnlyGuard(workspace) {
  const agentsDir = join(workspace, '.agents');
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  const guardPath = join(agentsDir, 'webmcp-ai-deny-all-pretooluse.mjs');
  writeFileSync(guardPath, [
    '#!/usr/bin/env node',
    "process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'webmcp-ai compose-only policy denies all Agy tool calls' }) + '\\n');",
    '',
  ].join('\n'), { mode: 0o700 });
  const hooks = {
    'webmcp-ai-compose-only': {
      PreToolUse: [{
        matcher: '*',
        hooks: [{
          type: 'command',
          command: `${process.execPath} ${guardPath}`,
          timeout: 5,
        }],
      }],
    },
  };
  writeFileSync(join(agentsDir, 'hooks.json'), `${JSON.stringify(hooks, null, 2)}\n`, { mode: 0o600 });
  return () => rmSync(agentsDir, { recursive: true, force: true });
}

// Envelope shape returned by `--output-format json` (single blob, canary
// 2026-09-29 on AGY 1.2.13): { conversation_id, status, response,
// duration_seconds, num_turns, structured_output?, json_schema?, usage }.
// `requireStructured` is true only when the caller supplied request.schema:
// AGY coerces impossible schema constraints rather than erroring, so a
// missing structured_output with a requested schema is a provider defect,
// not a caller error.
function agyEnvelopeResult(envelope, { requireStructured }) {
  const structured = envelope.structured_output ?? null;
  if (requireStructured && (structured === null || structured === undefined)) {
    throw new AiCliError('PROVIDER_STRUCTURED_OUTPUT_MISSING', 'AGY response did not include structured_output for the requested schema', {
      exitCode: 1,
      retryable: false,
      details: { provider: 'agy', capability: 'structuredOutput' },
    });
  }
  return {
    text: typeof envelope.response === 'string' ? envelope.response.trim() : '',
    structured,
    sessionId: envelope.conversation_id ?? null,
  };
}

export const agyProvider = {
  id: 'agy',
  name: 'AGY',
  envBin: 'AGY_BIN',
  defaultBin: 'agy',
  capabilities: {
    structuredOutput: true,
    // No raw-text stdin prompt lane: prompts travel as `-p` argv or as a
    // structured NDJSON envelope on the stream-json lane, never as raw text.
    stdinPrompt: false,
    explicitResume: true,
    explicitFork: false,
    modelDiscovery: true,
    toolPolicies: ['provider-default', 'compose-only'],
    printModeGuards: ['--disable-slash-commands'],
    // Verified on the installed `agy --help` (1.2.13, canary 2026-09-29):
    // --effort accepts exactly this closed set. Provider-level layer; the
    // per-model MODEL_OVERRIDES table in model-capabilities.mjs remains the
    // model-specific evidence layer and still wins when a model is
    // positively known to reject --effort entirely.
    effort: { values: ['low', 'medium', 'high', 'max'] },
    structuredOutputProbe: { verifiedOn: '2026-09-29', cli: '1.2.13', method: 'canary' },
    // Machine-readable mirror of the gates below: legacy generate defaults to
    // plan and also honors accept-edits; every portable vNext taskIntent is
    // rejected here (preventive deny-write unproven), so discovery must not
    // advertise any of them. Legacy toolPolicy compose-only stays supported.
    agentModes: { supported: true, values: ['plan', 'accept-edits'], default: 'plan' },
    taskIntents: {
      review: { supported: false, reason: 'AGY does not support preventive deny-write review mode' },
      compose: { supported: false, reason: 'AGY vNext compose is not deny-write provable; legacy toolPolicy compose-only remains supported' },
      implement: { supported: false, reason: 'AGY does not support preventive deny-write review mode' },
      plan: { supported: false, reason: 'AGY does not support preventive deny-write review mode; plan additionally needs a separate webmcp-ai-plan-result/1 contract' },
    },
  },
  buildInvocation(request) {
    if (request.sessionAction === 'fork') {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'AGY does not support explicit session fork', {
        exitCode: 2,
        details: { capability: 'explicitFork' },
      });
    }
    // Portable vNext lane: AGY cannot prove preventive deny-write for a
    // review sandbox and has no proven non-Plan reviewer/compose mapping, so
    // every vNext taskIntent fails closed with UNSUPPORTED_CAPABILITY. This
    // guarantees no vNext request implicitly selects native Plan mode and
    // never widens to accept-edits. Legacy callers without taskIntent keep
    // the exact prior plan/accept-edits path below.
    const taskIntent = request.taskIntent ?? null;
    if (typeof taskIntent === 'string' && !['compose', 'review', 'implement', 'plan'].includes(taskIntent)) {
      throw new AiCliError('TASK_INTENT_INVALID', `Unknown taskIntent: ${taskIntent}`, {
        exitCode: 2,
        details: { taskIntent },
      });
    }
    if (taskIntent === 'review' || taskIntent === 'plan' || taskIntent === 'compose' || taskIntent === 'implement') {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'AGY does not support preventive deny-write review mode', {
        exitCode: 2,
        details: { capability: 'review', taskIntent, accessProfile: request.accessProfile ?? null },
      });
    }
    const agentMode = request.agentMode ?? 'plan';
    if (!['plan', 'accept-edits'].includes(agentMode)) {
      throw new AiCliError('INVALID_INPUT', 'AGY agentMode must be plan or accept-edits', {
        exitCode: 2,
      });
    }
    if (request.agent && !AGENT_NAME_PATTERN.test(request.agent)) {
      throw new AiCliError(
        'INVALID_INPUT',
        'AGY agent must be a simple discovered agent name (letters, numbers, dot, underscore, or hyphen)',
        { exitCode: 2 },
      );
    }

    const promptBytes = Buffer.byteLength(request.prompt, 'utf8');
    const useStreamLane = promptBytes > MAX_PROMPT_ARG_BYTES;
    if (useStreamLane && promptBytes > MAX_STREAM_PROMPT_BYTES) {
      throw new AiCliError(
        'PROMPT_TOO_LARGE',
        `AGY prompts are limited to ${MAX_STREAM_PROMPT_BYTES} bytes over the stream-json lane`,
        { exitCode: 2, details: { maxPromptBytes: MAX_STREAM_PROMPT_BYTES } },
      );
    }

    // Serialize the schema BEFORE any temp allocation below: a circular or
    // BigInt schema throws here, while nothing has been written to disk yet.
    const schemaPayload = request.schema ? `${JSON.stringify(request.schema, null, 2)}\n` : null;

    const seconds = Math.max(1, Math.ceil(request.timeoutMs / 1000));
    // Full passthrough (opt-in via --full): drop the forced sandbox so the
    // child runs like the native CLI with full folder + tool access.
    const isFull = request.accessProfile === 'full';
    // Bounded print-mode guard: validated before any side effect (the
    // schema temp dir and compose-only guard directory below) so a direct
    // caller supplying a drifted request.agyHelpText never strands a temp
    // artifact. The live spawn lane runs the equivalent probe in
    // src/client.mjs before this adapter is invoked; this is the
    // direct-adapter-call seam.
    if (!isFull && request.agyHelpText !== undefined && request.agyHelpText !== null) {
      validateAgyBoundedSupport(request.agyHelpText);
    }

    // Bounded temp dir for the schema file. Created only after every
    // pre-allocation validation above has passed, so a validation failure
    // (invalid agentMode/agent, prompt too large, drifted bounded-guard
    // help) never allocates a temp dir in the first place.
    let schemaFile = null;
    let schemaCleanup = null;
    if (schemaPayload !== null) {
      const dir = mkdtempSync(join(tmpdir(), 'webmcp-ai-agy-'));
      schemaCleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };
      schemaFile = join(dir, 'schema.json');
      try {
        writeFileSync(schemaFile, schemaPayload, { mode: 0o600 });
      } catch (error) {
        schemaCleanup();
        throw error;
      }
    }

    try {
      const cleanupGuard = request.toolPolicy === 'compose-only'
        ? installComposeOnlyGuard(request.workspace)
        : null;

      // Native, non-widening flag: applies on every lane (bounded and full)
      // and both prompt lanes. The stream-json lane already carries
      // --output-format stream-json (below), so only --json-schema is added
      // there; the arg lane adds the json output format alongside it.
      const schemaArgs = schemaFile
        ? (useStreamLane ? ['--json-schema', schemaFile] : ['--output-format', 'json', '--json-schema', schemaFile])
        : [];

      const args = useStreamLane
        ? [
          '--input-format', 'stream-json',
          '--output-format', 'stream-json',
          ...(!isFull ? ['--sandbox'] : []),
          '--mode', agentMode,
          ...(!isFull ? ['--disable-slash-commands'] : []),
          '--print-timeout', `${seconds}s`,
          ...(request.agent ? ['--agent', request.agent] : []),
          ...(request.model ? ['--model', request.model] : []),
          ...(request.effort ? ['--effort', request.effort] : []),
          ...(request.sessionId ? ['--conversation', request.sessionId] : []),
          ...schemaArgs,
        ]
        : [
          '-p', request.prompt,
          ...(!isFull ? ['--sandbox'] : []),
          '--mode', agentMode,
          ...(!isFull ? ['--disable-slash-commands'] : []),
          '--print-timeout', `${seconds}s`,
          ...(request.agent ? ['--agent', request.agent] : []),
          ...(request.model ? ['--model', request.model] : []),
          ...(request.effort ? ['--effort', request.effort] : []),
          ...(request.sessionId ? ['--conversation', request.sessionId] : []),
          ...schemaArgs,
        ];

      // Stream-json lane: exactly one NDJSON line on stdin, closed right
      // after by process-runner (stdin !== null triggers child.stdin.end
      // with this exact string) — a single turn by construction, never a
      // second message.
      const stdin = useStreamLane
        ? `${JSON.stringify({ event: 'user', message: { role: 'user', content: request.prompt } })}\n`
        : null;

      return {
        args,
        stdin,
        cleanup: () => {
          cleanupGuard?.();
          schemaCleanup?.();
        },
      };
    } catch (error) {
      // A later validation/side-effect failure (drifted compose-only guard
      // write, etc.) must not strand the schema temp dir: invocation.cleanup
      // was never returned to the caller, so this is the only seam.
      schemaCleanup?.();
      throw error;
    }
  },
  parseOutput({ stdout, request }) {
    const trimmed = stdout.trim();
    const requireStructured = Boolean(request?.schema);

    // Single JSON envelope: the `--output-format json` lane (with or
    // without a schema). Detected by shape (an object with a `status`
    // string), not by which lane built the invocation, so a direct adapter
    // call sees the same behavior as the live spawn lane.
    let singleBlob;
    try {
      singleBlob = JSON.parse(trimmed);
    } catch {
      singleBlob = undefined;
      // Not a single JSON blob; fall through to NDJSON / plain-text handling.
    }
    if (singleBlob && typeof singleBlob === 'object' && !Array.isArray(singleBlob) && typeof singleBlob.status === 'string') {
      // Outside the try/catch above: a typed error thrown by agyEnvelopeResult
      // (e.g. PROVIDER_STRUCTURED_OUTPUT_MISSING) must propagate, never be
      // swallowed as if this were a JSON.parse failure.
      return agyEnvelopeResult(singleBlob, { requireStructured });
    }

    // Stream-json lane NDJSON: scan lines for the last `result` event.
    // Lines that fail to parse, or parse but carry no `event` field, are
    // tolerated as trailing noise; only a genuine AGY stream event (object
    // with a string `event` field) marks this as the stream-json lane.
    let lastResult = null;
    let sawStreamEvent = false;
    for (const line of trimmed.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      let event;
      try {
        event = JSON.parse(t);
      } catch {
        continue;
      }
      if (event && typeof event === 'object' && typeof event.event === 'string') {
        sawStreamEvent = true;
        if (event.event === 'result') lastResult = event.result ?? null;
      }
    }
    if (sawStreamEvent) {
      if (!lastResult) {
        throw new AiCliError('PROVIDER_EXIT_ERROR', 'AGY stream-json output ended without a result event', {
          retryable: true,
          details: { provider: 'agy', status: null },
        });
      }
      if (lastResult.status !== 'SUCCESS') {
        throw new AiCliError('PROVIDER_EXIT_ERROR', `AGY stream-json result status was ${lastResult.status ?? 'unknown'}`, {
          retryable: true,
          details: { provider: 'agy', status: lastResult.status ?? null },
        });
      }
      return agyEnvelopeResult(lastResult, { requireStructured });
    }

    // Legacy plain-text lane (no --output-format json/stream-json): AGY
    // returns a resumable conversation id only via the json/stream-json
    // envelope above; this lane still has none.
    return { text: trimmed, structured: null, sessionId: null };
  },
  modelsInvocation: { args: ['models'], stdin: null },
  agentsInvocation: { args: ['agents'], stdin: null },
};
