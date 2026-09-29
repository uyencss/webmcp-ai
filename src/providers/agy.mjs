import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AiCliError } from '../errors.mjs';

export const MAX_PROMPT_ARG_BYTES = 128 * 1024;
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

export const agyProvider = {
  id: 'agy',
  name: 'AGY',
  envBin: 'AGY_BIN',
  defaultBin: 'agy',
  capabilities: {
    structuredOutput: false,
    stdinPrompt: false,
    explicitResume: true,
    modelDiscovery: true,
    toolPolicies: ['provider-default', 'compose-only'],
    printModeGuards: ['--disable-slash-commands'],
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
    if (Buffer.byteLength(request.prompt, 'utf8') > MAX_PROMPT_ARG_BYTES) {
      throw new AiCliError(
        'PROMPT_TOO_LARGE',
        `AGY prompts are limited to ${MAX_PROMPT_ARG_BYTES} bytes because AGY 1.1.1 accepts prompts only as command arguments`,
        { exitCode: 2, details: { maxPromptBytes: MAX_PROMPT_ARG_BYTES } },
      );
    }
    if (request.schema) {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'AGY does not expose structured output in the installed CLI', {
        exitCode: 2,
        details: { capability: 'structuredOutput' },
      });
    }
    const seconds = Math.max(1, Math.ceil(request.timeoutMs / 1000));
    // Full passthrough (opt-in via --full): drop the forced sandbox so the
    // child runs like the native CLI with full folder + tool access.
    const isFull = request.accessProfile === 'full';
    // Bounded print-mode guard: validated before any side effect (the
    // compose-only guard directory below) so a direct caller supplying a
    // drifted request.agyHelpText never strands a temp guard on disk. The
    // live spawn lane runs the equivalent probe in src/client.mjs before
    // this adapter is invoked; this is the direct-adapter-call seam.
    if (!isFull && request.agyHelpText !== undefined && request.agyHelpText !== null) {
      validateAgyBoundedSupport(request.agyHelpText);
    }
    const cleanupGuard = request.toolPolicy === 'compose-only'
      ? installComposeOnlyGuard(request.workspace)
      : null;
    return {
      args: [
        '-p', request.prompt,
        ...(!isFull ? ['--sandbox'] : []),
        '--mode', agentMode,
        ...(!isFull ? ['--disable-slash-commands'] : []),
        '--print-timeout', `${seconds}s`,
        ...(request.agent ? ['--agent', request.agent] : []),
        ...(request.model ? ['--model', request.model] : []),
        ...(request.effort ? ['--effort', request.effort] : []),
        ...(request.sessionId ? ['--conversation', request.sessionId] : []),
      ],
      stdin: null,
      cleanup: () => {
        cleanupGuard?.();
      },
    };
  },
  parseOutput({ stdout }) {
    // AGY does not return a resumable conversation id; resume requires an
    // explicit --conversation value supplied by the caller.
    return { text: stdout.trim(), structured: null, sessionId: null };
  },
  modelsInvocation: { args: ['models'], stdin: null },
  agentsInvocation: { args: ['agents'], stdin: null },
};
