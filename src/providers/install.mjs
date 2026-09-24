import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { buildSafeChildEnv } from '../capabilities.mjs';
import { AiCliError } from '../errors.mjs';
import { runProcess } from '../process-runner.mjs';
import { getProvider, resolveProviderBin } from './index.mjs';
import {
  inspectOpencodeDb,
  opencodeProfileForVersion,
  parseOpencodeVersion,
  resolveOpencodeCliDb,
} from './opencode.mjs';

function extractVersion(id, output) {
  const text = String(output ?? '');
  if (id === 'opencode') {
    const parsed = parseOpencodeVersion(text);
    if (parsed?.raw) return parsed.raw;
  }
  const match = text.match(/\b\d+\.\d+\.\d+[-\w.]*\b/);
  return match ? match[0] : null;
}

const localClaude = Object.freeze({
  id: 'claude',
  bin: 'claude',
  env: 'CLAUDE_BIN',
  version: '2.1.280',
  source: 'native-installer',
  installKind: 'self-update',
  updateArgs: Object.freeze(['update']),
  installable: true,
});

const localOpencode = Object.freeze({
  id: 'opencode',
  bin: 'opencode',
  env: 'OPENCODE_BIN',
  version: '2.0.15',
  source: 'native-installer',
  installKind: 'self-update',
  updateArgs: Object.freeze(['upgrade']),
  installable: true,
});

const localCodex = Object.freeze({
  id: 'codex',
  bin: 'codex',
  env: 'CODEX_BIN',
  version: '0.155.0-alpha.16',
  source: 'app-bundled:ChatGPT.app',
  installable: false,
  note: 'read-back only (app provisioned)',
});

const localAgy = Object.freeze({
  id: 'agy',
  bin: 'agy',
  env: 'AGY_BIN',
  version: '1.2.9',
  source: 'system',
  installable: false,
  note: 'provider-not-install-target',
});

const orbitCodex = Object.freeze({
  id: 'codex',
  bin: 'codex',
  version: '0.149.1',
  source: 'npm-global',
  hostScoped: true,
  authorized: false,
  installable: false,
});

const localProvidersList = [
  localClaude,
  localOpencode,
  localCodex,
  localAgy,
];

Object.defineProperty(localProvidersList, 'claude', { value: localClaude, enumerable: false });
Object.defineProperty(localProvidersList, 'opencode', { value: localOpencode, enumerable: false });
Object.defineProperty(localProvidersList, 'codex', { value: localCodex, enumerable: false });
Object.defineProperty(localProvidersList, 'agy', { value: localAgy, enumerable: false });
const localProviders = Object.freeze(localProvidersList);

const orbitProvidersList = [
  orbitCodex,
];

Object.defineProperty(orbitProvidersList, 'codex', { value: orbitCodex, enumerable: false });
const orbitProviders = Object.freeze(orbitProvidersList);

const localHost = Object.freeze({
  authorized: true,
  providers: localProviders,
});

const orbitHost = Object.freeze({
  authorized: false,
  scope: 'host',
  note: 'owner authorization per host (M0 verdict A)',
  providers: orbitProviders,
});

const manifestBase = {
  schema: 'webmcp-ai-provider-install-manifest/1',
  updated: '2026-09-24',
  hosts: Object.freeze({
    local: localHost,
    orbit: orbitHost,
  }),
  routes: Object.freeze({
    deepseek: Object.freeze({
      model: 'opencode-go/deepseek-v4.1-flash',
      provider: 'opencode',
      discoveredAt: '2026-09-24',
      discoveredBy: 'opencode models',
    }),
    sol: Object.freeze({
      model: 'gpt-6-sol',
      provider: 'codex',
      host: 'local',
      source: 'app-bundled:ChatGPT.app',
      discoveredAt: '2026-09-23',
    }),
  }),
  auth: 'separate',
  canary: 'separate',
};

Object.defineProperty(manifestBase, 'local', {
  get() { return this.hosts.local; },
  enumerable: false,
});

Object.defineProperty(manifestBase, 'orbit', {
  get() { return this.hosts.orbit; },
  enumerable: false,
});

export const PROVIDER_INSTALL_MANIFEST = Object.freeze(manifestBase);

function resolveBin(providerDef, env) {
  try {
    const reg = getProvider(providerDef.id);
    return resolveProviderBin(reg, env);
  } catch {
    return (env && env[providerDef.env]) || providerDef.bin;
  }
}

export function planProviderInstall({
  host = 'local',
  env = process.env,
  manifest = PROVIDER_INSTALL_MANIFEST,
} = {}) {
  const normHost = String(host || '').trim().toLowerCase();
  const hostConfig = manifest?.hosts?.[normHost] || manifest?.[normHost];
  if (!hostConfig) {
    throw new AiCliError('PROVIDER_INSTALL_HOST_UNKNOWN', `Unknown provider install host: ${host}`, {
      exitCode: 2,
      retryable: false,
      details: { host },
    });
  }

  const providers = Array.isArray(hostConfig.providers)
    ? hostConfig.providers
    : Object.entries(hostConfig.providers || {}).map(([id, p]) => ({ id, ...p }));

  for (const p of providers) {
    if (!p.version || typeof p.version !== 'string' || !p.version.trim()) {
      throw new AiCliError('PROVIDER_PIN_MISSING', `Provider pin missing version for ${p.id || 'unknown'}`, {
        exitCode: 5,
        retryable: false,
        details: { host: normHost, provider: p.id },
      });
    }
  }

  if (normHost === 'orbit') {
    return {
      ok: true,
      schema: 'webmcp-ai-provider-install-plan/1',
      host: 'orbit',
      hostScoped: true,
      authorized: false,
      mutations: [],
      providers: providers.map((p) => ({
        id: p.id,
        version: p.version,
        source: p.source,
        action: 'host-authorization-required',
        installed: null,
        state: 'not-probed',
      })),
      auth: 'separate',
      canary: 'separate',
    };
  }

  const plannedProviders = [];
  const safeEnv = buildSafeChildEnv(env, {});

  for (const p of providers) {
    if (!p.installable) {
      plannedProviders.push({
        id: p.id,
        version: p.version,
        source: p.source,
        action: 'read-back-only',
        installed: null,
        state: 'not-probed',
      });
      continue;
    }

    const bin = resolveBin(p, env);
    let state = 'missing';
    let installed = null;
    let action = 'install-required';

    try {
      const probe = spawnSync(bin, ['--version'], {
        env: safeEnv,
        timeout: 5000,
        maxBuffer: 64 * 1024,
        encoding: 'utf8',
      });
      if (!probe.error && (probe.status === 0 || probe.stdout)) {
        const out = `${probe.stdout || ''}\n${probe.stderr || ''}`;
        installed = extractVersion(p.id, out);
        if (out.includes(p.version)) {
          state = 'match';
          action = 'none';
        } else {
          state = 'drift';
          action = 'upgrade';
        }
      }
    } catch {
      // spawn failed -> state remains 'missing'
    }

    plannedProviders.push({
      id: p.id,
      version: p.version,
      source: p.source,
      action,
      installed,
      state,
    });
  }

  return {
    ok: true,
    schema: 'webmcp-ai-provider-install-plan/1',
    host: 'local',
    hostScoped: false,
    authorized: true,
    mutations: [],
    providers: plannedProviders,
    auth: 'separate',
    canary: 'separate',
  };
}

export async function applyProviderInstall({
  host = 'local',
  env = process.env,
  execute = false,
  manifest = PROVIDER_INSTALL_MANIFEST,
} = {}) {
  const normHost = String(host || '').trim().toLowerCase();
  if (normHost === 'orbit') {
    throw new AiCliError('HOST_SCOPE_NOT_AUTHORIZED', 'Host orbit is not authorized for install apply', {
      exitCode: 3,
      retryable: false,
      details: { host: 'orbit', scope: 'host' },
    });
  }

  const hostConfig = manifest?.hosts?.[normHost] || manifest?.[normHost];
  if (!hostConfig) {
    throw new AiCliError('PROVIDER_INSTALL_HOST_UNKNOWN', `Unknown provider install host: ${host}`, {
      exitCode: 2,
      retryable: false,
      details: { host },
    });
  }

  const plan = planProviderInstall({ host: normHost, env, manifest });
  const safeEnv = buildSafeChildEnv(env, {});
  const receiptProviders = [];

  const manifestProviders = Array.isArray(hostConfig.providers)
    ? hostConfig.providers
    : Object.entries(hostConfig.providers || {}).map(([id, p]) => ({ id, ...p }));
  const manifestMap = new Map(manifestProviders.map((p) => [p.id, p]));

  for (const planned of plan.providers) {
    const pDef = manifestMap.get(planned.id) || {};
    if (!pDef.installable || planned.action === 'read-back-only') {
      receiptProviders.push({
        id: planned.id,
        pinnedVersion: planned.version,
        installedVersion: planned.installed,
        source: planned.source,
        state: planned.state,
        action: 'read-back-only',
      });
      continue;
    }

    if (planned.action === 'none') {
      receiptProviders.push({
        id: planned.id,
        pinnedVersion: planned.version,
        installedVersion: planned.installed ?? planned.version,
        source: planned.source,
        state: planned.state,
        action: 'none',
      });
      continue;
    }

    // action is 'upgrade' or 'install-required'
    if (!execute) {
      const updateArgs = pDef.updateArgs || [];
      const cmdStr = `${pDef.bin || planned.id} ${updateArgs.join(' ')}`.trim();
      receiptProviders.push({
        id: planned.id,
        pinnedVersion: planned.version,
        installedVersion: planned.installed,
        source: planned.source,
        state: planned.state,
        action: 'operator-required',
        command: cmdStr,
      });
    } else {
      const bin = resolveBin(pDef, env);
      const updateArgs = pDef.updateArgs || [];
      let finalAction = 'update-failed';

      try {
        const runRes = await runProcess(bin, updateArgs, {
          env: safeEnv,
          timeoutMs: 300_000,
          maxOutputBytes: 16 * 1024 * 1024,
        });
        if (runRes.exitCode === 0) {
          finalAction = 'updated';
        }
      } catch {
        finalAction = 'update-failed';
      }

      let afterVersion = planned.installed;
      try {
        const checkProbe = spawnSync(bin, ['--version'], {
          env: safeEnv,
          timeout: 5000,
          maxBuffer: 64 * 1024,
          encoding: 'utf8',
        });
        if (!checkProbe.error && (checkProbe.status === 0 || checkProbe.stdout)) {
          afterVersion = extractVersion(planned.id, `${checkProbe.stdout || ''}\n${checkProbe.stderr || ''}`);
        }
      } catch {}

      receiptProviders.push({
        id: planned.id,
        pinnedVersion: planned.version,
        installedVersion: afterVersion,
        source: planned.source,
        state: finalAction === 'updated' ? 'match' : planned.state,
        action: finalAction,
      });
    }
  }

  return {
    ok: true,
    schema: 'webmcp-ai-provider-install-receipt/1',
    host: normHost,
    createdAt: new Date().toISOString(),
    providers: receiptProviders,
    auth: 'not-assessed',
    canary: 'not-run',
  };
}

export async function readBackProviderInstall({ host = 'local', env = process.env } = {}) {
  const normHost = String(host || '').trim().toLowerCase();
  if (normHost === 'orbit') {
    return {
      ok: true,
      schema: 'webmcp-ai-provider-readback/1',
      host: 'orbit',
      authorized: false,
      providers: [],
      state: 'host-authorization-required',
    };
  }

  if (normHost !== 'local') {
    throw new AiCliError('PROVIDER_INSTALL_HOST_UNKNOWN', `Unknown provider install host: ${host}`, {
      exitCode: 2,
      retryable: false,
      details: { host },
    });
  }

  const localList = PROVIDER_INSTALL_MANIFEST.hosts.local.providers;
  const safeEnv = buildSafeChildEnv(env, {});
  const providers = [];

  for (const p of localList) {
    const bin = resolveBin(p, env);
    let installedVersion = null;
    let state = 'missing';
    let versionOutput = '';

    try {
      const res = await runProcess(bin, ['--version'], {
        env: safeEnv,
        timeoutMs: 5000,
        maxOutputBytes: 64 * 1024,
      });
      versionOutput = `${res.stdout || ''}\n${res.stderr || ''}`;
      installedVersion = extractVersion(p.id, versionOutput);
      if (versionOutput.includes(p.version)) {
        state = 'match';
      } else {
        state = 'drift';
      }
    } catch {
      installedVersion = null;
      state = 'missing';
    }

    const entry = {
      id: p.id,
      pinnedVersion: p.version,
      installedVersion,
      state,
      source: p.source,
    };

    if (p.id === 'opencode') {
      const profile = opencodeProfileForVersion(versionOutput);
      if (profile === 'v2') {
        let dbState;
        try {
          const dbPath = resolveOpencodeCliDb(env, { profile: 'v2' });
          const inspection = inspectOpencodeDb(dbPath, { lockTimeoutMs: 250 });
          dbState = inspection.state;
        } catch (err) {
          if (err?.code === 'PROVIDER_STATE_UNINITIALIZED' || err?.details?.state === 'prohibited-db') {
            dbState = 'prohibited-db';
          } else {
            dbState = 'missing';
          }
        }
        entry.database = dbState;
      } else if (profile === 'v1') {
        entry.database = 'legacy-isolated';
      } else {
        entry.database = 'unknown';
      }
    }

    providers.push(entry);
  }

  return {
    ok: true,
    schema: 'webmcp-ai-provider-readback/1',
    host: 'local',
    authorized: true,
    providers,
  };
}

export function writeProviderInstallReceipt(targetPath, receipt) {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
}

export const writeReceipt = writeProviderInstallReceipt;
