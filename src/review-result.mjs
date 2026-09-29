import { AiCliError } from './errors.mjs';

// Canonical plan contract: schema field (not protocol) carries the version.
// Keep the legacy protocol alias for error details only; validator requires
// `schema` and rejects `protocol`-only payloads as incomplete so callers
// migrate to the exact plan contract.
export const REVIEW_RESULT_SCHEMA = 'webmcp-ai-review-result/1';
export const REVIEW_RESULT_PROTOCOL = REVIEW_RESULT_SCHEMA;

export const REVIEW_VERDICTS = Object.freeze([
  'approve',
  'request-changes',
  'blocked',
  'indeterminate',
]);

export const REVIEW_FINDING_SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);

// Actionable severities reject `approve`. `low` is advisory and may accompany
// `approve`. `info` is not in the frozen plan enum and is rejected as incomplete.

const VERDICT_SET = new Set(REVIEW_VERDICTS);
const SEVERITY_SET = new Set(REVIEW_FINDING_SEVERITIES);

// JSON Schema literal for the frozen webmcp-ai-review-result/1 contract, used
// as the Codex `--output-schema` file for the native reviewTarget lane so the
// model's structured response is constrained at generation time.
// `validateReviewResult` below stays the authoritative runtime validator
// (approve-with-actionable-findings, plan-only detection, alias handling);
// this schema is a generation-time constraint only.
export const REVIEW_RESULT_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'verdict', 'summary'],
  properties: {
    schema: { const: REVIEW_RESULT_SCHEMA },
    verdict: { enum: [...REVIEW_VERDICTS] },
    summary: { type: 'string', minLength: 1 },
    blockedReason: { type: 'string', minLength: 1 },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'severity', 'message', 'recommendation'],
        properties: {
          id: { type: 'string', minLength: 1 },
          severity: { enum: [...REVIEW_FINDING_SEVERITIES] },
          file: { type: 'string', minLength: 1 },
          line: { type: 'integer', minimum: 1 },
          message: { type: 'string', minLength: 1 },
          recommendation: { type: 'string', minLength: 1 },
        },
      },
    },
  },
});

function incomplete(message, details) {
  return new AiCliError('REVIEW_RESULT_INCOMPLETE', message, {
    exitCode: 1,
    details,
  });
}

// Bound for the raw model-text excerpt retained on review-result failures.
// Failures must stay diagnosable without persisting unbounded provider text.
export const REVIEW_RAW_EXCERPT_LIMIT = 2000;

// Leading slice of model text with control characters normalized for safe
// display. The replacement is 1:1, so the result never exceeds `limit`.
export function rawExcerpt(text, limit = REVIEW_RAW_EXCERPT_LIMIT) {
  return String(text ?? '')
    .slice(0, limit)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
}

// Parse strategies, tried in order. The strategy flag is informational only:
// every parsed value still passes the exact same downstream validation.
export const REVIEW_PARSE_STRATEGIES = Object.freeze(['strict', 'fenced', 'embedded']);

// A single ``` or ```json fence wrapping a JSON value; leading/trailing
// whitespace around the whole block is allowed.
const FENCED_JSON_RE = /^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\s*```\s*$/;

// First balanced `{...}` substring, with a string- and escape-aware brace
// scan. Returns null when there is no balanced object. Never extracts an
// object nested inside an array literal, so `[{...}]` stays a validation
// failure instead of silently becoming its first element.
function firstBalancedObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  if (text.slice(0, start).trimEnd().endsWith('[')) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function tryParseJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { ok: false, value: null, trimmed, strategy: 'none' };
  try {
    return { ok: true, value: JSON.parse(trimmed), trimmed, strategy: 'strict' };
  } catch {
    // Cosmetic wrapping only; semantic validation downstream is unchanged.
  }
  const fence = trimmed.match(FENCED_JSON_RE);
  if (fence) {
    try {
      return { ok: true, value: JSON.parse(fence[1].trim()), trimmed, strategy: 'fenced' };
    } catch {
      // Fall through to the embedded-object scan.
    }
  }
  const embedded = firstBalancedObject(trimmed);
  if (embedded) {
    try {
      return { ok: true, value: JSON.parse(embedded), trimmed, strategy: 'embedded' };
    } catch {
      // Unparseable even after extraction: malformed-json below.
    }
  }
  return { ok: false, value: null, trimmed, strategy: 'none' };
}

function looksPlanOnly(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if ('verdict' in value) return false;
  if ('schema' in value && typeof value.schema === 'string' && value.schema.includes('plan-result')) return true;
  const keys = Object.keys(value);
  return keys.includes('plan') || keys.includes('steps') || value.agent === 'plan';
}

function validateFinding(finding, index) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    throw incomplete(`Review finding[${index}] must be an object`, {
      schema: REVIEW_RESULT_SCHEMA,
      reason: 'malformed-finding',
    });
  }
  const id = finding.id;
  if (typeof id !== 'string' || !id.trim()) {
    throw incomplete(`Review finding[${index}].id must be a non-empty string`, {
      schema: REVIEW_RESULT_SCHEMA,
      reason: 'missing-finding-id',
    });
  }
  const severity = finding.severity;
  if (typeof severity !== 'string' || !SEVERITY_SET.has(severity.trim())) {
    throw incomplete(`Review finding[${index}].severity must be one of ${REVIEW_FINDING_SEVERITIES.join('|')}`, {
      schema: REVIEW_RESULT_SCHEMA,
      reason: 'invalid-finding-severity',
    });
  }
  // Canonical `message`; accept legacy `summary` only as a fallback when
  // `message` is absent. When both are present the canonical field wins so no
  // canonical content is silently discarded.
  const rawMessage = finding.message ?? finding.summary ?? null;
  if (typeof rawMessage !== 'string' || !rawMessage.trim()) {
    throw incomplete(`Review finding[${index}].message must be a non-empty string`, {
      schema: REVIEW_RESULT_SCHEMA,
      reason: 'missing-finding-message',
    });
  }
  const recommendation = finding.recommendation;
  if (typeof recommendation !== 'string' || !recommendation.trim()) {
    throw incomplete(`Review finding[${index}].recommendation must be a non-empty string`, {
      schema: REVIEW_RESULT_SCHEMA,
      reason: 'missing-finding-recommendation',
    });
  }
  // Canonical `file`; accept legacy `path` only as a fallback when `file` is
  // absent. file/line are optional only for architectural findings (no
  // source-local anchor). A `line` without `file` is malformed.
  const rawFile = finding.file ?? finding.path ?? null;
  let file = null;
  if (rawFile !== undefined && rawFile !== null) {
    if (typeof rawFile !== 'string' || !rawFile.trim()) {
      throw incomplete(`Review finding[${index}].file must be a non-empty string`, {
        schema: REVIEW_RESULT_SCHEMA,
        reason: 'malformed-finding-file',
      });
    }
    file = rawFile.trim();
  }
  let line = null;
  if (finding.line !== undefined && finding.line !== null) {
    const n = finding.line;
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
      throw incomplete(`Review finding[${index}].line must be a positive integer`, {
        schema: REVIEW_RESULT_SCHEMA,
        reason: 'malformed-finding-line',
      });
    }
    if (file === null) {
      throw incomplete(`Review finding[${index}].line requires file`, {
        schema: REVIEW_RESULT_SCHEMA,
        reason: 'line-without-file',
      });
    }
    line = n;
  }
  return {
    id: id.trim(),
    severity: severity.trim(),
    message: rawMessage.trim(),
    recommendation: recommendation.trim(),
    ...(file !== null ? { file } : {}),
    ...(line !== null ? { line } : {}),
  };
}

/**
 * Validate a provider review response against webmcp-ai-review-result/1.
 *
 * Frozen plan contract (plan-task-intent-and-review-profiles.md §6):
 * `{schema,verdict,summary,findings,blockedReason}` with finding fields
 * `{id,severity,file,line,message,recommendation}`. `severity` is
 * `critical|high|medium|low` (`info` is not in the enum). `file`/`line` are
 * optional only for architectural findings. Safe aliases (`summary` for
 * `message`, `path` for `file`) apply only as fallbacks and never discard
 * canonical fields.
 *
 * Rules:
 * - `schema` must equal the canonical value (missing/mismatch -> incomplete).
 * - `verdict` must be approve|request-changes|blocked|indeterminate.
 * - `summary` must be a non-empty string.
 * - `blocked` requires non-empty `blockedReason`.
 * - `findings`, when present, must be an array of canonical findings.
 * - `approve` must not carry actionable findings (critical/high/medium).
 * - plan-only objects (plan/steps/agent:plan, plan-result schema) are
 *   incomplete, never silently validated as review.
 */
export function validateReviewResult(input) {
  let value = input;
  // Retain a bounded excerpt of the model text on every failure below so
  // REVIEW_RESULT_INCOMPLETE stays diagnosable. Object inputs carry no text.
  const excerpt = typeof input === 'string' ? rawExcerpt(input) : null;
  const withExcerpt = (details) => (excerpt === null ? details : { ...details, rawExcerpt: excerpt });
  if (typeof input === 'string') {
    const parsed = tryParseJson(input);
    if (!parsed.ok) {
      throw incomplete('Review result is not valid JSON', withExcerpt({
        schema: REVIEW_RESULT_SCHEMA,
        reason: 'malformed-json',
      }));
    }
    value = parsed.value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw incomplete('Review result must be a JSON object', withExcerpt({
      schema: REVIEW_RESULT_SCHEMA,
      reason: 'malformed-result',
    }));
  }
  if (looksPlanOnly(value)) {
    throw incomplete('Review result is plan-only output without a verdict', withExcerpt({
      schema: REVIEW_RESULT_SCHEMA,
      reason: 'plan-only',
    }));
  }
  const schema = value.schema;
  if (typeof schema !== 'string' || schema.trim() !== REVIEW_RESULT_SCHEMA) {
    const reason = schema === undefined || schema === null || schema === '' ? 'missing-schema' : 'schema-mismatch';
    throw incomplete(`Review result schema must be ${REVIEW_RESULT_SCHEMA}`, withExcerpt({
      schema: REVIEW_RESULT_SCHEMA,
      reason,
    }));
  }
  const verdict = value.verdict;
  if (typeof verdict !== 'string' || !VERDICT_SET.has(verdict.trim())) {
    const reason = verdict === undefined || verdict === null || verdict === '' ? 'missing-verdict' : 'invalid-verdict';
    throw incomplete(`Review result verdict must be one of ${REVIEW_VERDICTS.join('|')}`, withExcerpt({
      schema: REVIEW_RESULT_SCHEMA,
      reason,
    }));
  }
  const normalizedVerdict = verdict.trim();
  const summary = value.summary ?? null;
  if (typeof summary !== 'string' || !summary.trim()) {
    throw incomplete('Review result summary must be a non-empty string', withExcerpt({
      schema: REVIEW_RESULT_SCHEMA,
      reason: 'missing-summary',
    }));
  }
  let blockedReason = null;
  if (normalizedVerdict === 'blocked') {
    blockedReason = value.blockedReason ?? null;
    if (typeof blockedReason !== 'string' || !blockedReason.trim()) {
      throw incomplete('Review result blocked verdict requires non-empty blockedReason', withExcerpt({
        schema: REVIEW_RESULT_SCHEMA,
        reason: 'missing-blockedReason',
      }));
    }
    blockedReason = blockedReason.trim();
  }
  let findings = null;
  if (value.findings !== undefined && value.findings !== null) {
    if (!Array.isArray(value.findings)) {
      throw incomplete('Review result findings must be an array', withExcerpt({
        schema: REVIEW_RESULT_SCHEMA,
        reason: 'malformed-findings',
      }));
    }
    try {
      findings = value.findings.map((f, i) => validateFinding(f, i));
    } catch (error) {
      if (
        error?.code === 'REVIEW_RESULT_INCOMPLETE'
        && excerpt !== null
        && error.details
        && !('rawExcerpt' in error.details)
      ) {
        error.details = { ...error.details, rawExcerpt: excerpt };
      }
      throw error;
    }
  }
  if (normalizedVerdict === 'approve' && findings && findings.some((f) => f.severity === 'critical' || f.severity === 'high' || f.severity === 'medium')) {
    throw incomplete('Review result approve must not carry actionable findings (critical/high/medium)', withExcerpt({
      schema: REVIEW_RESULT_SCHEMA,
      reason: 'approve-with-actionable-findings',
    }));
  }
  return {
    schema: REVIEW_RESULT_SCHEMA,
    protocol: REVIEW_RESULT_SCHEMA,
    verdict: normalizedVerdict,
    summary: summary.trim(),
    ...(blockedReason !== null ? { blockedReason } : {}),
    findings,
    raw: value,
  };
}

/**
 * Parse provider envelope output into a review result. `text` is the
 * provider response text, `structured` is the optional parsed structured
 * payload (when the provider adapter already JSON-parsed it).
 */
export function parseReviewOutput({ text = null, structured = null } = {}) {
  if (structured !== null && structured !== undefined && typeof structured === 'object' && !Array.isArray(structured)) {
    return validateReviewResult(structured);
  }
  return validateReviewResult(text ?? '');
}
