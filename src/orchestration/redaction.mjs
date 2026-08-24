import { createHash } from 'node:crypto';

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_PATTERNS = [
  /^authorization$/i,
  /^cookie$/i,
  /^cookies$/i,
  /password/i,
  /^passwd$/i,
  /^passphrase$/i,
  /^private[_-]?key$/i,
  /^session[_-]?cookie$/i,
  /^auth[_-]?file$/i,
  /^credentials?$/i,
  /secret/i,
  /token/i,
  /apikey|api[_-]key/i,
  /accesskey|access[_-]key/i,
  /refresh[_-]?token/i,
  /^OPENCODE_SERVER_PASSWORD$/i,
];

const PROVIDER_AUTH_STORE_PATTERNS = [
  /\.opencode\/auth\.json$/i,
  /\.claude(\.credentials\.json|\/\.credentials\.json)$/i,
  /\.codex\/auth\.json$/i,
  /Library\/Application Support\/Claude[^\s"'`]*credentials/i,
  /\.config\/github-copilot\//i,
  /\.ssh\/id_(rsa|ed25519|ecdsa)/i,
  /\.aws\/credentials/i,
  /\.netrc$/i,
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function digestOfText(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// URL userinfo: scheme://user:password@host — evaluated only inside a small
// window after each literal "://" so arbitrarily large non-URL strings stay
// linear-time (no catastrophic backtracking).
const USERINFO_WINDOW_RE = /^([^\s/:@]+):([^\s/@]+)@/;
const SCHEME_RE = /[a-z][a-z0-9+.-]{2,31}:\/\//gi;
const QUERY_PARAM_RE = /([?&])(token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|secret|password|signature|sig|credential[a-z_]*)(=)[^&\s"']+/gi;

function redactText(text) {
  let output = text;
  // Bearer/Basic credential prose (linear scan; classes exclude spaces).
  if (/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/i.test(output)) {
    output = output.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, REDACTED);
  }
  if (output.includes('://')) {
    let result = '';
    let last = 0;
    SCHEME_RE.lastIndex = 0;
    let match;
    while ((match = SCHEME_RE.exec(output)) !== null) {
      const schemeEnd = match.index + match[0].length;
      const credentials = output.slice(schemeEnd, schemeEnd + 1024).match(USERINFO_WINDOW_RE);
      if (credentials) {
        result += output.slice(last, match.index) + match[0] + `${REDACTED}@`;
        last = schemeEnd + credentials[0].length;
        SCHEME_RE.lastIndex = last;
      }
    }
    result += output.slice(last);
    output = result;
  }
  if (output.includes('?') || output.includes('&')) {
    // Token-like query parameters — keep the parameter name visible.
    output = output.replace(QUERY_PARAM_RE, `$1$2=${REDACTED}`);
  }
  return output;
}

/**
 * Recursive fail-safe sanitizer applied before any persistence. Sensitive keys
 * become "[REDACTED]" with no length preservation; reasoning content is
 * dropped entirely, never masked.
 */
export function sanitizeValue(value, policy = {}) {
  if (typeof value === 'string') {
    const trimmed = value;
    if (policy.dropReasoningKeys && policy.isReasoningKey) return trimmed;
    if (PROVIDER_AUTH_STORE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      return REDACTED;
    }
    return redactText(trimmed);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, policy));
  }
  if (isPlainObject(value)) {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/reasoning|chain[-_ ]?of[-_ ]?thought|thinking/i.test(key)) {
        // Reasoning content is dropped, not masked.
        continue;
      }
      if (SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
        // Only textual values can carry credential material; numbers/booleans
        // such as token counts pass through untouched.
        output[key] = typeof entry === 'string' ? REDACTED : entry;
        continue;
      }
      output[key] = sanitizeValue(entry, policy);
    }
    return output;
  }
  return value;
}

/** Convenience wrapper for provider events before Delivery persistence. */
export function sanitizeEvent(event, context = {}) {
  return sanitizeValue(event, { ...context });
}

/**
 * Explicit, deterministic text bounding. Oversized values truncate at a byte
 * budget and carry an auditable marker: original size + sha256 digest.
 */
export function boundText(text, { maxBytes = 2_000, label = 'text' } = {}) {
  const originalBytes = Buffer.byteLength(String(text), 'utf8');
  if (originalBytes <= maxBytes) {
    return { text: String(text), truncated: false, originalBytes, digest: digestOfText(text) };
  }
  let sliced = String(text);
  // Slice by characters until under the byte budget (UTF-8 safe enough for a
  // preview; the digest above covers the exact original bytes).
  sliced = sliced.slice(0, maxBytes);
  while (Buffer.byteLength(sliced, 'utf8') > maxBytes) sliced = sliced.slice(0, Math.floor(sliced.length / 2));
  const digest = digestOfText(text);
  const marker = `\n[TRUNCATED ${label} originalBytes=${originalBytes} sha256=${digest}]`;
  return { text: `${sliced}${marker}`, truncated: true, originalBytes, digest };
}

/**
 * Payload-level bound for ingress points that cannot spill to refs: oversized
 * values collapse into a small truncation envelope carrying original size and
 * digest. Under-limit payloads pass through completely unchanged.
 */
export function boundPayload(value, { maxBytes = 64 * 1024 } = {}) {
  let serialized;
  try {
    serialized = JSON.stringify(value) ?? 'null';
  } catch {
    serialized = '"unserializable"';
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= maxBytes) return value;
  return Object.freeze({
    truncated: true,
    originalBytes: bytes,
    digest: digestOfText(serialized),
    preview: boundText(serialized.slice(0, 1_024), { maxBytes: 512, label: 'payload-preview' }).text,
  });
}

/**
 * Allowlist for persisted environment metadata. The complete child environment
 * is NEVER persisted: only explicitly allowed, non-secret variables survive.
 */
export const ENV_METADATA_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'SHELL',
  'XDG_DATA_HOME',
]);

export function sanitizeEnvironmentMetadata(env, { allowKeys = ENV_METADATA_ALLOWLIST } = {}) {
  const output = {};
  if (!isPlainObject(env)) return output;
  for (const key of allowKeys) {
    const value = env[key];
    if (typeof value === 'string') output[key] = value;
  }
  return output;
}
