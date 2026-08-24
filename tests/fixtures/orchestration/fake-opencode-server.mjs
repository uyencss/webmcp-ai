#!/usr/bin/env node
// Fake OpenCode CLI + server used only by fixture tests. It implements the
// documented HTTP/SSE surface subset with Basic Auth enforcement and records
// the exact OPENCODE_DB it was launched with so tests can prove database
// topology without any provider login or network access.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createReadStream } from 'node:fs';

const REQ_LOG = process.env.WEBMCP_FAKE_REQ_LOG ?? null;
function logRequest(label) {
  if (!REQ_LOG) return;
  try { appendFileSync(REQ_LOG, `${label}\n`); } catch { /* best effort */ }
}

if (process.env.WEBMCP_FAKE_IGNORE_SIGTERM === '1' && process.argv[2] !== 'db' && process.argv[2] !== '--version') {
  process.on('SIGTERM', () => {
    logRequest('sigterm-trapped');
    // Trapped: keep serving; only SIGKILL can stop this fixture now.
  });
}

const mode = process.argv[2];

if (mode === '--version') {
  process.stdout.write('1.18.21\n');
  process.exit(0);
}

if (mode === 'db') {
  if (process.argv[3] === 'path' && process.argv.includes('--pure')) {
    // Echo the effective database exactly like the real pure probe.
    // WEBMCP_FAKE_DB_ECHO simulates a lying/substituted probe answer.
    process.stdout.write(`${process.env.WEBMCP_FAKE_DB_ECHO ?? process.env.OPENCODE_DB ?? ''}\n`);
    process.exit(0);
  }
  process.stderr.write('unsupported db invocation\n');
  process.exit(1);
}

if (mode === 'debug' && process.argv[3] === 'config') {
  const config = {
    share: process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).share : 'unknown',
    disable_project_config: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null,
    pure: process.env.OPENCODE_PURE ?? null,
    db: process.env.OPENCODE_DB ?? null,
  };
  process.stdout.write(`${JSON.stringify(config)}\n`);
  process.exit(0);
}

if (mode === 'serve' || mode === '--http-server') {
  if (process.env.WEBMCP_FAKE_SYMLINK_DB === '1') {
    // Simulate a post-prepare path-substitution attack: swap the binding
    // directory for a symlink to a sibling real directory.
    const dbDir = dirname(process.env.OPENCODE_DB);
    const substituted = `${dbDir}-substituted`;
    mkdirSync(substituted, { recursive: true, mode: 0o700 });
    renameSync(dbDir, join(substituted, 'contents'));
    symlinkSync(join(substituted, 'contents'), dbDir, 'dir');
  }
  // The actual start happens after the constants below are initialized.
  setImmediate(startHttpServer);
}

function sessionsFile() {
  const dbDir = dirname(process.env.OPENCODE_DB ?? join(process.cwd(), 'opencode.db'));
  return join(dbDir, 'sessions.json');
}

function loadSessions() {
  try {
    return JSON.parse(readFileSync(sessionsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveSessions(sessions) {
  const file = sessionsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(sessions, null, 1)}\n`, { mode: 0o600 });
}

const PORT = Number(process.env.WEBMCP_FAKE_PORT ?? 0);
const PASSWORD = process.env.WEBMCP_FAKE_SERVER_PASSWORD ?? '';
const STREAM_FILE = process.env.WEBMCP_FAKE_STREAM_FILE;
const HOSTILE_SENTINEL = process.env.WEBMCP_FAKE_SENTINEL;

let sseClients = [];
function broadcast(event) {
  for (const client of [...sseClients]) {
    client.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function broadcastStream(sessionId) {
  if (!STREAM_FILE || !existsSync(STREAM_FILE)) return;
  const lines = readFileSync(STREAM_FILE, 'utf8').split('\n').filter(Boolean);
  let index = 0;
  const timer = setInterval(() => {
    if (index >= lines.length) {
      clearInterval(timer);
      return;
    }
    try {
      broadcast(JSON.parse(lines[index]));
    } catch {
      // Skip malformed fixture lines defensively.
    }
    index += 1;
  }, 5);
  void sessionId;
}

function startHttpServer() {
  const server = createServer((req, res) => {
  const auth = req.headers.authorization ?? '';
  if (auth !== `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const sessions = loadSessions();

  if (req.method === 'GET' && url.pathname === '/global/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: '1.18.21',
      openCodeDb: process.env.OPENCODE_DB,
      openCodePure: process.env.OPENCODE_PURE ?? null,
      disableProjectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null,
      configContentShare: process.env.OPENCODE_CONFIG_CONTENT
        ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).share
        : null,
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/session') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      const sessionId = parsed.sessionIdOverride ?? `ses_${Date.now().toString(36)}`;
      sessions[sessionId] = { sessionId, status: 'idle', messages: [], aborted: false };
      saveSessions(sessions);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: sessionId }));
    });
    return;
  }

  const sessionMatch = url.pathname.match(/^\/session\/([^/]+)(\/.*)?$/);
  if (req.method === 'GET' && url.pathname === '/event') {
    logRequest('/event');
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.push(res);
    req.on('close', () => {
      sseClients = sseClients.filter((client) => client !== res);
    });
    return;
  }
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const rest = sessionMatch[2] ?? '';
    const session = sessions[sessionId];

    if (req.method === 'GET' && rest === '') {
      res.writeHead(session ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(session ?? { error: 'not found' }));
      return;
    }
    if (req.method === 'GET' && rest === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: session?.status ?? 'unknown' }));
      return;
    }
    if (req.method === 'GET' && rest === '/message') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messages: session?.messages ?? [] }));
      return;
    }
    if (req.method === 'GET' && rest === '/diff') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ files: [] }));
      return;
    }
    if (req.method === 'GET' && rest === '/todo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ todos: [] }));
      return;
    }
    if (req.method === 'DELETE' && rest === '') {
      delete sessions[sessionId];
      saveSessions(sessions);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && rest === '/abort') {
      if (!session) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      session.status = 'aborted';
      session.aborted = true;
      saveSessions(sessions);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && rest.startsWith('/permissions/')) {
      if (!session) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        session.lastPermissionResponse = body || '"allow"';
        saveSessions(sessions);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (req.method === 'POST' && rest === '/prompt_async') {
      logRequest('/prompt_async');
      if (!session) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      session.status = 'busy';
      saveSessions(sessions);
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: true }));
      // Replay the fixture NDJSON stream over SSE shortly after acceptance.
      setTimeout(() => {
        broadcastStream(sessionId);
      }, 30);
      return;
    }
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(PORT, '127.0.0.1', () => {
    const address = server.address();
    // WEBMCP_FAKE_READY_LINE lets tests simulate hostile ready dialects
    // (foreign port / non-loopback host) exactly as a compromised binary.
    if (process.env.WEBMCP_FAKE_READY_LINE) {
      process.stdout.write(`${process.env.WEBMCP_FAKE_READY_LINE.replace(/\n$/, '')}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({ ready: true, port: address.port })}\n`);
  });
}
