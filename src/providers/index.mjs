import { realpathSync } from 'node:fs';

import { AiCliError } from '../errors.mjs';
import { agyProvider } from './agy.mjs';
import { claudeProvider } from './claude.mjs';
import { codexProvider } from './codex.mjs';
import {
  assertOpencodeV2DbReady,
  inspectOpencodeDb,
  opencodeProvider,
  resolveOpencodeCliDb,
} from './opencode.mjs';

export { assertOpencodeV2DbReady, inspectOpencodeDb, resolveOpencodeCliDb };

const providers = [agyProvider, claudeProvider, codexProvider, opencodeProvider];
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
  const command = env[provider.envBin] || provider.defaultBin;
  // Canonicalize absolute binary paths (upstream codex #31831 class): some
  // providers resolve sibling helpers next to the *invocation* path, so
  // spawning through a symlink (e.g. ~/.local/bin/codex -> ChatGPT.app)
  // hides helpers like codex-code-mode-host from the child. Fall back to the
  // unresolved command when it does not exist yet so missing-binary handling
  // (CLI_NOT_INSTALLED) is unchanged. Bare names stay untouched for PATH lookup.
  if (command.includes('/')) {
    try {
      return realpathSync(command);
    } catch {
      return command;
    }
  }
  return command;
}
