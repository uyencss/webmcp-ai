/**
 * Per-model invocation facts that installed provider CLIs do not advertise
 * (effort support, prompt size limits, whether the full answer is written to a
 * provider-owned artifact directory instead of stdout).
 *
 * The table is additive and conservative: it encodes only facts verified on a
 * real run. An unknown model fails open (`supportsEffort: null`) so a newly
 * released model is never blocked by a stale table.
 */

import { MAX_PROMPT_ARG_BYTES } from './providers/agy.mjs';

const PROVIDER_SURFACE = Object.freeze({
  agy: { maxPromptBytes: MAX_PROMPT_ARG_BYTES, artifacts: 'brain-fallback' },
  claude: { maxPromptBytes: null, artifacts: 'inline' },
  codex: { maxPromptBytes: null, artifacts: 'inline' },
  opencode: { maxPromptBytes: null, artifacts: 'inline' },
});

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
 * Returns rejection details when a model is positively known to reject
 * `--effort`; returns null for an unknown model or a model that accepts it.
 */
export function effortRejection({ providerId, modelId, effort }) {
  if (effort === undefined || effort === null || effort === '') return null;
  const described = describeModel(providerId, modelId);
  if (!described || described.supportsEffort !== false) return null;
  return { allowedEfforts: described.effortValues ?? [], note: described.note };
}
