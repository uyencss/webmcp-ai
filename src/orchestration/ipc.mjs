import { createHash, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';

import { AiCliError } from '../errors.mjs';
import { ORCHESTRATION_LIMITS, ORCHESTRATION_PROTOCOL } from './constants.mjs';

export function hashCapability(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function capabilitiesMatch(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(hashCapability(presented));
  const b = Buffer.from(hashCapability(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Machine-local endpoint derivation: short SHA-256 prefix of the Coordination
 * id under the state-root IPC directory (POSIX socket), or the platform
 * named-pipe equivalent on Windows. Never a TCP host/port.
 */
export function deriveEndpoint({ ipcRoot, coordinationId, platform = process.platform }) {
  // Eight hex chars keep the full socket path inside the 104-byte sun_path
  // limit on macOS even under deep temporary test state roots.
  const prefix = createHash('sha256').update(coordinationId).digest('hex').slice(0, 8);
  if (platform === 'win32') {
    return `\\\\.\\pipe\\webmcp-ai-${prefix}`;
  }
  return path.join(ipcRoot, `${prefix}.sock`);
}

function assertTransportOnly(options) {
  if (!options || typeof options !== 'object') {
    throw new AiCliError('POLICY_DENIED', 'IPC server options must be an object');
  }
  if (options.host !== undefined || options.port !== undefined) {
    throw new AiCliError('POLICY_DENIED', 'orchestration IPC forbids TCP hosts/ports; use the local socket endpoint');
  }
  const endpoint = options.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'IPC endpoint is required');
  }
  if (process.platform === 'win32') {
    if (!endpoint.startsWith('\\\\.\\pipe\\webmcp-ai-')) {
      throw new AiCliError('POLICY_DENIED', 'named pipe endpoint must stay in the webmcp-ai namespace');
    }
    return;
  }
  if (!endpoint.endsWith('.sock')) {
    throw new AiCliError('POLICY_DENIED', 'orchestration IPC endpoints must be local .sock sockets');
  }
}

function writeEnvelope(socket, payload) {
  try {
    socket.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // Socket already torn down; nothing durable depends on this write.
  }
}

function errorPayload(protocol, requestId, error) {
  const typed = error instanceof AiCliError
    ? error
    : new AiCliError('ORCHESTRATION_INDETERMINATE', error?.message ?? 'ipc failure');
  return {
    protocol,
    requestId: typeof requestId === 'string' ? requestId : null,
    coordinationId: null,
    ok: false,
    error: typed.toJSON(),
  };
}

/**
 * One newline-terminated request per connection, one response back. The
 * capability never appears in any response.
 */
export function createIpcServer(options) {
  assertTransportOnly(options);
  const maxRequestBytes = options.maxRequestBytes ?? ORCHESTRATION_LIMITS.maxRequestBytes;
  const protocol = options.protocol ?? ORCHESTRATION_PROTOCOL;

  const server = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    let answered = false;

    const fail = (error) => {
      if (answered) {
        socket.destroy();
        return;
      }
      answered = true;
      let envelope = null;
      try {
        envelope = JSON.parse(buffered.toString('utf8').split('\n')[0] || '{}');
      } catch {
        envelope = {};
      }
      writeEnvelope(socket, errorPayload(protocol, envelope.requestId, error));
      socket.end();
      socket.destroy();
    };

    socket.on('data', (chunk) => {
      if (answered) {
        // A second request on one connection violates the transport contract.
        socket.destroy();
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > maxRequestBytes) {
        fail(new AiCliError(
          'ORCHESTRATION_INVALID_INPUT',
          `request frame exceeds the ${maxRequestBytes} byte bound`,
          { exitCode: 2 },
        ));
        return;
      }
      const newlineIndex = buffered.indexOf(0x0a);
      if (newlineIndex === -1) return;

      answered = true;
      socket.pause(); // one request per connection; no further reads
      const line = buffered.subarray(0, newlineIndex).toString('utf8');

      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch {
        writeEnvelope(socket, errorPayload(protocol, null,
          new AiCliError('ORCHESTRATION_INVALID_INPUT', 'request is not valid JSON', { exitCode: 2 })));
        socket.destroy();
        return;
      }

      if (!capabilitiesMatch(envelope.capability, typeof options.capability === 'function'
        ? options.capability(envelope)
        : options.capability)) {
        writeEnvelope(socket, {
          protocol,
          requestId: envelope.requestId ?? null,
          coordinationId: typeof envelope.coordinationId === 'string' ? envelope.coordinationId : null,
          ok: false,
          error: new AiCliError('WORKER_IDENTITY_UNPROVEN', 'coordinator capability unproven').toJSON(),
        });
        socket.destroy();
        return;
      }
      // The matched raw token travels to the handler so per-route contracts
      // (e.g. worker callbacks vs coordinator operations) can re-verify it
      // against their own binding registries.
      const presentedCapability = envelope.capability;
      delete envelope.capability;

      Promise.resolve()
        .then(() => options.handler(envelope, { presentedCapability }))
        .then((result) => {
          writeEnvelope(socket, result);
          socket.end();
          socket.destroy();
        })
        .catch((error) => {
          writeEnvelope(socket, errorPayload(protocol, envelope.requestId, error));
          socket.destroy();
        });
    });

    socket.on('error', () => socket.destroy());
  });

  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(options.endpoint, () => resolveServer({
      endpoint: options.endpoint,
      close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
    }));
  });
}

/** Client side of the one-request protocol. */
export function requestIpc(endpoint, envelope, { timeoutMs = 5000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const socket = net.connect(endpoint);
    const buffered = [];
    let receivedBytes = 0;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(rejectPromise, new AiCliError('ORCHESTRATION_INDETERMINATE', 'orchestration IPC request timed out'));
    }, timeoutMs);
    // Deliberately NOT unref'd: a caller awaiting this request relies on the
    // timeout rejection being delivered; draining the loop first would strand
    // the promise and crash the awaiting owner.
    void timer;

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(envelope)}\n`);
    });
    socket.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > ORCHESTRATION_LIMITS.maxRequestBytes) {
        finish(rejectPromise, new AiCliError('PROVIDER_PROTOCOL_ERROR', 'IPC response frame exceeded the bound'));
        return;
      }
      buffered.push(chunk);
      const text = Buffer.concat(buffered).toString('utf8');
      if (text.includes('\n')) {
        const line = text.slice(0, text.indexOf('\n'));
        try {
          finish(resolvePromise, JSON.parse(line));
        } catch {
          finish(rejectPromise, new AiCliError('PROVIDER_PROTOCOL_ERROR', 'IPC response was not valid JSON'));
        }
      }
    });
    socket.on('error', (error) => finish(rejectPromise, error));
  });
}
