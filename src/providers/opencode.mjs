import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { buildOpenCodeConfig } from '../capabilities.mjs';
import { AiCliError } from '../errors.mjs';

const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function trimTrailingSeparators(value) {
  return value.replace(/[\\/]+$/, '');
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
 *   2. <effective XDG_DATA_HOME>/opencode/opencode-cli.db;
 *   3. <homedir>/.local/share/opencode/opencode-cli.db.
 *
 * The environment must be passed explicitly: callers hand this resolver the
 * exact effective environment that reaches the child process, so it never
 * reads process.env behind the caller's back. Task JSON and model prompts
 * have no way to influence the result.
 */
export function resolveOpencodeCliDb(env, { homeDir = homedir() } = {}) {
  const effectiveEnv = env ?? {};
  const explicit = firstNonEmptyString(effectiveEnv.OPENCODE_DB);
  if (explicit) return explicit;
  const xdgDataHome = firstNonEmptyString(effectiveEnv.XDG_DATA_HOME);
  if (xdgDataHome) {
    return join(trimTrailingSeparators(xdgDataHome), 'opencode', 'opencode-cli.db');
  }
  return join(homeDir, '.local', 'share', 'opencode', 'opencode-cli.db');
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
    // SQLITE_BUSY with IDE instances. Other providers differ: Codex full
    // still uses --ephemeral --ignore-user-config --ignore-rules with
    // --sandbox workspace-write and does NOT inherit ambient config/MCP.
    if (accessProfile === 'full') {
      const fullAuto = agentMode === 'accept-edits';
      const fullAgent = request.agent || (fullAuto ? 'build' : 'plan');
      const fullArgs = [
        'run', '--format', 'json', '--agent', fullAgent,
        ...(fullAuto ? ['--auto'] : []),
        ...(request.model ? ['--model', request.model] : []),
        ...(request.effort ? ['--variant', request.effort] : []),
        ...(request.sessionId ? ['--session', request.sessionId] : []),
        '--dir', request.workspace,
      ];
      return {
        args: fullArgs,
        stdin: request.prompt,
        env: {
          OPENCODE_DB: resolveOpencodeCliDb(request.env),
        },
        cleanup: () => {},
      };
    }

    // Build deterministic per-invocation isolated config boundary from selected profile.
    // This is the private configuration boundary: it contains explicit permission +
    // external_directory scoped to declared roots, with mcp:{}, plugin:[], share disabled,
    // and no inherited operator config. Isolation is enforced via explicit env controls.
    let cfg;
    try {
      cfg = buildOpenCodeConfig({
        accessProfile,
        workspace: request.workspace,
        allowedReadRoots: request.allowedReadRoots || [],
        allowedWriteRoots: request.allowedWriteRoots || [],
        protectedPaths: request.protectedPaths || [],
      });
    } catch (e) {
      throw e;
    }

    let permission = cfg.permission;
    let external_directory = cfg.external_directory;
    let auto = false;

    // Preserve legacy accept-edits behavior when accessProfile is provider-default but agentMode asks for edits
    if (accessProfile === 'provider-default' && agentMode === 'accept-edits') {
      permission = {
        '*': 'deny',
        read: 'allow',
        grep: 'allow',
        glob: 'allow',
        lsp: 'allow',
        edit: 'allow',
        write: 'allow',
        bash: {
          '*': 'allow',
          'rm *': 'deny',
          'rm -rf *': 'deny',
          'git push *': 'deny',
          'sudo *': 'deny',
        },
        webfetch: 'deny',
        websearch: 'deny',
      };
      // For legacy, keep external_directory from cfg (which is scoped to workspace)
      auto = true;
    } else if (accessProfile === 'bounded-edit') {
      auto = true;
    } else if (accessProfile === 'compose-only') {
      auto = false;
    } else {
      auto = false;
    }
    if (accessProfile === 'compose-only') {
      permission = { '*': 'deny' };
      external_directory = [];
    }

    // Rebuild baseConfig with isolated surface, preserving cfg's explicit mcp/plugin isolation
    const baseConfig = {
      ...cfg,
      permission,
      share: 'disabled',
      autoupdate: false,
      mdns: false,
      cors: [],
      plugin: [],
      mcp: {},
    };
    if (external_directory && external_directory.length) {
      baseConfig.external_directory = external_directory;
    } else {
      delete baseConfig.external_directory;
    }
    // Ensure no secret-bearing fields are introduced
    // baseConfig must not contain private keys, credentials, etc – it only carries permission + boundary.

    const agentName = request.agent || (auto ? 'build' : 'plan');
    const args = [
      'run', '--format', 'json', '--agent', agentName,
      ...(auto ? ['--auto'] : []),
      ...(request.model ? ['--model', request.model] : []),
      ...(request.effort ? ['--variant', request.effort] : []),
      ...(request.sessionId ? ['--session', request.sessionId] : []),
      '--dir', request.workspace,
    ];

    // Create private per-invocation config boundary directory.
    // Deterministic content (cfg) is written to a disposable directory; the directory
    // is private to this invocation and removed on cleanup. This prevents inheritance
    // of the operator's ~/.config/opencode MCP configuration and project/user config.
    const privateDir = mkdtempSync(join(tmpdir(), 'webmcp-ai-opencode-'));
    const xdgConfigHome = join(privateDir, 'xdg-config');
    const openCodeConfig = join(privateDir, 'opencode.json');
    const openCodeConfigDir = join(privateDir, 'opencode.d');
    mkdirSync(xdgConfigHome, { recursive: true });
    mkdirSync(openCodeConfigDir, { recursive: true });
    // Write the isolated config file – this is the file that OPENCODE_CONFIG points to.
    // It contains the same content as OPENCODE_CONFIG_CONTENT for defense-in-depth.
    writeFileSync(openCodeConfig, JSON.stringify(baseConfig, null, 2), 'utf8');

    return {
      args,
      stdin: request.prompt,
      env: {
        OPENCODE_DB: resolveOpencodeCliDb(request.env),
        XDG_CONFIG_HOME: xdgConfigHome,
        OPENCODE_CONFIG: openCodeConfig,
        OPENCODE_CONFIG_DIR: openCodeConfigDir,
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_PURE: '1',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_CONFIG_CONTENT: JSON.stringify(baseConfig),
      },
      cleanup: () => {
        try { rmSync(privateDir, { recursive: true, force: true }); } catch {}
      },
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
  invocationEnv(env) {
    return { OPENCODE_DB: resolveOpencodeCliDb(env) };
  },
};
