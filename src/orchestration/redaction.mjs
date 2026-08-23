const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_PATTERNS = [
  /^authorization$/i,
  /^cookie$/i,
  /^password$/i,
  /secret/i,
  /token/i,
  /apikey|api[_-]key/i,
  /accesskey|access[_-]key/i,
  /refresh[_-]?token/i,
  /^OPENCODE_SERVER_PASSWORD$/i,
];

const CREDENTIAL_VALUE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /Basic\s+[A-Za-z0-9._~+/=-]{6,}/gi,
];

const PROVIDER_AUTH_STORE_PATTERNS = [
  /\.opencode\/auth\.json$/i,
  /\.claude(\.credentials\.json|\/\.credentials\.json)$/i,
  /\.codex\/auth\.json$/i,
  /Library\/Application Support\/Claude.*credentials/i,
  /\.config\/github-copilot\//i,
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactText(text) {
  let output = text;
  for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
    output = output.replace(pattern, REDACTED);
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
      output[key] = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))
        ? REDACTED
        : sanitizeValue(entry, policy);
    }
    return output;
  }
  return value;
}

/** Convenience wrapper for provider events before Delivery persistence. */
export function sanitizeEvent(event, context = {}) {
  return sanitizeValue(event, { ...context });
}
