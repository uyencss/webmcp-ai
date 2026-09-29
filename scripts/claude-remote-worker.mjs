#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const DEFAULT_CLAUDE_BIN = '/Users/ttcenter/.local/bin/claude';
const MAX_TOTAL_ARGV_BYTES = 1024 * 1024; // 1 MiB
const MAX_SINGLE_ARG_BYTES = 256 * 1024; // 256 KiB
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const ALLOWED_BOOLEAN_FLAGS = new Set([
  '-p',
  '--safe-mode',
  '--no-chrome',
  '--verbose',
  '--no-session-persistence',
  '--fork-session',
  '--disable-slash-commands',
]);

const ALLOWED_VALUE_FLAGS = new Set([
  '--permission-mode',
  '--tools',
  '--disallowedTools',
  '--output-format',
  '--resume',
  '--model',
  '--effort',
  '--json-schema',
  '--permission-prompts',
]);

const ALLOWED_ENV_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM',
]);

function isAllowedEnvKey(key) {
  if (typeof key !== 'string') return false;
  if (/^(WEBMCP_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|SSH_)/i.test(key)) return false;
  if (/(?:TOKEN|KEY|SECRET)/i.test(key)) return false;
  return ALLOWED_ENV_EXACT.has(key) || key.startsWith('LC_') || key.startsWith('FAKE_');
}

function parseCliArgs(argv) {
  let mode = null;
  let claudeBin = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') {
      mode = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--mode=')) {
      mode = arg.slice(7);
    } else if (arg === '--claude-bin') {
      claudeBin = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--claude-bin=')) {
      claudeBin = arg.slice(13);
    }
  }
  return { mode, claudeBin };
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString('utf8');
}

function resolveClaudeBin(cliFlag, env = process.env) {
  const candidate = cliFlag || env.WEBMCP_AI_CLAUDE_REMOTE_BIN || DEFAULT_CLAUDE_BIN;
  if (!candidate || typeof candidate !== 'string' || !isAbsolute(candidate)) {
    process.stderr.write('claude binary path must be an absolute path\n');
    process.exit(64);
  }
  if (candidate.includes('\0') || candidate.split('/').includes('..')) {
    process.stderr.write('claude binary path must not contain null bytes or parent segments\n');
    process.exit(64);
  }
  return candidate;
}

function extractSemverToken(text) {
  const match = String(text ?? '').match(/(?:(?<=\bv)|\b)\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match ? match[0] : null;
}

function validatePathNoTraversal(p, label) {
  if (typeof p !== 'string' || !p || !isAbsolute(p)) {
    process.stderr.write(`${label} must be a non-empty absolute path\n`);
    process.exit(64);
  }
  if (p.includes('\0') || p.split('/').includes('..')) {
    process.stderr.write(`${label} must not contain null bytes or parent traversal segments\n`);
    process.exit(64);
  }
}

function validateAndContainCwd(cwd, workspaceRoot) {
  validatePathNoTraversal(workspaceRoot, 'workspaceRoot');
  let realRoot;
  try {
    realRoot = realpathSync(workspaceRoot);
  } catch (err) {
    process.stderr.write(`workspaceRoot realpath failed: ${err.message}\n`);
    process.exit(64);
  }

  if (cwd === null || cwd === undefined) {
    return { effectiveCwd: null, isCompose: true, realRoot };
  }

  validatePathNoTraversal(cwd, 'cwd');
  let realCwd;
  try {
    realCwd = realpathSync(cwd);
  } catch (err) {
    process.stderr.write(`cwd realpath failed: ${err.message}\n`);
    process.exit(64);
  }

  const isContained = realCwd === realRoot || realCwd.startsWith(realRoot.endsWith('/') ? realRoot : `${realRoot}/`);
  if (!isContained) {
    process.stderr.write('cwd not contained under workspaceRoot\n');
    process.exit(64);
  }

  return { effectiveCwd: realCwd, isCompose: false, realRoot };
}

function validateArgv(args) {
  if (!Array.isArray(args)) {
    process.stderr.write('args must be an array of strings\n');
    process.exit(64);
  }
  let totalBytes = 0;
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (typeof item !== 'string') {
      process.stderr.write('args must contain only strings\n');
      process.exit(64);
    }
    if (item.includes('\0')) {
      process.stderr.write('arg contains null byte\n');
      process.exit(64);
    }
    const byteLen = Buffer.byteLength(item, 'utf8');
    if (byteLen > MAX_SINGLE_ARG_BYTES) {
      process.stderr.write('single arg exceeds maximum allowed bytes\n');
      process.exit(64);
    }
    totalBytes += byteLen;
    if (totalBytes > MAX_TOTAL_ARGV_BYTES) {
      process.stderr.write('total argv exceeds maximum allowed bytes\n');
      process.exit(64);
    }
  }

  // Token-by-token validation against allowlist
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (ALLOWED_BOOLEAN_FLAGS.has(token)) {
      continue;
    }
    if (ALLOWED_VALUE_FLAGS.has(token)) {
      if (i + 1 >= args.length) {
        process.stderr.write(`flag missing required value: ${token}\n`);
        process.exit(64);
      }
      i += 1;
      continue;
    }
    // Token is disallowed or unknown
    const flagName = token.startsWith('-') ? token : '<unknown-flag>';
    process.stderr.write(`disallowed or unknown flag: ${flagName}\n`);
    process.exit(64);
  }
}

function buildChildEnv(requestEnv) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (isAllowedEnvKey(k)) {
      env[k] = v;
    }
  }
  if (requestEnv && typeof requestEnv === 'object' && !Array.isArray(requestEnv)) {
    for (const [k, v] of Object.entries(requestEnv)) {
      if (isAllowedEnvKey(k)) {
        env[k] = String(v);
      }
    }
  }
  return env;
}

async function handleRun(request, claudeBin) {
  validateArgv(request.args);
  const prompt = typeof request.prompt === 'string' ? request.prompt : '';
  const { effectiveCwd, isCompose } = validateAndContainCwd(request.cwd, request.workspaceRoot);

  let composeTempDir = null;
  let targetCwd = effectiveCwd;
  if (isCompose) {
    composeTempDir = mkdtempSync(join(tmpdir(), 'webmcp-ai-claude-remote-worker-compose-'));
    targetCwd = composeTempDir;
  }

  const childEnv = buildChildEnv(request.env);
  const timeoutMs = Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = Number(request.maxOutputBytes) > 0 ? Number(request.maxOutputBytes) : DEFAULT_MAX_OUTPUT_BYTES;

  const startedAt = Date.now();
  let timedOut = false;
  let child = null;
  let timer = null;
  let killTimer = null;

  try {
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const truncated = { stdout: false, stderr: false };

    const result = await new Promise((resolve) => {
      child = spawn(claudeBin, request.args, {
        cwd: targetCwd,
        env: childEnv,
        detached: process.platform !== 'win32',
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const onSignal = () => {
        if (!child.pid || child.killed) return;
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {}
      };
      process.once('SIGTERM', onSignal);
      process.once('SIGHUP', onSignal);
      process.once('SIGINT', onSignal);

      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
          else child.kill('SIGTERM');
        } catch {}
        killTimer = setTimeout(() => {
          try {
            if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {}
        }, 5000);
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          truncated.stdout = true;
          const allowed = maxOutputBytes - (stdoutBytes - chunk.length);
          if (allowed > 0) stdoutChunks.push(chunk.subarray(0, allowed));
        } else {
          stdoutChunks.push(chunk);
        }
      });

      child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > maxOutputBytes) {
          truncated.stderr = true;
          const allowed = maxOutputBytes - (stderrBytes - chunk.length);
          if (allowed > 0) stderrChunks.push(chunk.subarray(0, allowed));
        } else {
          stderrChunks.push(chunk);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        process.removeListener('SIGTERM', onSignal);
        process.removeListener('SIGHUP', onSignal);
        process.removeListener('SIGINT', onSignal);
        resolve({
          exitCode: 1,
          signal: null,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: `Failed to start Claude CLI: ${err.message}`,
        });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        process.removeListener('SIGTERM', onSignal);
        process.removeListener('SIGHUP', onSignal);
        process.removeListener('SIGINT', onSignal);
        resolve({
          exitCode: code ?? (signal ? 128 + 15 : 0),
          signal: signal ?? null,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        });
      });

      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });

    const response = {
      schema: 'webmcp-ai-claude-remote-response/1',
      mode: 'run',
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut,
      truncated,
      durationMs: Date.now() - startedAt,
    };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } finally {
    if (composeTempDir) {
      try {
        rmSync(composeTempDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

function handleFingerprint(request) {
  if (request.cwd === null || request.cwd === undefined) {
    process.stderr.write('fingerprint requires cwd\n');
    process.exit(64);
  }
  const { effectiveCwd } = validateAndContainCwd(request.cwd, request.workspaceRoot);
  const cwd = effectiveCwd;

  const isGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });

  if (isGit.status !== 0) {
    const res = {
      head: null,
      tree: null,
      statusDigest: null,
      diffDigest: null,
      untrackedCount: 0,
      untrackedDigest: null,
      nonGit: true,
    };
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return;
  }

  const headProbe = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 10_000 });
  const head = headProbe.status === 0 ? headProbe.stdout.trim() : null;

  const treeProbe = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd, encoding: 'utf8', timeout: 10_000 });
  const tree = treeProbe.status === 0 ? treeProbe.stdout.trim() : null;

  const statusProbe = spawnSync('git', ['status', '--porcelain=v1', '-z'], { cwd, timeout: 10_000 });
  const statusDigest = statusProbe.status === 0
    ? createHash('sha256').update(statusProbe.stdout || Buffer.alloc(0)).digest('hex')
    : null;

  const diffProbe = spawnSync('git', ['diff', 'HEAD'], { cwd, timeout: 15_000 });
  const diffDigest = diffProbe.status === 0
    ? createHash('sha256').update(diffProbe.stdout || Buffer.alloc(0)).digest('hex')
    : null;

  const untrackedProbe = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, timeout: 15_000 });
  let untrackedCount = 0;
  let untrackedDigest = null;

  if (untrackedProbe.status === 0) {
    const raw = untrackedProbe.stdout || Buffer.alloc(0);
    const files = raw.toString('utf8').split('\0').filter(Boolean).sort();
    untrackedCount = files.length;

    let hasLargeFile = false;
    for (const file of files) {
      try {
        const s = statSync(join(cwd, file));
        if (s.size > MAX_UNTRACKED_FILE_BYTES) {
          hasLargeFile = true;
          break;
        }
      } catch {
        hasLargeFile = true;
        break;
      }
    }

    if (hasLargeFile) {
      untrackedDigest = null;
    } else if (files.length === 0) {
      untrackedDigest = createHash('sha256').update('').digest('hex');
    } else {
      const hash = createHash('sha256');
      for (const file of files) {
        const s = statSync(join(cwd, file));
        const hashRes = spawnSync('git', ['hash-object', '--no-filters', '--', file], { cwd, encoding: 'utf8', timeout: 5000 });
        const fileHash = hashRes.status === 0 ? hashRes.stdout.trim() : '';
        hash.update(`${file}\0${s.size}\0${fileHash}\0`);
      }
      untrackedDigest = hash.digest('hex');
    }
  }

  const res = {
    head,
    tree,
    statusDigest,
    diffDigest,
    untrackedCount,
    untrackedDigest,
    nonGit: false,
  };
  process.stdout.write(`${JSON.stringify(res)}\n`);
}

function handleSelftest(claudeBin) {
  let claudeVersion = null;
  try {
    const probe = spawnSync(claudeBin, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (probe.status === 0 || probe.stdout) {
      claudeVersion = extractSemverToken(probe.stdout || probe.stderr) || (probe.stdout || '').trim() || null;
    }
  } catch {}

  const res = {
    ok: true,
    node: process.version,
    claudeBin,
    claudeVersion,
  };
  process.stdout.write(`${JSON.stringify(res)}\n`);
}

async function main() {
  const { mode: cliMode, claudeBin: cliClaudeBin } = parseCliArgs(process.argv.slice(2));
  const claudeBin = resolveClaudeBin(cliClaudeBin);

  // If selftest mode requested on CLI, we don't necessarily require stdin JSON
  if (cliMode === 'selftest') {
    handleSelftest(claudeBin);
    return;
  }

  const stdinText = await readAllStdin();
  let request;
  try {
    request = JSON.parse(stdinText);
  } catch {
    process.stderr.write('Invalid JSON request on stdin\n');
    process.exit(64);
  }

  if (request.schema !== 'webmcp-ai-claude-remote-request/1') {
    process.stderr.write('Invalid or unsupported request schema\n');
    process.exit(64);
  }

  const effectiveMode = cliMode || request.mode;
  if (effectiveMode === 'run') {
    await handleRun(request, claudeBin);
  } else if (effectiveMode === 'fingerprint') {
    handleFingerprint(request);
  } else if (effectiveMode === 'selftest') {
    handleSelftest(claudeBin);
  } else {
    process.stderr.write(`Unknown mode: ${effectiveMode}\n`);
    process.exit(64);
  }
}

main().catch((err) => {
  process.stderr.write(`Worker fatal: ${err.message}\n`);
  process.exit(1);
});
