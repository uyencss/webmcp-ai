import { AiCliError } from '../errors.mjs';
import { agyProvider } from './agy.mjs';
import { claudeProvider } from './claude.mjs';
import { codexProvider } from './codex.mjs';

const providers = [agyProvider, claudeProvider, codexProvider];
const byId = new Map(providers.map((provider) => [provider.id, provider]));

export function listProviders() {
  return providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    defaultBin: provider.defaultBin,
    envBin: provider.envBin,
    capabilities: { ...provider.capabilities },
  }));
}

export function getProvider(id) {
  const normalized = String(id || '').trim().toLowerCase();
  const provider = byId.get(normalized);
  if (!provider) {
    throw new AiCliError('UNKNOWN_PROVIDER', `Unknown provider: ${id || '(missing)'}`, {
      exitCode: 2,
      details: { knownProviders: providers.map((entry) => entry.id) },
    });
  }
  return provider;
}

export function resolveProviderBin(provider, env = process.env) {
  return env[provider.envBin] || provider.defaultBin;
}
