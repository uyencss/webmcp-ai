// M2 TypeSafe HTTP transport (bounded, offline-testable).
//
// The key is NEVER read here: callers pass it explicitly. The only wired
// source in M2 is a mode-0600 file whose *content* the caller loads via
// readKeyFile() and passes in as the `apiKey` argument; a vault-broker
// first source is NOT wired (recorded as an M3 open item). `process.env`
// is never consulted for secrets in this module — inherited env is
// rejected as a secret channel. Tests inject `fetchFn`; no real network
// in tests.
import { readFileSync, statSync } from 'node:fs';
import { AiCliError } from '../errors.mjs';
import { canonicalForMatch } from './redact.mjs';

function configMissing(message) {
  return new AiCliError('JEV_CONFIG_MISSING', message, { retryable: false });
}

// OQ2 fallback: read a dedicated binding file. Fail closed unless the file is
// owner-only (mode 0600 — no group/other bits), so a leaked umask cannot turn
// the key world-readable.
export function readKeyFile(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw configMissing('jev key file path must be a non-empty string');
  }
  let stat = null;
  try {
    stat = statSync(path);
  } catch {
    throw configMissing('jev key file is not readable');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw configMissing('jev key file must be owner-only (mode 0600)');
  }
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.length === 0) throw configMissing('jev key file is empty');
  return raw;
}

// A credential-looking baseUrl (userinfo, query, or fragment) would carry
// the key into transport metadata (round 5 S1): the key travels as an
// Authorization header, never in the URL. Reject, do not strip — endpoint
// paths stay untouched and the failure is fail-closed.
export function assertSafeBaseUrl(baseUrl) {
  let parsed = null;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw configMissing('typesafe transport requires baseUrl to be an absolute URL');
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw configMissing('typesafe transport refuses a baseUrl carrying userinfo, query, or fragment');
  }
  return parsed;
}

// The key travels as an Authorization header, never in the URL (round 6
// F5, round 8 N-D): a baseUrl containing the api key in any position —
// userinfo, query, or path, raw or percent-encoded — reaches transport
// metadata, so it is rejected. Even a one-character key may make ordinary
// URLs unusable; failing closed is intentional.
export function assertKeyNotInBaseUrl(baseUrl, apiKey, secrets = []) {
  if (typeof baseUrl !== 'string') return;
  let decoded = '';
  try {
    decoded = decodeURIComponent(baseUrl);
  } catch {
    // Fail closed (round 9 item 3): a decode error is a refused baseUrl,
    // never a clean one — otherwise a stray malformed `%` skips the check
    // and an encoded key gets through.
    throw configMissing('typesafe transport refuses a baseUrl with malformed percent-encoding');
  }
  for (const [index, secret] of [apiKey, ...secrets].entries()) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    const compactSecret = canonicalForMatch(secret);
    const carries = (url) => url.includes(secret)
      || (compactSecret.length > 0 && canonicalForMatch(url).includes(compactSecret));
    if (carries(baseUrl) || (decoded !== baseUrl && carries(decoded))) {
      throw configMissing(index === 0
        ? 'typesafe transport refuses a baseUrl containing the api key'
        : 'typesafe transport refuses a baseUrl containing a secret');
    }
  }
}
// Bounded fetch transport matching the client's injectable transport seam:
// `(payload, { signal, apiKey, baseUrl, model }) => { status, body }`.
// `baseUrl` is the full operator-provided endpoint URL (no path is invented
// here); the redacted request envelope travels as the JSON body with the
// server-side key as the Authorization bearer. Hard timeout aborts the fetch.
export function createTypesafeTransport({ baseUrl, apiKey, timeoutMs = 10_000, fetchFn = null } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw configMissing('typesafe transport requires an explicit baseUrl');
  }
  // The bearer key travels as an Authorization header, so cleartext http is
  // rejected (M2-R7) — loopback stays allowed for local runs. Credential
  // parts are rejected on every construction path (round 5 S1).
  const parsed = assertSafeBaseUrl(baseUrl);
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw configMissing('typesafe transport requires an explicitly supplied apiKey (mode-0600 file content; vault broker is an M3 open item)');
  }
  assertKeyNotInBaseUrl(baseUrl, apiKey);
  if (parsed.protocol !== 'https:') {
    const host = parsed.hostname.toLowerCase();
    // Exact loopback only (round 4 item 7): a 127. prefix check would admit
    // 127.attacker.example, and URL.hostname renders IPv6 loopback as [::1].
    const loopback = host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
    if (!loopback) {
      throw configMissing(`typesafe transport refuses non-https baseUrl ${parsed.protocol}//${parsed.host}`);
    }
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw configMissing('typesafe transport requires timeoutMs to be an integer >= 1');
  }
  const fetchImpl = fetchFn ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw configMissing('no fetch implementation is available for the typesafe transport');

  return async function typesafeTransport(payload, { signal = null } = {}) {
    const ctrl = new AbortController();
    const combined = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await fetchImpl(baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload?.request ?? payload),
        signal: combined,
      });
      const text = await response.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Non-JSON bodies stay strings; mapTransportResponse classifies them.
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  };
}
