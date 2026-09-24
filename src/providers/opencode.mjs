import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';

import { buildOpenCodeConfig } from '../capabilities.mjs';
import { AiCliError } from '../errors.mjs';

const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const OPENCODE_PROFILES = Object.freeze(['v2']);
export const OPENCODE_V2_REVIEW_REQUIRED_FLAGS = Object.freeze([
  'run',
  '--standalone',
  '--format',
  '--agent',
  '--model',
]);

function helpContainsToken(helpText, token) {
  const escaped = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s,=<>()[\\]"'])${escaped}(?=$|[\\s,=<>()[\\]"'])`).test(String(helpText ?? ''));
}

/**
 * Parse a semver-shaped version from `opencode --version` output.
 * v2 prints `opencode v2.0.1`; v1 prints `1.18.30`. Returns null when no
 * version-shaped token exists.
 */
export function parseOpencodeVersion(output) {
  const match = String(output ?? '').match(/(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/u);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), raw: match[0] };
}

/**
 * Map a version probe output to a known adapter profile. Only major 1 and
 * major 2 are recognized; anything else (including unparseable output)
 * returns null so callers can fail closed with typed drift instead of
 * guessing argv/config syntax.
 */
export function opencodeProfileForVersion(versionOutput) {
  const parsed = parseOpencodeVersion(versionOutput);
  if (!parsed) return null;
  if (parsed.major === 1) return 'v1';
  if (parsed.major === 2) return 'v2';
  return null;
}

/**
 * Resolve the effective adapter profile for a request.
 * Absent/empty profile resolves to 'v2'.
 * 'v2' resolves to 'v2'.
 * 'v1' is refused with typed PROVIDER_CAPABILITY_DRIFT (v2 required).
 * Any other value fails closed with typed drift.
 */
export function normalizeOpencodeProfile(profile) {
  if (profile === null || profile === undefined || profile === '') return 'v2';
  if (profile === 'v2') return 'v2';
  if (profile === 'v1') {
    throw new AiCliError('PROVIDER_CAPABILITY_DRIFT', 'OpenCode v1 is not supported; v2 is required', {
      exitCode: 2,
      details: { capability: 'profile', profile: 'v1', required: 'v2' },
    });
  }
  const bounded = String(profile).slice(0, 32);
  throw new AiCliError('PROVIDER_CAPABILITY_DRIFT', `Unrecognized opencode profile: ${bounded}`, {
    exitCode: 2,
    details: { capability: 'profile', profile: bounded },
  });
}

export function validateOpencodeReviewSupport(helpText, { profile = 'v2' } = {}) {
  const normalized = normalizeOpencodeProfile(profile);
  const required = OPENCODE_V2_REVIEW_REQUIRED_FLAGS;
  const text = String(helpText ?? '');
  const missing = required.filter((flag) => !helpContainsToken(text, flag));
  if (missing.length > 0) {
    throw new AiCliError('PROVIDER_CAPABILITY_DRIFT', `Installed opencode CLI (${normalized}) lacks reviewer flags: ${missing.join(', ')}`, {
      exitCode: 2,
      details: { capability: 'review', profile: normalized, missing },
    });
  }
  return true;
}

/**
 * Append model/effort argv for the v2 profile.
 * Folded `--model m#e`. Effort without a model cannot be encoded and fails closed.
 */
function pushModelEffortArgs(args, request) {
  if (request.effort) {
    if (!request.model) {
      throw new AiCliError('INVALID_INPUT', 'opencode v2 effort requires an explicit model (provider/model#variant)', {
        exitCode: 2,
        details: { capability: 'model#variant' },
      });
    }
    args.push('--model', `${request.model}#${request.effort}`);
  } else if (request.model) {
    args.push('--model', request.model);
  }
}

function trimTrailingSeparators(value) {
  return value.replace(/[\\/]+$/, '');
}

// v2 mapping of the legacy provider-default accept-edits overlay (workspace
// edit allow + shell deny-list with --auto). Ordered rules; later wins.
function v2SupervisedEditPermissions(cfg) {
  const external = cfg.permissions.filter((r) => r.action === 'external_directory');
  return [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: '*', effect: 'allow' },
    { action: 'glob', resource: '*', effect: 'allow' },
    { action: 'grep', resource: '*', effect: 'allow' },
    { action: 'shell', resource: '*', effect: 'allow' },
    { action: 'shell', resource: 'rm *', effect: 'deny' },
    { action: 'shell', resource: 'rm -rf *', effect: 'deny' },
    { action: 'shell', resource: 'git push *', effect: 'deny' },
    { action: 'shell', resource: 'sudo *', effect: 'deny' },
    { action: 'edit', resource: '*', effect: 'allow' },
    { action: 'webfetch', resource: '*', effect: 'deny' },
    { action: 'websearch', resource: '*', effect: 'deny' },
    ...external,
  ];
}

function firstNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Resolve the isolated DB path used by CLI invocations so they never contend
 * with the default opencode.db held by IDE extensions or other long-running
 * instances. Precedence:
 *
 *   1. explicit operator OPENCODE_DB (respected verbatim);
 *   2. <effective XDG_DATA_HOME>/opencode/<db>;
 *   3. <homedir>/.local/share/opencode/<db>.
 *
 * The resolver accepts only profile 'v2'; any other profile (including 'v1')
 * is refused with typed PROVIDER_CAPABILITY_DRIFT (required: 'v2') before any
 * DB selection. For OpenCode v2, the database is accepted as opencode.db and
 * opencode-cli.db exists solely as a prohibited legacy database name
 * (prohibition check).
 *
 * The environment must be passed explicitly: callers hand this resolver the
 * exact effective environment that reaches the child process, so it never
 * reads process.env behind the caller's back. Task JSON and model prompts
 * have no way to influence the result.
 */
export function resolveOpencodeCliDb(env, { profile = 'v2', homeDir = homedir() } = {}) {
  if (profile !== 'v2') {
    if (profile === 'v1') {
      throw new AiCliError('PROVIDER_CAPABILITY_DRIFT', 'OpenCode v1 is not supported; v2 is required', {
        exitCode: 2,
        details: { capability: 'profile', profile: 'v1', required: 'v2' },
      });
    }
    const bounded = String(profile).slice(0, 32);
    throw new AiCliError('PROVIDER_CAPABILITY_DRIFT', `Unrecognized opencode profile: ${bounded}`, {
      exitCode: 2,
      details: { capability: 'profile', profile: bounded },
    });
  }
  const effectiveEnv = env ?? {};
  const explicit = firstNonEmptyString(effectiveEnv.OPENCODE_DB);
  if (explicit) {
    const normalized = explicit.replace(/\\/g, '/');
    if (basename(explicit) === 'opencode-cli.db' || basename(normalized) === 'opencode-cli.db') {
      throw new AiCliError('PROVIDER_STATE_UNINITIALIZED',
        'OpenCode v2 database override names a prohibited legacy database; use the accepted opencode.db or omit OPENCODE_DB',
        { exitCode: 2, retryable: false,
          details: { provider: 'opencode', profile: 'v2', state: 'prohibited-db' } });
    }
    return explicit;
  }
  const xdgDataHome = firstNonEmptyString(effectiveEnv.XDG_DATA_HOME);
  const dataHome = xdgDataHome ? trimTrailingSeparators(xdgDataHome) : join(homeDir, '.local', 'share');
  return join(dataHome, 'opencode', 'opencode.db');
}

/**
 * Inspect an OpenCode database file for validity. Never throws.
 * Returns { ok: true, state: 'ready' } or { ok: false, state: <one of> }.
 * Possible failure states: 'missing' | 'empty' | 'not-a-file' | 'symlink' | 'not-sqlite' | 'unreadable' | 'busy'
 */
export function inspectOpencodeDb(dbPath, { lockTimeoutMs = 250 } = {}) {
  let stats;
  try {
    stats = lstatSync(dbPath);
  } catch {
    return { ok: false, state: 'missing' };
  }

  if (stats.isSymbolicLink()) {
    return { ok: false, state: 'symlink' };
  }
  if (!stats.isFile()) {
    return { ok: false, state: 'not-a-file' };
  }
  if (stats.size === 0) {
    return { ok: false, state: 'empty' };
  }

  let fd;
  try {
    fd = openSync(dbPath, 'r');
    const buf = Buffer.alloc(16);
    const bytesRead = readSync(fd, buf, 0, 16, 0);
    if (bytesRead < 16 || buf.toString('utf8', 0, 16) !== 'SQLite format 3\0') {
      return { ok: false, state: 'not-sqlite' };
    }
  } catch {
    return { ok: false, state: 'unreadable' };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }

  if (lockTimeoutMs > 0) {
    let db;
    try {
      const require = createRequire(import.meta.url);
      let DatabaseSync;
      try {
        ({ DatabaseSync } = require('node:sqlite'));
      } catch {
        DatabaseSync = null;
      }
      if (DatabaseSync) {
        try {
          db = new DatabaseSync(dbPath, { timeout: lockTimeoutMs });
          db.exec('BEGIN IMMEDIATE');
          db.exec('ROLLBACK');
        } catch (err) {
          const msg = String(err?.message || err || '');
          if (msg.includes('SQLITE_BUSY') || msg.toLowerCase().includes('database is locked')) {
            return { ok: false, state: 'busy' };
          }
          return { ok: false, state: 'unreadable' };
        } finally {
          try { db?.close(); } catch {}
        }
      }
    } catch {
      // skip lock check if engine cannot load node:sqlite
    }
  }

  return { ok: true, state: 'ready' };
}

/**
 * Validate that OpenCode v2 database is ready.
 * Resolves the database path and inspects it without lock timeout.
 * Throws PROVIDER_STATE_UNINITIALIZED on invalid state.
 */
export function assertOpencodeV2DbReady({ env, profile = 'v2' } = {}) {
  const dbPath = resolveOpencodeCliDb(env, { profile });
  const inspection = inspectOpencodeDb(dbPath, { lockTimeoutMs: 0 });
  if (!inspection.ok) {
    throw new AiCliError(
      'PROVIDER_STATE_UNINITIALIZED',
      `OpenCode v2 database is not a usable non-empty SQLite file (state: ${inspection.state}); the wrapper never falls back to another database`,
      {
        exitCode: 2,
        retryable: false,
        details: { provider: 'opencode', profile: 'v2', state: inspection.state },
      },
    );
  }
  return dbPath;
}

function stripJsoncComments(text) {
  if (typeof text !== 'string') return '';
  let insideString = false;
  let stringChar = '';
  let isEscaped = false;
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    if (insideString) {
      result += char;
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === stringChar) {
        insideString = false;
      }
    } else {
      if (char === '"' || char === "'") {
        insideString = true;
        stringChar = char;
        result += char;
      } else if (char === '/' && nextChar === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        if (i < text.length) result += text[i];
      } else if (char === '/' && nextChar === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i++;
      } else {
        result += char;
      }
    }
  }
  return result.replace(/,\s*([\]}])/g, '$1');
}

export function resolveUserOpenCodeProviders(env, { homeDir = homedir() } = {}) {
  const effectiveEnv = env ?? {};
  const explicit = firstNonEmptyString(effectiveEnv.OPENCODE_CONFIG);
  const candidates = [];
  if (explicit) candidates.push(explicit);
  const xdgConfigHome = firstNonEmptyString(effectiveEnv.XDG_CONFIG_HOME);
  if (xdgConfigHome) {
    candidates.push(join(trimTrailingSeparators(xdgConfigHome), 'opencode', 'opencode.jsonc'));
    candidates.push(join(trimTrailingSeparators(xdgConfigHome), 'opencode', 'opencode.json'));
  }
  candidates.push(join(homeDir, '.config', 'opencode', 'opencode.jsonc'));
  candidates.push(join(homeDir, '.config', 'opencode', 'opencode.json'));

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        const raw = readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(stripJsoncComments(raw));
        if (parsed && typeof parsed.provider === 'object' && parsed.provider !== null) {
          return parsed.provider;
        }
      }
    } catch {}
  }
  return null;
}

/**
 * Allocate the private per-invocation config boundary and roll it back if any
 * setup step throws: callers only receive the cleanup hook after a fully
 * successful setup, so a failed config write cannot strand
 * webmcp-ai-opencode-*. Deterministic config content is written to a
 * disposable directory private to this invocation, preventing inheritance of
 * the operator's ~/.config/opencode MCP configuration and project/user config.
 */
function createIsolatedOpencodeRuntime(request, baseConfig, profile = 'v2') {
  const privateDir = mkdtempSync(join(tmpdir(), 'webmcp-ai-opencode-'));
  try {
    const xdgConfigHome = join(privateDir, 'xdg-config');
    const openCodeConfig = join(privateDir, 'opencode.json');
    const openCodeConfigDir = join(privateDir, 'opencode.d');
    mkdirSync(xdgConfigHome, { recursive: true });
    mkdirSync(openCodeConfigDir, { recursive: true });

    // Inherit user-defined custom provider endpoints (such as 9router)
    // into the isolated runtime if baseConfig does not already declare them.
    const effectiveConfig = { ...baseConfig };
    if (!effectiveConfig.provider) {
      const userProviders = resolveUserOpenCodeProviders(request.env);
      if (userProviders && Object.keys(userProviders).length > 0) {
        effectiveConfig.provider = userProviders;
      }
    }

    // OPENCODE_CONFIG points at the same content as OPENCODE_CONFIG_CONTENT
    // for defense-in-depth.
    writeFileSync(openCodeConfig, JSON.stringify(effectiveConfig, null, 2), 'utf8');
    const dbPath = resolveOpencodeCliDb(request.env, { profile: 'v2' });
    return {
      env: {
        OPENCODE_DB: dbPath,
        XDG_CONFIG_HOME: xdgConfigHome,
        OPENCODE_CONFIG: openCodeConfig,
        OPENCODE_CONFIG_DIR: openCodeConfigDir,
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_PURE: '1',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_CONFIG_CONTENT: JSON.stringify(effectiveConfig),
      },
      cleanup: () => {
        try { rmSync(privateDir, { recursive: true, force: true }); } catch {}
      },
    };
  } catch (error) {
    try { rmSync(privateDir, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

export const opencodeProvider = {
  id: 'opencode',
  name: 'opencode',
  envBin: 'OPENCODE_BIN',
  defaultBin: 'opencode',
  capabilities: {
    structuredOutput: false,
    stdinPrompt: true,
    explicitResume: true,
    modelDiscovery: true,
    toolPolicies: ['provider-default', 'compose-only'],
    // Machine-readable mirror of buildVNextReviewInvocation below: legacy
    // generate defaults to plan and honors accept-edits; review/compose/
    // implement are supported vNext intents (review needs the installed help
    // probe, implement accepts bounded-edit or full); plan needs a separate
    // contract and is rejected.
    agentModes: { supported: true, values: ['plan', 'accept-edits'], default: 'plan' },
    taskIntents: {
      review: { supported: true, accessProfile: 'review-readonly', probe: 'help' },
      compose: { supported: true, accessProfile: 'compose-only' },
      implement: { supported: true, accessProfiles: ['bounded-edit', 'full'] },
      plan: { supported: false, reason: 'requires a separate webmcp-ai-plan-result/1 contract' },
    },
  },
  buildInvocation(request) {
    if (request.schema) {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'opencode run does not expose schema-constrained output', {
        exitCode: 2,
        details: { capability: 'structuredOutput' },
      });
    }
    if (request.agent && !AGENT_NAME_PATTERN.test(request.agent)) {
      throw new AiCliError(
        'INVALID_INPUT',
        'opencode agent must be a simple discovered agent name (letters, numbers, dot, underscore, or hyphen)',
        { exitCode: 2 },
      );
    }
    // Resolved once per invocation: an explicit profile is honored; an
    // absent one defaults to the accepted v2 (a v2 host must never select the
    // legacy database in previews); v1 is refused with typed drift.
    // Unknown profiles fail closed before any argv is built.
    const profile = normalizeOpencodeProfile(request.opencodeProfile);
    // Portable vNext reviewer lane (taskIntent present).
    // vNext review uses the known installed built-in `build` agent (never native `plan`)
    // combined with the generated read-only permission config (edit/write deny, no --auto),
    // so the agent is proven while the boundary stays read-only.
    const taskIntent = request.taskIntent ?? null;
    if (taskIntent !== null && taskIntent !== undefined) {
      return buildVNextReviewInvocation(request, taskIntent);
    }
    const agentMode = request.agentMode ?? 'plan';
    if (!['plan', 'accept-edits'].includes(agentMode)) {
      throw new AiCliError('INVALID_INPUT', 'opencode agentMode must be plan or accept-edits', {
        exitCode: 2,
      });
    }

    const accessProfile = request.accessProfile || (request.toolPolicy === 'compose-only' ? 'compose-only' : 'provider-default');
    if (accessProfile === 'gateway-tool') {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'gateway-tool requires a validated local Gateway broker capability', {
        exitCode: 2,
        details: { capability: 'accessProfile', accessProfile },
      });
    }

    // Full passthrough (opt-in via --full, opencode only): behave like the
    // native CLI. No generated OPENCODE_CONFIG_CONTENT, no XDG isolation, no
    // mcp/plugin wipe — ambient operator config, tools, MCP, and web access
    // are kept for this provider. Only the session DB is isolated to avoid
    // SQLITE_BUSY with IDE instances.
    if (accessProfile === 'full') {
      const fullAuto = agentMode === 'accept-edits';
      const fullAgent = request.agent || (fullAuto ? 'build' : 'plan');
      const fullArgs = [
        'run',
        '--standalone',
        '--format', 'json', '--agent', fullAgent,
        ...(fullAuto ? ['--auto'] : []),
      ];
      pushModelEffortArgs(fullArgs, request);
      if (request.sessionId) fullArgs.push('--session', request.sessionId);
      return {
        args: fullArgs,
        stdin: request.prompt,
        env: {
          OPENCODE_DB: resolveOpencodeCliDb(request.env, { profile: 'v2' }),
        },
        cleanup: () => {},
      };
    }

    // Build deterministic per-invocation isolated config boundary for v2.
    let cfg;
    try {
      cfg = buildOpenCodeConfig({
        accessProfile,
        workspace: request.workspace,
        allowedReadRoots: request.allowedReadRoots || [],
        allowedWriteRoots: request.allowedWriteRoots || [],
        protectedPaths: request.protectedPaths || [],
        profile: 'v2',
      });
    } catch (e) {
      throw e;
    }

    let auto = false;
    if (accessProfile === 'provider-default' && agentMode === 'accept-edits') {
      auto = true;
    } else if (accessProfile === 'bounded-edit') {
      auto = true;
    } else if (accessProfile === 'compose-only') {
      auto = false;
    } else {
      auto = false;
    }

    const v2SupervisedEdit = accessProfile === 'provider-default' && agentMode === 'accept-edits';
    const baseConfig = v2SupervisedEdit ? { ...cfg, permissions: v2SupervisedEditPermissions(cfg) } : cfg;

    const agentName = request.agent || (auto ? 'build' : 'plan');
    const args = [
      'run',
      '--standalone',
      '--format', 'json', '--agent', agentName,
      ...(auto ? ['--auto'] : []),
    ];
    pushModelEffortArgs(args, request);
    if (request.sessionId) args.push('--session', request.sessionId);

    const { env: isolatedEnv, cleanup } = createIsolatedOpencodeRuntime(request, baseConfig, 'v2');
    return {
      args,
      stdin: request.prompt,
      env: isolatedEnv,
      cleanup,
    };
  },
  parseOutput({ stdout }) {
    let sessionId = null;
    let text = '';
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (event.sessionID) sessionId = String(event.sessionID);
      if (event.type === 'text' && typeof event.part?.text === 'string') {
        text += event.part.text;
      }
    }
    if (!text) text = stdout.trim();
    return { text: text.trim(), structured: null, sessionId };
  },
  modelsInvocation: { args: ['models'], stdin: null },
  agentsInvocation: { args: ['agent', 'list'], stdin: null },
  invocationEnv(env, { profile = 'v2' } = {}) {
    return { OPENCODE_DB: resolveOpencodeCliDb(env, { profile }) };
  },
};

function buildVNextReviewInvocation(request, taskIntent) {
  const agentMode = request.agentMode ?? null;
  const accessProfile = request.accessProfile || (request.toolPolicy === 'compose-only' ? 'compose-only' : null);
  const profile = normalizeOpencodeProfile(request.opencodeProfile);
  if (typeof taskIntent === 'string' && !['review', 'compose', 'implement', 'plan'].includes(taskIntent)) {
    throw new AiCliError('TASK_INTENT_INVALID', `Unknown taskIntent: ${taskIntent}`, {
      exitCode: 2,
      details: { taskIntent },
    });
  }
  // Review tool supports ONLY taskIntent review with review-readonly.
  // plan needs a separate plan-result contract; compose/implement are
  // contradictions for the read-only reviewer lane.
  if (taskIntent === 'plan') {
    throw new AiCliError('UNSUPPORTED_CAPABILITY', 'opencode review does not support taskIntent plan; use a separate plan-result contract', {
      exitCode: 2,
      details: { taskIntent },
    });
  }
  if (taskIntent === 'review') {
    if (agentMode !== null && agentMode !== undefined) {
      throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', `opencode review contradicts agentMode ${agentMode}`, {
        exitCode: 2,
        details: { taskIntent, agentMode },
      });
    }
    if (request.agent !== undefined && request.agent !== null) {
      throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', 'opencode review does not accept an explicit agent; it uses the wrapper-owned build mapping', {
        exitCode: 2,
        details: { taskIntent, agent: request.agent },
      });
    }
    if (accessProfile !== null && accessProfile !== undefined && accessProfile !== 'review-readonly') {
      throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', `opencode review contradicts accessProfile ${accessProfile}`, {
        exitCode: 2,
        details: { taskIntent, accessProfile },
      });
    }
    if (request.opencodeHelpText !== undefined && request.opencodeHelpText !== null) {
      validateOpencodeReviewSupport(request.opencodeHelpText, { profile });
    }
    const cfg = buildOpenCodeConfig({
      accessProfile: 'review-readonly',
      workspace: request.workspace,
      allowedReadRoots: request.allowedReadRoots || [],
      allowedWriteRoots: [],
      protectedPaths: request.protectedPaths || [],
      profile: 'v2',
    });
    const baseConfig = cfg;
    const agentName = 'build';
    const args = [
      'run',
      '--standalone',
      '--format', 'json', '--agent', agentName,
    ];
    pushModelEffortArgs(args, request);
    if (request.sessionId) args.push('--session', request.sessionId);
    const { env: isolatedEnv, cleanup } = createIsolatedOpencodeRuntime(request, baseConfig, 'v2');
    return {
      args,
      stdin: request.prompt,
      env: isolatedEnv,
      cleanup,
    };
  }
  if (taskIntent === 'implement') {
    if (accessProfile !== 'bounded-edit' && accessProfile !== 'full') {
      throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', 'opencode implement requires an explicit write accessProfile (bounded-edit or full)', {
        exitCode: 2,
        details: { taskIntent, accessProfile: accessProfile ?? null },
      });
    }
    if (accessProfile === 'full') {
      const fullAuto = true;
      const fullAgent = request.agent || 'build';
      const fullArgs = [
        'run',
        '--standalone',
        '--format', 'json', '--agent', fullAgent,
        ...(fullAuto ? ['--auto'] : []),
      ];
      pushModelEffortArgs(fullArgs, request);
      if (request.sessionId) fullArgs.push('--session', request.sessionId);
      return {
        args: fullArgs,
        stdin: request.prompt,
        env: { OPENCODE_DB: resolveOpencodeCliDb(request.env, { profile: 'v2' }) },
        cleanup: () => {},
      };
    }
    const cfg = buildOpenCodeConfig({
      accessProfile: 'bounded-edit',
      workspace: request.workspace,
      allowedReadRoots: request.allowedReadRoots || [],
      allowedWriteRoots: request.allowedWriteRoots || [],
      protectedPaths: request.protectedPaths || [],
      profile: 'v2',
    });
    const baseConfig = cfg;
    const agentName = request.agent || 'build';
    const args = [
      'run',
      '--standalone',
      '--format', 'json', '--agent', agentName, '--auto',
    ];
    pushModelEffortArgs(args, request);
    if (request.sessionId) args.push('--session', request.sessionId);
    const { env: isolatedEnv, cleanup } = createIsolatedOpencodeRuntime(request, baseConfig, 'v2');
    return {
      args,
      stdin: request.prompt,
      env: isolatedEnv,
      cleanup,
    };
  }
  if (taskIntent === 'compose') {
    if (accessProfile !== null && accessProfile !== undefined && accessProfile !== 'compose-only') {
      throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', 'opencode compose requires accessProfile compose-only', {
        exitCode: 2,
        details: { taskIntent, accessProfile },
      });
    }
    if (agentMode !== null && agentMode !== undefined) {
      throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', `opencode compose contradicts agentMode ${agentMode}`, {
        exitCode: 2,
        details: { taskIntent, agentMode },
      });
    }
    // No vNext intent may implicitly select native Plan mode. Compose uses
    // the known installed built-in `build` with compose-only deny-all
    // permissions (no --auto, no external_directory). An explicit agent is
    // rejected unless it is exactly `build`.
    if (request.agent !== undefined && request.agent !== null && request.agent !== 'build') {
      throw new AiCliError('TASK_INTENT_ACCESS_CONFLICT', 'opencode compose requires the build agent (native plan rejected)', {
        exitCode: 2,
        details: { taskIntent, agent: request.agent },
      });
    }
    const cfg = buildOpenCodeConfig({
      accessProfile: 'compose-only',
      workspace: request.workspace,
      allowedReadRoots: [],
      allowedWriteRoots: [],
      protectedPaths: [],
      profile: 'v2',
    });
    const baseConfig = cfg;
    const args = [
      'run',
      '--standalone',
      '--format', 'json', '--agent', 'build',
    ];
    pushModelEffortArgs(args, request);
    if (request.sessionId) args.push('--session', request.sessionId);
    const { env: isolatedEnv, cleanup } = createIsolatedOpencodeRuntime(request, baseConfig, 'v2');
    return {
      args,
      stdin: request.prompt,
      env: isolatedEnv,
      cleanup,
    };
  }
  throw new AiCliError('TASK_INTENT_INVALID', `Unknown taskIntent: ${taskIntent}`, { exitCode: 2, details: { taskIntent } });
}
