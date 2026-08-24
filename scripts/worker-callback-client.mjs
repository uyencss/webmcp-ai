#!/usr/bin/env node
// Packaged worker callback client.
//
// A real child process learns its callback route through EXACTLY one trusted
// environment variable: WEBMCP_AI_WORKER_CAPABILITY_FILE, pointing at the
// supervisor-owned capability file (mode 0600 inside a 0700 directory). The
// dispatch capability token itself never appears in argv, prompts or logs —
// this client reads it from the file and authenticates each frame against the
// per-binding route.
//
// Programmatic use:
//   import { sendWorkerCallback, sendProgress, sendTerminal } from '<pkg>/scripts/worker-callback-client.mjs';
//
// CLI use:
//   node worker-callback-client.mjs progress --summary "step 1 done"
//   node worker-callback-client.mjs question  --question "continue?"
//   node worker-callback-client.mjs escalation --reason "blocked"
//   node worker-callback-client.mjs heartbeat
//   node worker-callback-client.mjs terminal --outcome done --summary "finished"
//   node worker-callback-client.mjs demo [--trigger <path>] [--summary "..."]
//
// Connection retries are built in so a child can reconnect after a supervisor
// restart (same coordination endpoint) without losing exactly-once identity.

import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const WORKER_CALLBACK_PROTOCOL = 'webmcp.ai-worker-callback/v0';
const ORCHESTRATION_PROTOCOL = 'webmcp.ai-orchestration/v0';
const CAPABILITY_SCHEMA = 'webmcp.ai-dispatch-capability/v1';

let seqCounter = 0;
const nextSeq = () => {
  seqCounter += 1;
  return seqCounter;
};

function loadCapability(explicitPath = undefined) {
  const path = explicitPath ?? process.env.WEBMCP_AI_WORKER_CAPABILITY_FILE;
  if (!path || typeof path !== 'string') {
    throw new Error(`WEBMCP_AI_WORKER_CAPABILITY_FILE is not set; the worker cannot locate its capability file`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed?.schema !== CAPABILITY_SCHEMA) {
    throw new Error('capability file schema mismatch');
  }
  for (const field of ['endpoint', 'coordinationId', 'taskId', 'dispatchId', 'bindingId', 'capabilityToken']) {
    if (typeof parsed[field] !== 'string' || parsed[field].length === 0) {
      throw new Error(`capability file is missing ${field}`);
    }
  }
  return { ...parsed, path };
}

async function requestIpc(endpoint, envelope, { timeoutMs = 5_000 } = {}) {
  // Reuse the packaged IPC transport verbatim so worker frames traverse the
  // same authenticated socket protocol as every other client.
  const { requestIpc: transportRequest } = await import('../src/orchestration/ipc.mjs');
  return transportRequest(endpoint, envelope, { timeoutMs });
}

/**
 * Send one worker callback with retry-on-reconnect semantics. Retries cover
 * transport failures only (supervisor restarting); typed authorization or
 * validation rejections surface immediately.
 */
export async function sendWorkerCallback(operation, input = {}, options = {}) {
  const cap = loadCapability(options.capabilityFile);
  const envelope = {
    protocol: ORCHESTRATION_PROTOCOL,
    requestId: `req_cbk_${randomBytes(6).toString('hex')}`,
    coordinationId: cap.coordinationId,
    fenceEpoch: Number.isInteger(options.fenceEpoch) ? options.fenceEpoch : cap.fenceEpoch,
    // Route-scoped secret: authenticated against THIS binding's capability.
    capability: cap.capabilityToken,
    operation: `worker.${operation.replace(/^worker\./, '')}`,
    input: {
      schema: WORKER_CALLBACK_PROTOCOL,
      callbackId: `cbk_${randomBytes(8).toString('hex')}`,
      coordinationId: cap.coordinationId,
      taskId: cap.taskId,
      dispatchId: cap.dispatchId,
      bindingId: cap.bindingId,
      fenceEpoch: Number.isInteger(options.fenceEpoch) ? options.fenceEpoch : cap.fenceEpoch,
      callbackSeq: options.callbackSeq ?? nextSeq(),
      operation: `worker.${operation.replace(/^worker\./, '')}`,
      input,
    },
  };
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  for (;;) {
    let response;
    try {
      response = await requestIpc(cap.endpoint, envelope, { timeoutMs: options.perAttemptTimeoutMs ?? 4_000 });
    } catch (transportError) {
      if (Date.now() >= deadline) {
        const error = new Error(`callback transport failed after retries: ${transportError?.code ?? transportError?.message}`);
        error.code = transportError?.code ?? 'ECONNFAILED';
        throw error;
      }
      await new Promise((resolveTick) => setTimeout(resolveTick, 200));
      continue;
    }
    return response;
  }
}

export const sendHeartbeat = (input = {}, options = {}) => sendWorkerCallback('heartbeat', input, options);
export const sendProgress = (input = {}, options = {}) => sendWorkerCallback('progress', input, options);
export const sendQuestion = (input = {}, options = {}) => sendWorkerCallback('question', input, options);
export const sendEscalation = (input = {}, options = {}) => sendWorkerCallback('escalation', input, options);
export async function sendTerminal({ outcome = 'done', summary = '' } = {}, options = {}) {
  return sendWorkerCallback('terminal', { outcome, summary }, options);
}

/** Demo flow used by end-to-end harnesses: progress, optional trigger wait, terminal. */
async function demo(flags) {
  const progress = await sendProgress({ summary: flags.summary ?? 'demo progress' }, {});
  process.stdout.write(`${JSON.stringify({ step: 'progress', ok: progress.ok ?? false })}\n`);
  if (flags.trigger) {
    const deadline = Date.now() + 30_000;
    while (!existsSync(flags.trigger)) {
      if (Date.now() > deadline) throw new Error('trigger never appeared');
      await new Promise((resolveTick) => setTimeout(resolveTick, 100));
    }
  }
  const terminal = await sendTerminal({ outcome: 'done', summary: flags.summary ?? 'demo terminal' }, {});
  process.stdout.write(`${JSON.stringify({ step: 'terminal', ok: terminal.ok ?? false })}\n`);
  if (progress.ok !== true || terminal.ok !== true) process.exit(5);
}

function readFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    if (key) flags[key] = argv[index + 1];
  }
  return flags;
}

// Direct-execution detection must survive symlinked entry paths (macOS
// /var -> /private/var): compare BOTH the raw and the real path.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const candidates = [process.argv[1]];
  try {
    candidates.push(realpathSync(process.argv[1]));
  } catch { /* missing entry */ }
  return candidates.some((candidate) => {
    try {
      return import.meta.url === pathToFileURL(candidate).href;
    } catch {
      return false;
    }
  });
})();

if (invokedDirectly) {
  const operation = process.argv[2];
  const flags = readFlags(process.argv.slice(3));
  (async () => {
    if (operation === 'demo') return demo(flags);
    if (!operation) throw new Error('usage: worker-callback-client.mjs <heartbeat|progress|question|escalation|terminal|demo>');
    const input = {};
    if (flags.summary !== undefined) input.summary = String(flags.summary);
    if (flags.question !== undefined) input.question = String(flags.question);
    if (flags.reason !== undefined) input.reason = String(flags.reason);
    if (operation === 'terminal') {
      return sendTerminal({ outcome: flags.outcome ?? 'done', summary: input.summary ?? '' });
    }
    return sendWorkerCallback(operation, input);
  })()
    .then((result) => {
      if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${String(error?.message ?? error)}\n`);
      process.exit(1);
    });
}
