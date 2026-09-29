/**
 * Per-model invocation facts that installed provider CLIs do not advertise
 * (effort support, prompt size limits, whether the full answer is written to a
 * provider-owned artifact directory instead of stdout).
 *
 * The table is additive and conservative: it encodes only facts verified on a
 * real run. An unknown model fails open (`supportsEffort: null`) so a newly
 * released model is never blocked by a stale table.
 */

import { MAX_STREAM_PROMPT_BYTES } from './providers/agy.mjs';

const PROVIDER_SURFACE = Object.freeze({
  // Above MAX_PROMPT_ARG_BYTES (128 KiB) AGY moves from the `-p` argv lane to
  // the stream-json lane; MAX_STREAM_PROMPT_BYTES (4 MiB) is the true bound,
  // verified on AGY 1.2.13 via the canary run on 2026-09-29 (large stream-json
  // prompt, exit 0, single result event). Never publish an unbounded (null)
  // AGY prompt cap; both lanes are still bounded.
  agy: { maxPromptBytes: MAX_STREAM_PROMPT_BYTES, artifacts: 'brain-fallback' },
  claude: { maxPromptBytes: null, artifacts: 'inline' },
  codex: { maxPromptBytes: null, artifacts: 'inline' },
  opencode: { maxPromptBytes: null, artifacts: 'inline' },
});

// Provider-level effort closed set, documented in the installed CLI's own
// `--help` output. This is the coarse layer: an effort value outside it fails
// before spawn regardless of model. codex/opencode are deliberately omitted —
// neither CLI documents a closed set, so the per-model MODEL_OVERRIDES table
// below remains the sole authority for those providers.
const PROVIDER_EFFORT = Object.freeze({
  // Verified via `agy --help` (1.2.13, canary 2026-09-29).
  agy: { values: ['low', 'medium', 'high', 'max'] },
  // Verified via `claude --help` (2.1.283).
  claude: { values: ['low', 'medium', 'high', 'xhigh', 'max'] },
});

/**
 * Provider-level effort surface (the coarse layer). Returns null for a
 * provider that documents no closed set (codex, opencode) or is unknown.
 */
export function describeProviderEffort(providerId) {
  const provider = String(providerId || '').trim().toLowerCase();
  return PROVIDER_EFFORT[provider] ?? null;
}

const MODEL_OVERRIDES = Object.freeze({
  'agy:claude-opus-4-6-thinking': {
    supportsEffort: false,
    effortValues: [],
    note: 'AGY rejects --effort for this thinking model; omit it',
  },
  'agy:claude-sonnet-4-6': { supportsEffort: false, effortValues: [] },
  'agy:gemini-3.8-flash-high': { supportsEffort: true, effortValues: ['low', 'medium', 'high'] },
  'opencode:opencode-go/muse-spark-1.3-contributor': {
    supportsEffort: true,
    effortValues: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'xhigh',
  },
  'opencode:openrouter/meta/muse-spark-1.3-contributor': {
    supportsEffort: true,
    effortValues: ['high'],
    note: 'Direct OpenRouter evidence covers high effort only',
  },
  'opencode:opencode-go/deepseek-v4.1-flash': {
    supportsEffort: true,
    effortValues: ['low', 'medium', 'high'],
    defaultEffort: 'high',
  },
  'opencode:9router/glm-5.3-flash': {
    supportsEffort: false,
    effortValues: [],
    note: '9Router DO GLM 5.3 Flash (1M context)',
  },
  'opencode:9router/deepseek-v4-flash-0731': {
    supportsEffort: false,
    effortValues: [],
    note: '9Router DO DeepSeek V4 Flash 0731 (1M context)',
  },
  'opencode:9router/gemini-3.8-flash-high': {
    supportsEffort: true,
    effortValues: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    note: '9Router AG Gemini 3.8 Flash High (1M context)',
  },
  'opencode:9router/claude-opus-4-6-thinking': {
    supportsEffort: false,
    effortValues: [],
    note: '9Router AG Claude Opus 4.6 Thinking',
  },
  'opencode:9router/gpt-5.6-luna': {
    supportsEffort: true,
    effortValues: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    note: '9Router CX GPT-5.6 Luna Max',
  },
  'opencode:9router/gpt-4.1': {
    supportsEffort: false,
    effortValues: [],
    note: '9Router GH GPT-4.1 (1M context)',
  },
  'opencode:9router/gpt-4o': {
    supportsEffort: false,
    effortValues: [],
    note: '9Router GH GPT-4o',
  },
  'opencode:9router/gpt-4o-mini': {
    supportsEffort: false,
    effortValues: [],
    note: '9Router GH GPT-4o Mini',
  },
});

export function describeModel(providerId, modelId) {
  const provider = String(providerId || '').trim().toLowerCase();
  const model = typeof modelId === 'string' && modelId.trim() ? modelId.trim() : null;
  const surface = PROVIDER_SURFACE[provider];
  if (!surface) return null;
  const override = model ? MODEL_OVERRIDES[`${provider}:${model}`] ?? null : null;
  return {
    provider,
    model,
    known: override !== null,
    supportsEffort: override?.supportsEffort ?? null,
    effortValues: override?.effortValues ?? null,
    defaultEffort: override?.defaultEffort ?? null,
    maxPromptBytes: surface.maxPromptBytes,
    artifacts: surface.artifacts,
    note: override?.note ?? null,
  };
}

/**
 * Two-layer effort validation. Layer 1 (model): a model positively known to
 * reject `--effort` (MODEL_OVERRIDES supportsEffort: false) is rejected
 * regardless of the provider's closed set — the model override always wins.
 * Layer 2 (provider): when the model layer does not reject, an effort value
 * outside the provider's own documented closed set (PROVIDER_EFFORT) is
 * rejected, unless a model-level override positively lists that exact value
 * (evidence-based per-model set taking precedence over the coarser provider
 * list). Providers with no documented closed set (codex, opencode) skip
 * layer 2 entirely, so an unknown model there fails open as before.
 * Returns null for an unknown model/allowed value.
 */
export function effortRejection({ providerId, modelId, effort }) {
  if (effort === undefined || effort === null || effort === '') return null;
  const described = describeModel(providerId, modelId);
  if (described && described.supportsEffort === false) {
    return { allowedEfforts: described.effortValues ?? [], note: described.note };
  }
  const providerEffort = describeProviderEffort(providerId);
  if (providerEffort && !providerEffort.values.includes(effort)) {
    const modelOverrideAllows = described
      && described.supportsEffort === true
      && Array.isArray(described.effortValues)
      && described.effortValues.includes(effort);
    if (modelOverrideAllows) return null;
    return { allowedEfforts: providerEffort.values, note: described?.note ?? null };
  }
  return null;
}
