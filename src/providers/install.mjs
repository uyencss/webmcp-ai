import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { buildSafeChildEnv } from '../capabilities.mjs';
import { AiCliError } from '../errors.mjs';
import { runProcess } from '../process-runner.mjs';
import { readRemoteClaudeState } from '../remote.mjs';
import { getProvider, resolveProviderBin } from './index.mjs';
import {
  inspectOpencodeDb,
  opencodeProfileForVersion,
  parseOpencodeVersion,
  resolveOpencodeCliDb,
} from './opencode.mjs';

export function resolveBinPath(bin, env = process.env) {
  if (!bin || typeof bin !== 'string') return null;
  if (isAbsolute(bin)) {
    return bin;
  }
  if (bin.includes('/')) {
    try {
      return realpathSync(bin);
    } catch {
      return resolve(bin);
    }
  }
  const rawPath = env?.PATH ?? env?.Path ?? process.env?.PATH ?? '';
  const separator = process.platform === 'win32' ? ';' : ':';
  for (const dir of String(rawPath).split(separator)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

const MAX_BINARY_HASH_BYTES = 128 * 1024 * 1024;
const HASH_CHUNK_SIZE = 64 * 1024;

export function binaryHash(binPath) {
  if (!binPath || typeof binPath !== 'string') return null;
  let targetPath = binPath;
  try {
    const lstat = lstatSync(binPath);
    if (lstat.isSymbolicLink()) {
      targetPath = realpathSync(binPath);
    }
    const stat = statSync(targetPath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_BINARY_HASH_BYTES) return null;

    const hash = createHash('sha256');
    const fd = openSync(targetPath, 'r');
    const buffer = Buffer.alloc(HASH_CHUNK_SIZE);
    let bytesRead = 0;
    let totalRead = 0;
    try {
      while ((bytesRead = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        totalRead += bytesRead;
        if (totalRead > MAX_BINARY_HASH_BYTES) {
          return null;
        }
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      closeSync(fd);
    }
    return `sha256:${hash.digest('hex')}`;
  } catch {
    return null;
  }
}

export function versionMatchesPin(output, pin) {
  if (!pin || typeof pin !== 'string') return false;
  const tokens = String(output ?? '').match(/(?:(?<=\bv)|\b)\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g) ?? [];
  const cleanPin = pin.startsWith('v') ? pin.slice(1) : pin;
  return tokens.includes(pin) || tokens.includes(cleanPin);
}

export function canonicalPinJson(providerDef) {
  const payload = {
    id: providerDef?.id,
    installable: Boolean(providerDef?.installable),
    source: providerDef?.source,
    updateArgs: Array.isArray(providerDef?.updateArgs) ? providerDef.updateArgs : [],
    version: providerDef?.version,
  };
  const keys = Object.keys(payload).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(payload[k])}`).join(',')}}`;
}

export function computePinDigest(providerDef) {
  const canonical = canonicalPinJson(providerDef);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

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
  version: '2.1.283',
  source: 'native-installer',
  installKind: 'self-update',
  updateArgs: Object.freeze(['update']),
  installable: true,
  pinDigest: computePinDigest({
    id: 'claude',
    version: '2.1.283',
    source: 'native-installer',
    updateArgs: ['update'],
    installable: true,
  }),
});

const localOpencode = Object.freeze({
  id: 'opencode',
  bin: 'opencode',
  env: 'OPENCODE_BIN',
  version: '2.0.18',
  source: 'native-installer',
  installKind: 'self-update',
  updateArgs: Object.freeze(['upgrade']),
  installable: true,
  pinDigest: computePinDigest({
    id: 'opencode',
    version: '2.0.18',
    source: 'native-installer',
    updateArgs: ['upgrade'],
    installable: true,
  }),
});

const localCodex = Object.freeze({
  id: 'codex',
  bin: 'codex',
  env: 'CODEX_BIN',
  version: '0.157.1',
  source: 'app-bundled:ChatGPT.app',
  installable: false,
  note: 'read-back only (app provisioned)',
  pinDigest: computePinDigest({
    id: 'codex',
    version: '0.157.1',
    source: 'app-bundled:ChatGPT.app',
    updateArgs: [],
    installable: false,
  }),
});

const localAgy = Object.freeze({
  id: 'agy',
  bin: 'agy',
  env: 'AGY_BIN',
  version: '1.2.13',
  source: 'system',
  installable: false,
  note: 'provider-not-install-target',
  pinDigest: computePinDigest({
    id: 'agy',
    version: '1.2.13',
    source: 'system',
    updateArgs: [],
    installable: false,
  }),
});

const orbitCodex = Object.freeze({
  id: 'codex',
  bin: 'codex',
  version: '0.149.1',
  source: 'npm-global',
  hostScoped: true,
  authorized: false,
  installable: false,
  pinDigest: computePinDigest({
    id: 'codex',
    version: '0.149.1',
    source: 'npm-global',
    updateArgs: [],
    installable: false,
  }),
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

// m1: operator-declared remote Claude host (SSH alias `mac-pro14`). Unlike
// `local`, this host is never spawned directly — every plan/read-back probe
// runs through src/remote.mjs's bounded SSH read-only probe and is always
// remote:true, installable:false (read-back only; no ssh mutation path).
const m1Claude = Object.freeze({
  id: 'claude',
  bin: 'claude',
  version: '2.1.283',
  source: 'native-installer',
  installable: false,
  remote: true,
  note: 'remote host m1; read-back requires SSH',
  pinDigest: computePinDigest({
    id: 'claude',
    version: '2.1.283',
    source: 'native-installer',
    updateArgs: [],
    installable: false,
  }),
});

const m1ProvidersList = [
  m1Claude,
];

Object.defineProperty(m1ProvidersList, 'claude', { value: m1Claude, enumerable: false });
const m1Providers = Object.freeze(m1ProvidersList);

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

const m1Host = Object.freeze({
  authorized: true,
  transport: 'ssh',
  sshHost: 'mac-pro14',
  scope: 'host',
  note: 'operator-declared remote Claude host; probes are bounded and never infer local state',
  providers: m1Providers,
});

const manifestBase = {
  schema: 'webmcp-ai-provider-install-manifest/1',
  updated: '2026-09-29',
  hashAlgorithm: 'sha256',
  pinDigestAlgorithm: 'sha256',
  hosts: Object.freeze({
    local: localHost,
    orbit: orbitHost,
    m1: m1Host,
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

export async function planProviderInstall({
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
        pinDigest: computePinDigest(p),
        action: 'host-authorization-required',
        installed: null,
        state: 'not-probed',
        hash: null,
        auth: 'not-assessed',
        canary: 'not-run',
      })),
      auth: 'separate',
      canary: 'separate',
    };
  }

  // A host declared with transport 'ssh' (e.g. m1) never spawns a local
  // binary. Every entry is probed through the bounded, read-only SSH probe
  // in src/remote.mjs; a probe/config failure resolves to state
  // 'unreachable' rather than throwing, so this never crashes the plan.
  if (hostConfig.transport === 'ssh') {
    const sshPlannedProviders = [];
    for (const p of providers) {
      const remoteState = await readRemoteClaudeState({ hostId: normHost, env, pin: p.version });
      const action = remoteState.state === 'match' ? 'none'
        : remoteState.state === 'drift' ? 'operator-required'
        : remoteState.state === 'missing' ? 'read-back-only'
        : 'unreachable';
      sshPlannedProviders.push({
        id: p.id,
        version: p.version,
        source: p.source,
        pinDigest: computePinDigest(p),
        action,
        installed: remoteState.installedVersion,
        state: remoteState.state,
        transport: 'ssh',
        host: normHost,
        hash: null,
        auth: 'not-assessed',
        canary: 'not-run',
      });
    }
    return {
      ok: true,
      schema: 'webmcp-ai-provider-install-plan/1',
      host: normHost,
      hostScoped: true,
      authorized: true,
      mutations: [],
      providers: sshPlannedProviders,
      auth: 'separate',
      canary: 'separate',
    };
  }

  const plannedProviders = [];
  const safeEnv = buildSafeChildEnv(env, {});

  for (const p of providers) {
    const bin = resolveBin(p, env);
    const binPath = resolveBinPath(bin, env);
    const hash = binPath ? binaryHash(binPath) : null;

    if (!p.installable) {
      plannedProviders.push({
        id: p.id,
        version: p.version,
        source: p.source,
        pinDigest: computePinDigest(p),
        action: 'read-back-only',
        installed: null,
        state: 'not-probed',
        hash: hash ?? null,
        ...(hash ? { hashSource: 'binary-sha256' } : {}),
        auth: 'not-assessed',
        canary: 'not-run',
      });
      continue;
    }

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
        if (versionMatchesPin(out, p.version)) {
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
      pinDigest: computePinDigest(p),
      action,
      installed,
      state,
      hash: hash ?? null,
      ...(hash ? { hashSource: 'binary-sha256' } : {}),
      auth: 'not-assessed',
      canary: 'not-run',
    });
  }

  return {
    ok: true,
    schema: 'webmcp-ai-provider-install-plan/1',
    host: normHost,
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

  // A host declared with transport 'ssh' (e.g. m1) has no mutation path: we
  // never run an update command over SSH. Refuse before any probe.
  if (hostConfig.transport === 'ssh') {
    throw new AiCliError('REMOTE_INSTALL_UNSUPPORTED', `Remote Claude host ${normHost} does not support install apply over SSH`, {
      exitCode: 3,
      retryable: false,
      details: { host: normHost },
    });
  }

  const plan = await planProviderInstall({ host: normHost, env, manifest });
  const safeEnv = buildSafeChildEnv(env, {});
  const receiptProviders = [];

  const manifestProviders = Array.isArray(hostConfig.providers)
    ? hostConfig.providers
    : Object.entries(hostConfig.providers || {}).map(([id, p]) => ({ id, ...p }));
  const manifestMap = new Map(manifestProviders.map((p) => [p.id, p]));

  for (const planned of plan.providers) {
    const pDef = manifestMap.get(planned.id) || {};
    const bin = resolveBin(pDef, env);
    const pinDigest = computePinDigest(pDef && pDef.id ? pDef : planned);

    if (!pDef.installable || planned.action === 'read-back-only') {
      const binPath = resolveBinPath(bin, env);
      const hash = binPath ? binaryHash(binPath) : null;
      receiptProviders.push({
        id: planned.id,
        pinnedVersion: planned.version,
        installedVersion: planned.installed,
        source: planned.source,
        pinDigest,
        state: planned.state,
        action: 'read-back-only',
        hash: hash ?? null,
        ...(hash ? { hashSource: 'binary-sha256' } : {}),
        auth: 'not-assessed',
        canary: 'not-run',
      });
      continue;
    }

    if (planned.action === 'none') {
      const binPath = resolveBinPath(bin, env);
      const hash = binPath ? binaryHash(binPath) : null;
      receiptProviders.push({
        id: planned.id,
        pinnedVersion: planned.version,
        installedVersion: planned.installed ?? planned.version,
        source: planned.source,
        pinDigest,
        state: planned.state,
        action: 'none',
        hash: hash ?? null,
        ...(hash ? { hashSource: 'binary-sha256' } : {}),
        auth: 'not-assessed',
        canary: 'not-run',
      });
      continue;
    }

    // action is 'upgrade' or 'install-required'
    if (!execute) {
      const binPath = resolveBinPath(bin, env);
      const hash = binPath ? binaryHash(binPath) : null;
      const updateArgs = pDef.updateArgs || [];
      const cmdStr = `${pDef.bin || planned.id} ${updateArgs.join(' ')}`.trim();
      receiptProviders.push({
        id: planned.id,
        pinnedVersion: planned.version,
        installedVersion: planned.installed,
        source: planned.source,
        pinDigest,
        state: planned.state,
        action: 'operator-required',
        command: cmdStr,
        hash: hash ?? null,
        ...(hash ? { hashSource: 'binary-sha256' } : {}),
        auth: 'not-assessed',
        canary: 'not-run',
      });
    } else {
      const updateArgs = pDef.updateArgs || [];
      let updateExitCode = -1;

      try {
        const runRes = await runProcess(bin, updateArgs, {
          env: safeEnv,
          timeoutMs: 300_000,
          maxOutputBytes: 16 * 1024 * 1024,
        });
        updateExitCode = runRes.exitCode;
      } catch {
        updateExitCode = -1;
      }

      let versionOutput = '';
      let afterVersion = null;
      try {
        const checkProbe = spawnSync(bin, ['--version'], {
          env: safeEnv,
          timeout: 5000,
          maxBuffer: 64 * 1024,
          encoding: 'utf8',
        });
        if (!checkProbe.error && (checkProbe.status === 0 || checkProbe.stdout)) {
          versionOutput = `${checkProbe.stdout || ''}\n${checkProbe.stderr || ''}`;
          afterVersion = extractVersion(planned.id, versionOutput);
        }
      } catch {}

      const versionMatches = versionMatchesPin(versionOutput, planned.version);
      const state = versionMatches ? 'match' : 'drift';
      const action = (updateExitCode === 0 && versionMatches) ? 'updated' : 'update-failed';

      const binPath = resolveBinPath(bin, env);
      const hash = binPath ? binaryHash(binPath) : null;

      receiptProviders.push({
        id: planned.id,
        pinnedVersion: planned.version,
        installedVersion: afterVersion,
        source: planned.source,
        pinDigest,
        state,
        action,
        hash: hash ?? null,
        ...(hash ? { hashSource: 'binary-sha256' } : {}),
        auth: 'not-assessed',
        canary: 'not-run',
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

export async function readBackProviderInstall({ host = 'local', env = process.env, manifest = PROVIDER_INSTALL_MANIFEST } = {}) {
  const normHost = String(host || '').trim().toLowerCase();
  if (normHost === 'orbit') {
    return {
      ok: true,
      schema: 'webmcp-ai-provider-readback/1',
      host: 'orbit',
      authorized: false,
      providers: [],
      state: 'host-authorization-required',
      auth: 'not-assessed',
      canary: 'not-run',
    };
  }

  const sshHostConfig = manifest?.hosts?.[normHost] || manifest?.[normHost];
  if (normHost !== 'local' && sshHostConfig?.transport === 'ssh') {
    const sshProviders = Array.isArray(sshHostConfig.providers)
      ? sshHostConfig.providers
      : Object.entries(sshHostConfig.providers || {}).map(([id, p]) => ({ id, ...p }));
    const providers = [];
    for (const p of sshProviders) {
      const remoteState = await readRemoteClaudeState({ hostId: normHost, env, pin: p.version });
      providers.push({
        id: p.id,
        pinnedVersion: p.version,
        installedVersion: remoteState.installedVersion,
        state: remoteState.state,
        source: p.source,
        pinDigest: computePinDigest(p),
        hash: null,
        transport: 'ssh',
        host: normHost,
        auth: 'not-assessed',
        canary: 'not-run',
      });
    }
    return {
      ok: true,
      schema: 'webmcp-ai-provider-readback/1',
      host: normHost,
      authorized: true,
      providers,
      auth: 'not-assessed',
      canary: 'not-run',
    };
  }

  if (normHost !== 'local') {
    throw new AiCliError('PROVIDER_INSTALL_HOST_UNKNOWN', `Unknown provider install host: ${host}`, {
      exitCode: 2,
      retryable: false,
      details: { host },
    });
  }

  const hostConfig = manifest?.hosts?.local || manifest?.local;
  const localProviders = Array.isArray(hostConfig?.providers)
    ? hostConfig.providers
    : Object.entries(hostConfig?.providers || {}).map(([id, p]) => ({ id, ...p }));
  if (!localProviders.length) {
    throw new AiCliError('PROVIDER_INSTALL_HOST_UNKNOWN', 'Provider install host has no providers: local', { exitCode: 2, retryable: false, details: { host: 'local' } });
  }

  const safeEnv = buildSafeChildEnv(env, {});
  const providers = [];

  for (const p of localProviders) {
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
      if (versionMatchesPin(versionOutput, p.version)) {
        state = 'match';
      } else {
        state = 'drift';
      }
    } catch {
      installedVersion = null;
      state = 'missing';
    }

    const binPath = resolveBinPath(bin, env);
    const hash = binPath ? binaryHash(binPath) : null;

    const entry = {
      id: p.id,
      pinnedVersion: p.version,
      installedVersion,
      state,
      source: p.source,
      pinDigest: computePinDigest(p),
      hash: hash ?? null,
      ...(hash ? { hashSource: 'binary-sha256' } : {}),
      auth: 'not-assessed',
      canary: 'not-run',
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
    auth: 'not-assessed',
    canary: 'not-run',
  };
}

export function writeProviderInstallReceipt(targetPath, receipt) {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
}

export const writeReceipt = writeProviderInstallReceipt;
