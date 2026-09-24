// Rollout config resolution and strict validation for WebMCP Jev policy (M6 Phase B Part 2).
// Runner source commit: aae9d8ed0d5ebea199f13650f4113c07b58917da
// Promoted policy.mjs sha256: d792835e2468b80811e87d31014e33a52aeccfd543885cc1b8698481452fefe3
// Source runner policy.mjs sha256: 6f6148601d17ae113456c60da5d727562ab59be8c03739ff85aa0df9e96a2814
// ai-cli-local rollout source only; installation/ and M3-owned profiles are OFF-LIMITS.

import { readFileSync } from 'node:fs';
import { AiCliError } from '../../errors.mjs';
import { CAPABILITIES } from './policy.mjs';

const ORIGIN_RE = /^https?:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?$/;
const COHORT_ENVIRONMENTS = new Set(['local', 'test', 'production', 'staging']);
const COHORT_PERCENTS = new Set([5, 25]);
const TOP_LEVEL_ACCEPTED_KEYS = new Set(['flags', 'cohort', 'schema']);
const FLAGS_ACCEPTED_KEYS = new Set(['enabled', 'killSwitch', 'capabilities', 'origins']);
const COHORT_ACCEPTED_KEYS = new Set(['key', 'config', 'environment', 'percent', 'authorizationId']);
const COHORT_CONFIG_ACCEPTED_KEYS = new Set(['environment', 'percent', 'authorizationId']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configInvalid(message, details = undefined) {
  return new AiCliError('JEV_CONFIG_INVALID', message, { exitCode: 1, retryable: false, details });
}

function validateOrigins(origins) {
  if (!isPlainObject(origins)) {
    throw configInvalid('flags.origins must be a plain object');
  }
  for (const [key, val] of Object.entries(origins)) {
    if (typeof key !== 'string' || key.length === 0 || key.includes('?') || key.includes('#') || key.includes('@') || /\s$/.test(key) || !ORIGIN_RE.test(key)) {
      throw configInvalid(`flags.origins contains invalid origin key '${key}'`, { origin: key });
    }
    if (typeof val !== 'boolean') {
      throw configInvalid(`flags.origins['${key}'] must be a boolean`, { origin: key });
    }
  }
}

function validateCapabilities(capabilities) {
  if (!isPlainObject(capabilities)) {
    throw configInvalid('flags.capabilities must be a plain object');
  }
  for (const [key, val] of Object.entries(capabilities)) {
    if (!CAPABILITIES.includes(key)) {
      throw configInvalid(`flags.capabilities contains unknown capability '${key}'`, { capability: key });
    }
    if (typeof val !== 'boolean') {
      throw configInvalid(`flags.capabilities['${key}'] must be a boolean`, { capability: key });
    }
  }
}

function validateCohort(cohort) {
  if (!isPlainObject(cohort)) {
    throw configInvalid('cohort must be a plain object');
  }
  for (const key of Object.keys(cohort)) {
    if (!COHORT_ACCEPTED_KEYS.has(key)) {
      throw configInvalid(`Unrecognized key '${key}' in cohort`, { key });
    }
  }

  let key = undefined;
  if (cohort.key !== undefined) {
    if (typeof cohort.key !== 'string' || cohort.key.length === 0) {
      throw configInvalid('cohort.key must be a non-empty string');
    }
    key = cohort.key;
  }

  let config = undefined;
  if (cohort.config !== undefined) {
    if (!isPlainObject(cohort.config)) {
      throw configInvalid('cohort.config must be a plain object');
    }
    for (const k of Object.keys(cohort.config)) {
      if (!COHORT_CONFIG_ACCEPTED_KEYS.has(k)) {
        throw configInvalid(`Unrecognized key '${k}' in cohort.config`, { key: k });
      }
    }
    config = { ...cohort.config };
  } else {
    // Flat cohort config check
    const flatEnv = cohort.environment;
    const flatPct = cohort.percent;
    const flatAuth = cohort.authorizationId;
    if (flatEnv !== undefined || flatPct !== undefined || flatAuth !== undefined) {
      config = {
        ...(flatEnv !== undefined ? { environment: flatEnv } : {}),
        ...(flatPct !== undefined ? { percent: flatPct } : {}),
        ...(flatAuth !== undefined ? { authorizationId: flatAuth } : {}),
      };
    }
  }

  if (config) {
    if (config.environment !== undefined && !COHORT_ENVIRONMENTS.has(config.environment)) {
      throw configInvalid('cohort environment must be local, test, production, or staging', { environment: config.environment });
    }
    if (config.percent !== undefined && !COHORT_PERCENTS.has(config.percent)) {
      throw configInvalid('cohort percent must be 5 or 25', { percent: config.percent });
    }
    if (config.authorizationId !== undefined && config.authorizationId !== null && typeof config.authorizationId !== 'string') {
      throw configInvalid('cohort authorizationId must be a string or null');
    }
  }

  return {
    ...(key !== undefined ? { key } : {}),
    ...(config ? { config: Object.freeze(config) } : {}),
  };
}

function validateFlags(flags) {
  if (!isPlainObject(flags)) {
    throw configInvalid('flags must be a plain object');
  }
  for (const key of Object.keys(flags)) {
    if (!FLAGS_ACCEPTED_KEYS.has(key)) {
      throw configInvalid(`Unrecognized flag '${key}' in rollout config`, { key });
    }
  }
  if (flags.enabled !== undefined && typeof flags.enabled !== 'boolean') {
    throw configInvalid('flags.enabled must be a boolean');
  }
  if (flags.killSwitch !== undefined && typeof flags.killSwitch !== 'boolean') {
    throw configInvalid('flags.killSwitch must be a boolean');
  }
  if (flags.capabilities !== undefined) {
    validateCapabilities(flags.capabilities);
  }
  if (flags.origins !== undefined) {
    validateOrigins(flags.origins);
  }
}

export function parseRolloutConfigFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw configInvalid(`cannot read rollout config file: ${err.message}`, { path, cause: err.message });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configInvalid('rollout config file contains malformed or unparseable JSON', { path });
  }

  if (!isPlainObject(parsed)) {
    throw configInvalid('rollout config must be a JSON object', { path });
  }

  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_ACCEPTED_KEYS.has(key)) {
      throw configInvalid(`Unrecognized top-level key '${key}' in rollout config`, { key, path });
    }
  }

  if (parsed.flags !== undefined) {
    validateFlags(parsed.flags);
  }

  let validatedCohort = undefined;
  if (parsed.cohort !== undefined) {
    validatedCohort = validateCohort(parsed.cohort);
  }

  return {
    flags: parsed.flags,
    cohort: validatedCohort,
  };
}

export function resolveRolloutConfig({ env = process.env, configPath = undefined } = {}) {
  const filePath = configPath ?? (typeof env?.JEV_ROLLOUT_CONFIG === 'string' && env.JEV_ROLLOUT_CONFIG.trim().length > 0 ? env.JEV_ROLLOUT_CONFIG.trim() : null);

  let fileConfig = null;
  if (filePath) {
    fileConfig = parseRolloutConfigFile(filePath);
  }

  // Baseline defaults: enabled, capabilities absent, origins absent, cohort absent
  let enabled = true;
  let killSwitch = false;
  let capabilities = undefined;
  let origins = undefined;
  let cohort = null;

  if (fileConfig?.flags) {
    if (fileConfig.flags.enabled !== undefined) {
      enabled = fileConfig.flags.enabled;
    }
    if (fileConfig.flags.killSwitch !== undefined) {
      killSwitch = fileConfig.flags.killSwitch;
    }
    if (fileConfig.flags.capabilities !== undefined) {
      capabilities = Object.freeze({ ...fileConfig.flags.capabilities });
    }
    if (fileConfig.flags.origins !== undefined) {
      origins = Object.freeze({ ...fileConfig.flags.origins });
    }
  }

  if (fileConfig?.cohort) {
    cohort = Object.freeze(fileConfig.cohort);
  }

  // Precedence: explicit JSON file at $JEV_ROLLOUT_CONFIG (absent = defaults),
  // then the two existing env vars (JEV_FAST_PATH_DISABLED, JEV_ENABLED) for kill-switch/enabled only.
  // If file omitted killSwitch, consult JEV_FAST_PATH_DISABLED
  if (!fileConfig || fileConfig.flags?.killSwitch === undefined) {
    if (env?.JEV_FAST_PATH_DISABLED !== undefined) {
      const v = env.JEV_FAST_PATH_DISABLED;
      killSwitch = v === '1' || v === 'true' || (Boolean(v) && v !== '0' && v !== 'false');
    }
  }

  // If file omitted enabled, consult JEV_ENABLED
  if (!fileConfig || fileConfig.flags?.enabled === undefined) {
    if (env?.JEV_ENABLED !== undefined) {
      const v = env.JEV_ENABLED;
      enabled = !(v === 'false' || v === '0');
    }
  }

  const flags = Object.freeze({
    enabled,
    killSwitch,
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(origins !== undefined ? { origins } : {}),
  });

  return { flags, cohort };
}
