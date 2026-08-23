#!/usr/bin/env node
// One-Dispatch Claude PreToolUse hook. Reads the provider hook JSON from
// stdin, loads a mode-0600 policy/capability pair by environment path, and
// returns the documented allow/deny JSON. Never prints the capability, raw
// prompt or environment.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import net from 'node:net';

const REDACTED = '[REDACTED]';

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function deny(reason) {
  process.stdout.write(`${JSON.stringify({ decision: 'deny', reason })}\n`);
  process.exit(0);
}

function decide(decision, extra = {}) {
  process.stdout.write(`${JSON.stringify({ decision, ...extra }, null, 0)}\n`);
  process.exit(0);
}

function isWithin(candidateRoot, rootPath) {
  const rel = relative(rootPath, candidateRoot);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function supervisorReachable(endpoint, timeoutMs) {
  if (!endpoint) return null; // unknown — treated per policy default below
  return new Promise((resolveReachable) => {
    const socket = net.connect(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      resolveReachable(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolveReachable(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolveReachable(false);
    });
  });
}

async function main() {
  const hookInput = readStdin();
  const policyPath = process.env.WEBMCP_HOOK_POLICY;
  const capabilityPath = process.env.WEBMCP_HOOK_CAPABILITY;
  if (!policyPath || !capabilityPath) deny('hook policy or capability path missing');

  const policy = loadJson(policyPath);
  const capability = loadJson(capabilityPath);
  if (!policy || !capability) deny('unreadable hook policy or capability');

  // Capability freshness and binding.
  const tokenHash = createHash('sha256').update(String(capability.token ?? '')).digest('hex');
  if (tokenHash !== policy.capabilityTokenHash) deny('capability does not match policy');
  if (capability.expiresAt && Date.parse(capability.expiresAt) < Date.now()) deny('capability expired');
  if (policy.coordinationId !== capability.coordinationId || policy.dispatchId !== capability.dispatchId) {
    deny('capability bound to another dispatch');
  }

  const toolName = String(hookInput.tool_name ?? '');
  const toolInput = hookInput.tool_input ?? {};
  let reachability;
  if (policy.supervisorUnreachableForTest === true) {
    reachability = false;
  } else if (policy.supervisorIpcEndpoint) {
    reachability = await supervisorReachable(policy.supervisorIpcEndpoint, policy.unreachableTimeoutMs ?? 500);
  } else {
    reachability = true; // in-process supervisors are the alpha default
  }
  if (reachability === false) {
    // Fail closed for mutation; pure reads may proceed.
    const readOnlyTools = new Set(['Read', 'Grep', 'Glob']);
    if (readOnlyTools.has(toolName)) {
      decide('allow', { reason: 'supervisor unreachable; read-only allowed' });
    }
    deny('supervisor unreachable; mutable tools denied');
  }

  const canonicalize = (candidate) => resolve(candidate);

  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
    const target = canonicalize(String(toolInput.file_path ?? toolInput.path ?? '.'));
    if (!isWithin(target, policy.workspace)) deny('read outside workspace');
    const allowed = (policy.allowedReadRoots ?? [policy.workspace]).some((root) => isWithin(target, root));
    if (!allowed) deny('read outside allowed roots');
    decide('allow', {});
  }

  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    const target = canonicalize(String(toolInput.file_path ?? ''));
    if (!isWithin(target, policy.workspace)) deny('write outside workspace');
    for (const guarded of policy.protectedPaths ?? []) {
      if (isWithin(target, guarded)) deny('protected path');
    }
    const writable = (policy.allowedWriteRoots ?? []).some((root) => isWithin(target, root));
    if (!writable) deny('write outside allowed write roots');
    decide('allow', { checkpoint: true });
  }

  if (toolName === 'Bash') {
    const command = String(toolInput.command ?? '').trim();
    const executable = command.split(/\s+/)[0] ?? '';
    if (!(policy.allowedExecutables ?? []).includes(executable)) deny('executable outside allowlist');
    for (const forbidden of ['rm ', 'git push', 'sudo', '>']) {
      if (command.includes(forbidden)) deny(`forbidden pattern: ${REDACTED}`);
    }
    decide('allow', {});
  }

  deny(`unsupported tool ${toolName}`);
}

main().catch(() => deny('hook failure'));
