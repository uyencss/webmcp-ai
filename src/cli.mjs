import { accessSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  describeGenerateDryRun, describePreflight, generate, listAgents, listModels, probeProviders,
} from './client.mjs';
import { AiCliError, asAiCliError } from './errors.mjs';
import { buildSafeChildEnv } from './capabilities.mjs';
import { describeModel } from './model-capabilities.mjs';
import { runProcess } from './process-runner.mjs';
import { getProvider, listProviders, resolveProviderBin } from './providers/index.mjs';
import { describeTools, handleToolCall, TOOL_PROTOCOL } from './protocol.mjs';
import { describeReviewDryRun, review } from './review.mjs';
import { validateClaudeReviewSupport } from './providers/claude.mjs';
import { validateCodexReviewSupport } from './providers/codex.mjs';
import { opencodeProfileForVersion, validateOpencodeReviewSupport } from './providers/opencode.mjs';

const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

const ORCHESTRATION_PACKAGE = '@gyga-browser/webmcp-ai-orchestration';

function isMissingRequestedPackage(error) {
  return (error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_MODULE_NOT_FOUND')
    && String(error?.message ?? '').includes(ORCHESTRATION_PACKAGE);
}

async function loadOrchestrationCompanion(env = process.env) {
  let resolvedEntry;
  const resolvers = [];
  try {
    const { createRequire } = await import('node:module');
    resolvers.push(createRequire(import.meta.url));
    // A cwd resolver is only an explicit source-worktree test/operator opt-in.
    // Installed consumers resolve through the core package's own dependency
    // graph; an untrusted cwd must not select arbitrary executable code.
    if (env.WEBMCP_AI_ALLOW_CWD_COMPANION === '1') {
      resolvers.push(createRequire(join(process.cwd(), 'package.json')));
    }
  } catch (error) {
    throw new AiCliError('ORCHESTRATION_PACKAGE_REQUIRED', 'Install @gyga-browser/webmcp-ai-orchestration before using orchestration commands', { exitCode: 2, cause: error });
  }

  let resolver = null;
  let lastMissing = null;
  for (const candidate of resolvers) {
    try {
      resolvedEntry = candidate.resolve(ORCHESTRATION_PACKAGE);
      resolver = candidate;
      break;
    } catch (error) {
      if (isMissingRequestedPackage(error)) {
        lastMissing = error;
        continue;
      }
      throw error;
    }
  }
  if (!resolver) {
    throw new AiCliError(
      'ORCHESTRATION_PACKAGE_REQUIRED',
      'The orchestration runtime has been extracted to @gyga-browser/webmcp-ai-orchestration. Install it before using orchestration commands or invoke its dedicated CLI.',
      { exitCode: 2, cause: lastMissing },
    );
  }

  // Resolve the companion manifest through the same dependency tree and
  // reject a mismatched pair before loading supervisor code. This prevents a
  // caller cwd from silently selecting an incompatible nested installation.
  let companionManifest;
  try {
    const manifestPath = resolver.resolve(`${ORCHESTRATION_PACKAGE}/package.json`);
    companionManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new AiCliError('ORCHESTRATION_PACKAGE_INCOMPATIBLE', 'The installed orchestration companion has no readable package manifest', { exitCode: 2, cause: error });
  }
  const requiredCore = companionManifest.dependencies?.['@gyga-browser/webmcp-ai'];
  if (requiredCore !== packageJson.version) {
    throw new AiCliError(
      'ORCHESTRATION_PACKAGE_INCOMPATIBLE',
      `The orchestration companion requires core ${String(requiredCore ?? '(missing)')}; current core is ${packageJson.version}`,
      { exitCode: 2, details: { coreVersion: packageJson.version, requiredCore: requiredCore ?? null } },
    );
  }
  const coreArtifactIdentity = packageJson.webmcpArtifactIdentity;
  const companionCoreArtifactIdentity = companionManifest.webmcpCoreArtifactIdentity;
  if (typeof coreArtifactIdentity !== 'string'
    || companionCoreArtifactIdentity !== coreArtifactIdentity) {
    throw new AiCliError(
      'ORCHESTRATION_PACKAGE_INCOMPATIBLE',
      'The orchestration companion is not built for this core artifact identity',
      { exitCode: 2, details: { coreArtifactIdentity: coreArtifactIdentity ?? null, companionCoreArtifactIdentity: companionCoreArtifactIdentity ?? null } },
    );
  }

  try {
    const loaded = await import(resolvedEntry);
    if (typeof loaded.createOrchestrationClient !== 'function') {
      throw new Error('companion does not expose createOrchestrationClient');
    }
    return loaded;
  } catch (error) {
    // Once a package was resolved, every load/export/syntax/dependency failure
    // is an incompatibility, never package absence and never an untyped stack
    // trace. The only missing-package branch is the resolver above.
    throw new AiCliError('ORCHESTRATION_PACKAGE_INCOMPATIBLE', 'The installed orchestration companion could not load its declared public API or dependencies', { exitCode: 2, cause: error });
  }
}

// Plan §8.1 limitation for the Claude reviewer: managed/enterprise settings
// may override command-line grants. Bounded, no settings paths or secrets.
const CLAUDE_REVIEW_LIMITATIONS = Object.freeze([
  'Managed or enterprise settings may override command-line grants; reviewer flags are requested, not guaranteed.',
]);

// Provider version output is untrusted process output. Keep only one bounded,
// printable line and redact path/secret-shaped material before it enters the
// inspection envelope. This is deliberately narrower than the ordinary
// `providers list` probe: review inspection must remain path/secret-free.
function sanitizeInspectVersion(value) {
  let text = String(value ?? '')
    .split(/\r?\n/, 1)[0]
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (/(?:secret|token|password|credential|api[_-]?key|authorization|bearer)\s*[:=]/i.test(text)) {
    return '<redacted>';
  }
  text = text.replace(/(^|[\s=])(?:\/[\w. @%+~,:;=@-]+(?:\/[\w. @%+~,:;=@-]*)*|~\/[^\s]+|[A-Za-z]:[\\/][^\s]+)/g, '$1<path>');
  text = text.replace(/[\\/]{2,}/g, '/');
  return text.slice(0, 200) || null;
}

export function getCommandName(env = process.env) {
  return env.WEBMCP_AI_COMMAND_NAME || 'webmcp-ai';
}

function helpText(commandName) {
  return `${commandName} — provider-neutral local AI CLI

Usage:
  ${commandName} <command> [options]
  ${commandName} doctor [--json]
  ${commandName} preflight [--json]
  ${commandName} providers list [--json]
  ${commandName} providers inspect <provider> [--task-intent review] [--json]
  ${commandName} models list --provider <agy|claude|codex|opencode> [--json]
  ${commandName} models inspect --provider <id> [--model <model>] [--json]
  ${commandName} agents list --provider agy [--json]
  ${commandName} generate --provider <id> (--prompt <text> | --prompt-file <path>) [options]
  ${commandName} generate --input-json <path|-> [--json] [--dry-run]
  ${commandName} review --provider <id> (--prompt <text> | --prompt-file <path>) [options]
  ${commandName} review --input-json <path|-> [--json]
  ${commandName} tools describe [--json]
  ${commandName} tool-call --json
  ${commandName} orchestration capabilities --json
  ${commandName} orchestration guide --format markdown
  ${commandName} orchestration create --input-json <path|-> [--json]
  ${commandName} orchestration call --coordination <coord-id> --input-json <path|-> [--json]
  ${commandName} orchestration prune [--json]

Generate options:
  --model <model>          Provider model override
  --effort <level>        Provider reasoning/effort override
  --schema <path>         JSON Schema for structured output
  --session-id <id>       Resume only this explicit provider session
  --agent-mode <mode>     (Deprecated: prefer --task-intent) AGY/opencode only: plan (default) or accept-edits
  --agent <name>          AGY/opencode only: select a discovered custom agent
  --tool-policy <policy>  provider-default (default) or compose-only (legacy)
  --task-intent <intent>  Portable intent: compose|review|implement|plan (unknown -> TASK_INTENT_INVALID; contradictions -> TASK_INTENT_ACCESS_CONFLICT before spawn)
  --access-profile <profile>  provider-default, compose-only, review-readonly, bounded-edit, gateway-tool, full
  --full                  Short for --access-profile full: native-CLI passthrough with full folder + tools
  --workspace <path>      Trusted working directory for the provider
  --allowed-read-root <path>   Repeatable: additional readable root (absolute)
  --allowed-write-root <path>  Repeatable: writable root inside workspace (absolute)
  --protected-path <path>      Repeatable: protected path inside workspace (overrides writes)
  --project-id <id>       Opaque project binding identifier
  --store-revisions <json> JSON object of store revisions
  --timeout-ms <ms>       Process timeout (default: 600000)
  --max-output-bytes <n>  Provider output cap in bytes (default: 32MB, 128MB with --full)
  --retry-lock <n>        Retries for a transient concurrent provider DB lock (default: 3)
  --resolve-artifacts     AGY only: recover the full answer from its brain dir when stdout is a summary
  --agy-brain-dir <path>  Override the AGY brain directory used by --resolve-artifacts
  --dry-run               Resolve + sanitized inspection only; never spawns a provider
  --stream                Forward provider stdout/stderr live to our stderr; stdout keeps one JSON envelope
  --stream-to <ch>        Live channel for --stream/--events: stderr (default) or stdout
  --events                Emit one advisory progress JSON per line to our stderr (see skill for states)
  --json                  Emit stable JSON on stdout

Review options (portable one-shot reviewer; reuses the ai.review resolver; read-only):
  --provider <id>         claude|codex|opencode (agy review is UNSUPPORTED_CAPABILITY)
  --prompt <text>         Review prompt (or --prompt-file <path>, or --input-json <path|->)
  --task-intent <intent>  review only (absent defaults to review; plan/compose/implement rejected; unknown -> TASK_INTENT_INVALID)
  --access-profile <profile>  review-readonly only (absent defaults to review-readonly; mismatch -> TASK_INTENT_ACCESS_CONFLICT)
  --model <model>         Provider model override
  --effort <level>        Provider reasoning/effort override
  --session-id <id>       Resume only this explicit provider session (resumed results set resumed:true and are not fresh final-auditor evidence; omit for a fresh audit)
  --workspace <path>      Trusted working directory for the provider (defaults to cwd for compatibility; read-only, never written; prefer explicit)
  --allowed-read-root <path>   Repeatable: additional readable root (absolute)
  --protected-path <path>      Repeatable: protected path inside workspace
  --project-id <id>       Opaque project binding identifier
  --store-revisions <json> JSON object of store revisions
  --timeout-ms <ms>       Process timeout (default: 600000)
  --max-output-bytes <n>  Provider output cap in bytes
  --dry-run               Resolve + sanitized inspection only; never spawns a provider (no process spawn; digests only)
  --json                  Emit stable JSON on stdout
  (review intentionally disallows --stream/--events/--stream-to; use generate for live telemetry. Claude uses native stream-json --verbose only when events are requested in generate.)

Migration:
  Prefer --task-intent (compose|review|implement|plan) with --access-profile
  (compose-only|review-readonly|bounded-edit|full) over legacy --agent-mode.
  Unknown intents fail with TASK_INTENT_INVALID; intent/profile contradictions
  (including implement without bounded-edit/full) fail with
  TASK_INTENT_ACCESS_CONFLICT before spawn. --agent-mode (plan|accept-edits)
  remains for generate compatibility but is rejected for review. ai.review
  accepts only taskIntent review + accessProfile review-readonly and returns
  schema webmcp-ai-review-result/1 (verdict approve|request-changes|blocked|
  indeterminate; severity critical|high|medium|low; findings carry
  id/severity/message/recommendation with file/line optional only for
  architectural findings; blocked requires blockedReason; approve rejects
  critical/high/medium). Plan intent needs a separate webmcp-ai-plan-result/1
  contract and is uniformly rejected. OpenCode review/compose use the known
  build agent (never native plan) with generated read-only/deny-all
  permissions. review/plan accept only review-readonly (review+compose-only
  fails TASK_INTENT_ACCESS_CONFLICT before any compose workspace; legacy
  no-taskIntent compose-only unchanged). providers inspect <id> --task-intent
  review probes each provider's required CLI mapping via the installed
  binary/version/help (bounded, read-only, no model) and reports
  installed/authenticated/policy-supported/canary-proven/task-ready
  separately without leaking paths/secrets.

Environment:
  AGY_BIN, CLAUDE_BIN, CODEX_BIN, OPENCODE_BIN   Override provider executables
`;
}

const REPEATABLE_OPTIONS = new Set(['allowed-read-root', 'allowed-write-root', 'protected-path']);

function parseOptions(args) {
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const equalAt = token.indexOf('=');
    let name;
    let value;
    if (equalAt >= 0) {
      name = token.slice(2, equalAt);
      value = token.slice(equalAt + 1);
    } else {
      name = token.slice(2);
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }
    if (REPEATABLE_OPTIONS.has(name)) {
      if (!options[name]) options[name] = [];
      if (value !== true) options[name].push(value);
    } else {
      // For non-repeatable, keep last value (standard); but allow building array for read/write roots via comma? Not needed
      options[name] = value;
    }
  }
  return { options, positional };
}

function readJsonInput(path) {
  const text = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AiCliError('INVALID_JSON', `Could not parse JSON input: ${error.message}`, { exitCode: 2 });
  }
}

function collectArrayOption(options, name, fromJsonKey) {
  const cliVals = options[name];
  const jsonVals = fromJsonKey ? undefined : undefined;
  // This helper is called with fromJson already; caller passes json value
  if (Array.isArray(cliVals) && cliVals.length) return cliVals;
  return undefined;
}

// Intentional boolean `full` behavior (CLI-only alias):
// `--full` / `--input-json { "full": true }` maps to `accessProfile: "full"`.
// Accepted truthy forms are boolean true and case-insensitive "true"/"1"/"yes"
// (via isTrueFlag); false, "false", "0", "", null/undefined do NOT select full
// and fall through to --access-profile/accessProfile (default
// provider-default). This alias exists only in the CLI lane; the
// webmcp-tool-v1 protocol keeps the canonical `accessProfile: "full"` and
// rejects a top-level `full` field (see src/protocol.mjs).
function isFullFlag(value) {
  return isTrueFlag(value);
}

function isTrueFlag(value) {
  if (value === true) return true;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  }
  return false;
}

function generateInput(options) {
  const fromJson = options['input-json'] ? readJsonInput(options['input-json']) : {};
  const schema = options.schema ? readJsonInput(options.schema) : fromJson.schema;
  const prompt = options['prompt-file']
    ? readFileSync(options['prompt-file'], 'utf8')
    : (options.prompt ?? fromJson.prompt);
  // Repeatable root options – CLI arrays take precedence if present, else JSON arrays
  const allowedReadRoots = options['allowed-read-root']?.length ? options['allowed-read-root'] : fromJson.allowedReadRoots;
  const allowedWriteRoots = options['allowed-write-root']?.length ? options['allowed-write-root'] : fromJson.allowedWriteRoots;
  const protectedPaths = options['protected-path']?.length ? options['protected-path'] : fromJson.protectedPaths;
  let storeRevisions = fromJson.storeRevisions;
  if (options['store-revisions']) {
    try {
      storeRevisions = JSON.parse(options['store-revisions']);
    } catch {
      storeRevisions = options['store-revisions'];
    }
  } else if (fromJson.storeRevisions) {
    storeRevisions = fromJson.storeRevisions;
  }
  // Also support camelCase JSON keys from protocol
  return {
    ...fromJson,
    provider: options.provider ?? fromJson.provider,
    prompt,
    model: options.model ?? fromJson.model,
    effort: options.effort ?? fromJson.effort,
    schema,
    sessionId: options['session-id'] ?? fromJson.sessionId,
    agentMode: options['agent-mode'] ?? fromJson.agentMode,
    agent: options.agent ?? fromJson.agent,
    toolPolicy: options['tool-policy'] ?? fromJson.toolPolicy,
    accessProfile: isFullFlag(options.full ?? fromJson.full) ? 'full' : (options['access-profile'] ?? fromJson.accessProfile),
    taskIntent: options['task-intent'] ?? fromJson.taskIntent,
    timeoutMs: options['timeout-ms'] ? Number(options['timeout-ms']) : fromJson.timeoutMs,
    maxOutputBytes: options['max-output-bytes'] ? Number(options['max-output-bytes']) : fromJson.maxOutputBytes,
    stream: options.stream ?? fromJson.stream,
    events: options.events ?? fromJson.events,
    streamTo: options['stream-to'] ?? fromJson.streamTo,
    workspace: options.workspace ?? fromJson.workspace,
    allowedReadRoots,
    allowedWriteRoots,
    protectedPaths,
    projectId: options['project-id'] ?? fromJson.projectId,
    storeRevisions,
    gatewayCapabilityHandle: options['gateway-capability-handle'] ?? fromJson.gatewayCapabilityHandle,
    retryLock: options['retry-lock'] ?? fromJson.retryLock,
    resolveArtifacts: isTrueFlag(options['resolve-artifacts'] ?? fromJson.resolveArtifacts),
    agyBrainDir: options['agy-brain-dir'] ?? fromJson.agyBrainDir,
    dryRun: isTrueFlag(options['dry-run'] ?? fromJson.dryRun),
  };
}

function reviewInput(options) {
  const fromJson = options['input-json'] ? readJsonInput(options['input-json']) : {};
  const prompt = options['prompt-file']
    ? readFileSync(options['prompt-file'], 'utf8')
    : (options.prompt ?? fromJson.prompt);
  const allowedReadRoots = options['allowed-read-root']?.length ? options['allowed-read-root'] : fromJson.allowedReadRoots;
  const protectedPaths = options['protected-path']?.length ? options['protected-path'] : fromJson.protectedPaths;
  let storeRevisions = fromJson.storeRevisions;
  if (options['store-revisions']) {
    try {
      storeRevisions = JSON.parse(options['store-revisions']);
    } catch {
      storeRevisions = options['store-revisions'];
    }
  } else if (fromJson.storeRevisions) {
    storeRevisions = fromJson.storeRevisions;
  }
  // ai.review is read-only: reject every write-capable or privileged field
  // here so the CLI lane matches the protocol contract before any spawn.
  // taskIntent/accessProfile narrowing (review + review-readonly) is enforced
  // in review.mjs; write roots/gateway/MCP are rejected there and here.
  for (const forbidden of ['agent-mode', 'agent', 'tool-policy', 'schema', 'gateway-capability-handle', 'gateway-handle', 'mcp-config']) {
    const cliKey = forbidden;
    const jsonKey = forbidden === 'agent-mode' ? 'agentMode'
      : forbidden === 'tool-policy' ? 'toolPolicy'
      : forbidden === 'gateway-capability-handle' ? 'gatewayCapabilityHandle'
      : forbidden === 'gateway-handle' ? 'gatewayHandle'
      : forbidden === 'mcp-config' ? 'mcpConfig'
      : forbidden;
    if (options[cliKey] !== undefined || fromJson[jsonKey] !== undefined) {
      throw new AiCliError('INVALID_INPUT', `${jsonKey} is not allowed for review`, { exitCode: 2, details: { field: jsonKey } });
    }
  }
  // Write roots, full alias, and gateway/MCP JSON fields are never allowed.
  const rawWriteRoots = options['allowed-write-root']?.length ? options['allowed-write-root'] : fromJson.allowedWriteRoots;
  if (rawWriteRoots !== undefined && rawWriteRoots !== null) {
    if (!Array.isArray(rawWriteRoots)) {
      throw new AiCliError('INVALID_INPUT', 'allowedWriteRoots is not allowed for review', { exitCode: 2 });
    }
    if (rawWriteRoots.length > 0) {
      throw new AiCliError('INVALID_INPUT', 'allowedWriteRoots is not allowed for review (read-only)', { exitCode: 2 });
    }
  }
  if (isFullFlag(options.full ?? fromJson.full)) {
    throw new AiCliError('INVALID_INPUT', 'ai.review requires accessProfile review-readonly (full rejected)', { exitCode: 2 });
  }
  for (const key of ['gatewayCapabilityHandle', 'gatewayHandle', 'mcpConfig']) {
    if (fromJson[key] !== undefined && fromJson[key] !== null) {
      throw new AiCliError('INVALID_INPUT', `${key} is not allowed for review`, { exitCode: 2, details: { field: key } });
    }
  }
  if (options.stream !== undefined || fromJson.stream !== undefined || options.events !== undefined || fromJson.events !== undefined) {
    throw new AiCliError('INVALID_INPUT', 'stream/events are not supported for review', { exitCode: 2 });
  }
  if (options['stream-to'] !== undefined || fromJson.streamTo !== undefined) {
    throw new AiCliError('INVALID_INPUT', 'stream-to is not supported for review', { exitCode: 2 });
  }
  return {
    provider: options.provider ?? fromJson.provider,
    prompt,
    model: options.model ?? fromJson.model,
    effort: options.effort ?? fromJson.effort,
    sessionId: options['session-id'] ?? fromJson.sessionId,
    taskIntent: options['task-intent'] ?? fromJson.taskIntent,
    accessProfile: options['access-profile'] ?? fromJson.accessProfile,
    timeoutMs: options['timeout-ms'] ? Number(options['timeout-ms']) : fromJson.timeoutMs,
    maxOutputBytes: options['max-output-bytes'] ? Number(options['max-output-bytes']) : fromJson.maxOutputBytes,
    workspace: options.workspace ?? fromJson.workspace,
    allowedReadRoots,
    allowedWriteRoots: [],
    protectedPaths,
    projectId: options['project-id'] ?? fromJson.projectId,
    storeRevisions,
    gatewayCapabilityHandle: undefined,
    dryRun: isTrueFlag(options['dry-run'] ?? fromJson.dryRun),
  };
}

function printValue(value, json, textSelector = null) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (textSelector) process.stdout.write(`${textSelector(value)}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const commandName = getCommandName(env);
  const [command, subcommand, ...rest] = argv;
  const allArgs = argv.slice(['providers', 'models', 'agents', 'tools'].includes(command) ? 2 : 1);
  const { options, positional } = parseOptions(allArgs);
  const json = Boolean(options.json || argv.includes('--json'));

  if (!command || ['--help', '-h', 'help'].includes(command)) {
    process.stdout.write(helpText(commandName));
    return 0;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${packageJson.version}\n`);
    return 0;
  }
  if (command === 'doctor') {
    const providers = await probeProviders({ env });
    const payload = {
      ok: true,
      version: packageJson.version,
      protocol: TOOL_PROTOCOL,
      providers,
      readyProviders: providers.filter((provider) => provider.available).map((provider) => provider.id),
    };
    printValue(payload, json, (value) => value.providers.map((provider) => `${provider.id}: ${provider.available ? provider.version || 'available' : 'missing'}`).join('\n'));
    return 0;
  }
  if (command === 'providers' && subcommand === 'list') {
    const payload = { ok: true, providers: listProviders() };
    printValue(payload, json, (value) => value.providers.map((provider) => `${provider.id}\t${provider.name}`).join('\n'));
    return 0;
  }
  if (command === 'preflight') {
    const payload = { ...describePreflight({ env }), packageVersion: packageJson.version };
    printValue(payload, json);
    return 0;
  }
  if (command === 'providers' && subcommand === 'inspect') {
    const id = positional[0] || rest.find((token) => !token.startsWith('--'));
    const providerMeta = listProviders().find((entry) => entry.id === id);
    if (!providerMeta) throw new AiCliError('UNKNOWN_PROVIDER', `Unknown provider: ${id || '(missing)'}`, { exitCode: 2 });
    const taskIntentRaw = options['task-intent'] ?? null;
    if (taskIntentRaw !== null && taskIntentRaw !== undefined) {
      const intentStr = String(taskIntentRaw).trim();
      if (!intentStr) {
        throw new AiCliError('INVALID_INPUT', 'providers inspect --task-intent must be a non-empty string', {
          exitCode: 2,
          details: { taskIntent: taskIntentRaw },
        });
      }
      if (!['compose', 'review', 'implement', 'plan'].includes(intentStr)) {
        throw new AiCliError('TASK_INTENT_INVALID', `Unknown taskIntent: ${intentStr} (inspect supports review)`, {
          exitCode: 2,
          details: { taskIntent: intentStr },
        });
      }
      if (intentStr !== 'review') {
        throw new AiCliError('UNSUPPORTED_CAPABILITY', `providers inspect --task-intent only supports review in MVP (got ${intentStr})`, {
          exitCode: 2,
          details: { taskIntent: intentStr },
        });
      }
      // Truthful, bounded, read-only capability inspection. Probes the
      // installed binary/version/help without leaking executable paths,
      // secrets or raw settings. Never invokes a model. Reports separated
      // installed/authenticated/policy-supported/canary-proven/task-ready
      // fields plus typed missing/unsupported reasons.
      const provider = getProvider(providerMeta.id);
      const safeEnv = buildSafeChildEnv(env, {});
      const commandBin = resolveProviderBin(provider, env);
      let installed = false;
      let version = null;
      if (commandBin.includes('/')) {
        try {
          accessSync(commandBin, constants.X_OK);
          installed = true;
        } catch {
          installed = false;
        }
      } else {
        // Bare names resolve via PATH; prove via --version probe below.
        installed = true;
      }
      let versionProbeError = null;
      if (installed) {
        try {
          const ver = await runProcess(commandBin, ['--version'], {
            env: safeEnv, timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
          });
          version = sanitizeInspectVersion(ver.stdout.trim() || ver.stderr.trim());
        } catch (error) {
          versionProbeError = error;
          if (error?.code === 'CLI_NOT_INSTALLED') {
            installed = false;
            version = null;
          } else {
            // Version probe failed but binary may exist (e.g. --version
            // unsupported). Keep installed as path-probe result, version null.
            version = null;
          }
        }
      }
      // Bare-name PATH lookup that failed version probing is missing.
      if (!commandBin.includes('/') && versionProbeError !== null && version === null) {
        installed = false;
      }
      const policySupported = provider.id !== 'agy';
      const canaryProven = false;
      const authenticated = null;
      if (provider.id === 'agy') {
        const payload = {
          ok: true, provider: provider.id, taskIntent: 'review',
          accessProfile: 'review-readonly',
          installed, version, authenticated,
          policySupported: false, canaryProven, taskReady: false,
          supported: false,
          code: 'UNSUPPORTED_CAPABILITY',
          reason: 'AGY does not support preventive deny-write review mode',
          missing: ['AGY preventive deny-write review mode (unproven in MVP)'],
          mapping: null,
        };
        printValue(payload, json);
        return 0;
      }
      if (provider.id === 'claude') {
        // Actually invoke the installed help/version probe and validate.
        // A drifted/missing CLI returns DRIFT/unavailable, never
        // supported:true by static table alone.
        if (!installed) {
          printValue({
            ok: true, provider: provider.id, taskIntent: 'review',
            accessProfile: 'review-readonly',
            installed: false, version: null, authenticated,
            policySupported: true, canaryProven, taskReady: false,
            supported: false,
            code: 'CLI_NOT_INSTALLED',
            reason: 'Claude CLI binary not installed or not executable',
            missing: ['installed claude binary'],
            limitations: [...CLAUDE_REVIEW_LIMITATIONS],
            mapping: {
              flags: ['--permission-mode dontAsk', '--tools Read,Glob,Grep', '--disallowedTools Edit,Write,NotebookEdit', '--safe-mode', '--no-chrome', '--no-session-persistence'],
            },
          }, json);
          return 0;
        }
        let helpText = null;
        let helpError = null;
        try {
          const help = await runProcess(commandBin, ['--help'], {
            env: safeEnv, timeoutMs: 5_000, maxOutputBytes: 256 * 1024,
          });
          helpText = `${help.stdout}\n${help.stderr}`;
        } catch (error) {
          helpError = error;
        }
        if (helpText !== null) {
          try {
            validateClaudeReviewSupport(helpText);
          } catch (drift) {
            printValue({
              ok: true, provider: provider.id, taskIntent: 'review',
              accessProfile: 'review-readonly',
              installed: true, version, authenticated,
              policySupported: true, canaryProven, taskReady: false,
              supported: false,
              code: 'PROVIDER_CAPABILITY_DRIFT',
              reason: drift.message,
              missing: drift.details?.missing ?? ['reviewer flags'],
              limitations: [...CLAUDE_REVIEW_LIMITATIONS],
              mapping: {
                flags: ['--permission-mode dontAsk', '--tools Read,Glob,Grep', '--disallowedTools Edit,Write,NotebookEdit', '--safe-mode', '--no-chrome', '--no-session-persistence'],
              },
            }, json);
            return 0;
          }
          printValue({
            ok: true, provider: provider.id, taskIntent: 'review',
            accessProfile: 'review-readonly',
            installed: true, version, authenticated,
            policySupported: true, canaryProven, taskReady: true,
            supported: true,
            code: null, reason: null, missing: [],
            limitations: [...CLAUDE_REVIEW_LIMITATIONS],
            mapping: {
              flags: ['--permission-mode dontAsk', '--tools Read,Glob,Grep', '--disallowedTools Edit,Write,NotebookEdit', '--safe-mode', '--no-chrome', '--no-session-persistence'],
              events: 'native stream-json --verbose only when events requested; review CLI disallows --stream/--events (explicit contract)',
            },
          }, json);
          return 0;
        }
        // Help probe failed: truthful unavailable, never supported:true.
        printValue({
          ok: true, provider: provider.id, taskIntent: 'review',
          accessProfile: 'review-readonly',
          installed: true, version, authenticated,
          policySupported: true, canaryProven, taskReady: false,
          supported: false,
          code: helpError?.code === 'CLI_NOT_INSTALLED' ? 'CLI_NOT_INSTALLED' : 'PROVIDER_CAPABILITY_DRIFT',
          reason: helpError ? `Claude help probe failed: ${helpError.code || 'probe failed'}` : 'Claude help probe failed',
          missing: ['version-probed reviewer flags'],
          limitations: [...CLAUDE_REVIEW_LIMITATIONS],
          mapping: {
            flags: ['--permission-mode dontAsk', '--tools Read,Glob,Grep', '--disallowedTools Edit,Write,NotebookEdit', '--safe-mode', '--no-chrome', '--no-session-persistence'],
          },
        }, json);
        return 0;
      }
      if (provider.id === 'codex') {
        // Bounded read-only help probe for the Codex reviewer. Requires the
        // review mapping primitives plus resume requirements; drift or failed
        // probe fails closed (never supported:true by install alone). No model
        // spawn. Bounded missing names only; no paths/raw help.
        if (!installed) {
          printValue({
            ok: true, provider: provider.id, taskIntent: 'review',
            accessProfile: 'review-readonly',
            installed: false, version: null, authenticated,
            policySupported: true, canaryProven, taskReady: false,
            supported: false,
            code: 'CLI_NOT_INSTALLED',
            reason: 'Codex CLI binary not installed or not executable',
            missing: ['installed codex binary'],
            mapping: { sandbox: 'read-only ephemeral', resume: 'exec resume -c sandbox_mode="read-only" (omits --sandbox/--color)' },
          }, json);
          return 0;
        }
        let codexHelpText = null;
        let codexHelpError = null;
        try {
          const help = await runProcess(commandBin, ['exec', '--help'], {
            env: safeEnv, timeoutMs: 5_000, maxOutputBytes: 256 * 1024,
          });
          codexHelpText = `${help.stdout}\n${help.stderr}`;
        } catch (error) {
          codexHelpError = error;
        }
        if (codexHelpText !== null) {
          try {
            validateCodexReviewSupport(codexHelpText);
          } catch (drift) {
            printValue({
              ok: true, provider: provider.id, taskIntent: 'review',
              accessProfile: 'review-readonly',
              installed: true, version, authenticated,
              policySupported: true, canaryProven, taskReady: false,
              supported: false,
              code: 'PROVIDER_CAPABILITY_DRIFT',
              reason: drift.message,
              missing: drift.details?.missing ?? ['reviewer flags'],
              mapping: { sandbox: 'read-only ephemeral', resume: 'exec resume -c sandbox_mode="read-only" (omits --sandbox/--color)' },
            }, json);
            return 0;
          }
          printValue({
            ok: true, provider: provider.id, taskIntent: 'review',
            accessProfile: 'review-readonly',
            installed: true, version, authenticated,
            policySupported: true, canaryProven, taskReady: true,
            supported: true,
            code: null, reason: null, missing: [],
            mapping: { sandbox: 'read-only ephemeral', resume: 'exec resume -c sandbox_mode="read-only" (omits --sandbox/--color)' },
          }, json);
          return 0;
        }
        printValue({
          ok: true, provider: provider.id, taskIntent: 'review',
          accessProfile: 'review-readonly',
          installed: true, version, authenticated,
          policySupported: true, canaryProven, taskReady: false,
          supported: false,
          code: codexHelpError?.code === 'CLI_NOT_INSTALLED' ? 'CLI_NOT_INSTALLED' : 'PROVIDER_CAPABILITY_DRIFT',
          reason: codexHelpError ? `Codex help probe failed: ${codexHelpError.code || 'probe failed'}` : 'Codex help probe failed',
          missing: ['version-probed reviewer flags'],
          mapping: { sandbox: 'read-only ephemeral', resume: 'exec resume -c sandbox_mode="read-only" (omits --sandbox/--color)' },
        }, json);
        return 0;
      }
      // opencode: bounded read-only help probe requiring run/--format/--agent/
      // plus model plus profile-specific syntax (v1: --dir/--variant; v2:
      // model#variant, no --dir). Version-parsed profile is required; unknown
      // profiles fail closed. Wrapper read-only config mapping is reported in
      // mapping (build + edit/write deny, no --auto). No model spawn.
      if (provider.id === 'opencode') {
        if (!installed) {
          printValue({
            ok: true, provider: provider.id, taskIntent: 'review',
            accessProfile: 'review-readonly',
            installed: false, version: null, authenticated,
            policySupported: true, canaryProven, taskReady: false,
            supported: false,
            code: 'CLI_NOT_INSTALLED',
            reason: 'opencode CLI binary not installed or not executable',
            missing: ['installed opencode binary'],
            mapping: { agent: 'build', profile: null, permissions: 'read-only (edit/write deny, no --auto)' },
          }, json);
          return 0;
        }
        const opencodeProfile = version ? opencodeProfileForVersion(version) : null;
        if (!opencodeProfile) {
          printValue({
            ok: true, provider: provider.id, taskIntent: 'review',
            accessProfile: 'review-readonly',
            installed: true, version, authenticated,
            policySupported: true, canaryProven, taskReady: false,
            supported: false,
            code: 'PROVIDER_CAPABILITY_DRIFT',
            reason: 'opencode version is not a recognized v1/v2 profile',
            missing: ['recognized opencode v1/v2 version'],
            mapping: { agent: 'build', profile: null, permissions: 'read-only (edit/write deny, no --auto)' },
          }, json);
          return 0;
        }
        let opencodeHelpText = null;
        let opencodeHelpError = null;
        try {
          const help = await runProcess(commandBin, ['run', '--help'], {
            env: safeEnv, timeoutMs: 5_000, maxOutputBytes: 256 * 1024,
          });
          opencodeHelpText = `${help.stdout}\n${help.stderr}`;
        } catch (error) {
          opencodeHelpError = error;
        }
        if (opencodeHelpText !== null) {
          try {
            validateOpencodeReviewSupport(opencodeHelpText, { profile: opencodeProfile });
          } catch (drift) {
            printValue({
              ok: true, provider: provider.id, taskIntent: 'review',
              accessProfile: 'review-readonly',
              installed: true, version, authenticated,
              policySupported: true, canaryProven, taskReady: false,
              supported: false,
              code: 'PROVIDER_CAPABILITY_DRIFT',
              reason: drift.message,
              missing: drift.details?.missing ?? ['reviewer flags'],
              mapping: { agent: 'build', profile: opencodeProfile, permissions: 'read-only (edit/write deny, no --auto)' },
            }, json);
            return 0;
          }
          printValue({
            ok: true, provider: provider.id, taskIntent: 'review',
            accessProfile: 'review-readonly',
            installed: true, version, authenticated,
            policySupported: true, canaryProven, taskReady: true,
            supported: true,
            code: null, reason: null, missing: [],
            mapping: { agent: 'build', profile: opencodeProfile, permissions: 'read-only (edit/write deny, no --auto)' },
          }, json);
          return 0;
        }
        printValue({
          ok: true, provider: provider.id, taskIntent: 'review',
          accessProfile: 'review-readonly',
          installed: true, version, authenticated,
          policySupported: true, canaryProven, taskReady: false,
          supported: false,
          code: opencodeHelpError?.code === 'CLI_NOT_INSTALLED' ? 'CLI_NOT_INSTALLED' : 'PROVIDER_CAPABILITY_DRIFT',
          reason: opencodeHelpError ? `opencode help probe failed: ${opencodeHelpError.code || 'probe failed'}` : 'opencode help probe failed',
          missing: ['version-probed reviewer flags'],
          mapping: { agent: 'build', profile: opencodeProfile, permissions: 'read-only (edit/write deny, no --auto)' },
        }, json);
        return 0;
      }
    }
    printValue({ ok: true, provider: providerMeta }, json, (value) => JSON.stringify(value.provider, null, 2));
    return 0;
  }
  if (command === 'models' && subcommand === 'list') {
    const provider = options.provider;
    const models = await listModels(provider, { env });
    printValue({ ok: true, provider, models }, json, (value) => value.models.join('\n'));
    return 0;
  }
  if (command === 'models' && subcommand === 'inspect') {
    const providerId = options.provider;
    const provider = getProvider(providerId);
    const described = describeModel(providerId, options.model);
    printValue(
      { ok: true, ...described, capabilities: { ...provider.capabilities } },
      json,
    );
    return 0;
  }
  if (command === 'agents' && subcommand === 'list') {
    const provider = options.provider;
    const agents = await listAgents(provider, { env });
    printValue({ ok: true, provider, agents }, json, (value) => value.agents.join('\n'));
    return 0;
  }
  if (command === 'tools' && subcommand === 'describe') {
    const payload = { ok: true, packageVersion: packageJson.version, ...describeTools() };
    printValue(payload, json);
    return 0;
  }
  if (command === 'generate') {
    const genInput = generateInput(options);
    if (isTrueFlag(genInput.dryRun ?? options['dry-run'])) {
      if (isTrueFlag(genInput.stream) || isTrueFlag(genInput.events)) {
        throw new AiCliError('INVALID_INPUT', 'stream/events are not supported for dry-run', { exitCode: 2 });
      }
      const { dryRun: _ignored, stream: _s, events: _e, streamTo: _st, ...dryArgs } = genInput;
      const preview = describeGenerateDryRun({ ...dryArgs, env });
      printValue(preview, json);
      return 0;
    }
    // --stream-to stderr (default) keeps stdout to exactly one machine-readable
    // JSON envelope. --stream-to stdout is for orchestrators that only capture
    // stdout: live bytes/lines and the final envelope share stdout, so in
    // --json mode the envelope is printed compact on one line (parse it as the
    // last JSON line carrying an `ok` field).
    const streamTarget = genInput.streamTo == null || genInput.streamTo === ''
      ? 'stderr'
      : String(genInput.streamTo).trim().toLowerCase();
    if (streamTarget !== 'stderr' && streamTarget !== 'stdout') {
      throw new AiCliError('USAGE_ERROR', `--stream-to must be stderr or stdout, got: ${String(genInput.streamTo)}`, { exitCode: 2 });
    }
    const liveOut = streamTarget === 'stdout' ? process.stdout : process.stderr;
    const writeLive = (text) => {
      try {
        liveOut.write(text);
      } catch {
        // A clogged live channel must not fail the generation.
      }
    };
    // --stream: provider stdout/stderr bytes go live as they arrive.
    const onStream = isTrueFlag(genInput.stream) ? ({ chunk }) => writeLive(chunk) : undefined;
    // --events: one advisory JSON object per line.
    const onEvent = isTrueFlag(genInput.events) ? (event) => {
      writeLive(`${JSON.stringify({ event: 'webmcp-ai-event', ...event })}\n`);
    } : undefined;
    const result = await generate({
      ...genInput, env,
      ...(onStream ? { onStream } : {}),
      ...(onEvent ? { onEvent } : {}),
    });
    const liveActive = isTrueFlag(genInput.stream) || isTrueFlag(genInput.events);
    if (streamTarget === 'stdout' && json) {
      // Provider bytes may not end with a newline; force the envelope onto
      // its own last line so orchestrators can parse it as the final line
      // carrying an `ok` field.
      process.stdout.write(`\n${JSON.stringify(result)}\n`);
      return 0;
    }
    if (streamTarget === 'stdout' && !json && liveActive) {
      // Text mode shares stdout between live provider bytes and the final
      // text. Provider bytes may not end with a newline, so force the final
      // text onto its own line with a deterministic leading newline.
      // Default stderr target is unaffected (live on stderr, final on stdout).
      process.stdout.write(`\n${result.response.text}\n`);
      return 0;
    }
    printValue(result, json, (value) => value.response.text);
    return 0;
  }
  if (command === 'review') {
    const reviewIn = reviewInput(options);
    const { dryRun, ...reviewArgs } = reviewIn;
    if (dryRun) {
      // Sanitized inspection reuses the exact review resolver; never spawns.
      const preview = describeReviewDryRun({ ...reviewArgs, env });
      printValue(preview, json);
      return 0;
    }
    const result = await review({ ...reviewArgs, env });
    printValue(result, json, (value) => `${value.review.verdict}\n${value.review.summary ?? ''}`.trim());
    return 0;
  }
  if (command === 'tool-call') {
    let request;
    try {
      request = readJsonInput('-');
      const result = await handleToolCall(request, { env });
      printValue(result, true);
      return 0;
    } catch (error) {
      // A failed webmcp-tool-v1 call must still return a protocol-shaped
      // envelope so callers can correlate the failure by requestId.
      const typed = asAiCliError(error);
      printValue({
        protocol: TOOL_PROTOCOL,
        requestId: typeof request?.requestId === 'string' ? request.requestId : null,
        ok: false,
        error: typed.toJSON(),
      }, true);
      return typed.exitCode;
    }
  }

  if (command === 'orchestration') {
    const orchestrationMod = await loadOrchestrationCompanion(env);
    const orchestration = orchestrationMod.createOrchestrationClient({ env });
    if (subcommand === 'capabilities') {
      printValue(orchestration.capabilities(), json);
      return 0;
    }
    if (subcommand === 'guide') {
      const format = options.format === 'json' ? 'json' : 'markdown';
      const guide = orchestration.guide({ format });
      if (format === 'json') printValue({ ok: true, ...guide }, true);
      else process.stdout.write(`${guide}\n`);
      return 0;
    }
    if (subcommand === 'create' || subcommand === 'call') {
      const inputPath = options['input-json'];
      if (!inputPath) throw new AiCliError('USAGE_ERROR', '--input-json <path|-> is required', { exitCode: 2 });
      const coordinationId = options.coordination;
      if (subcommand === 'call' && !coordinationId) {
        throw new AiCliError('USAGE_ERROR', '--coordination <coord-id> is required for orchestration call', { exitCode: 2 });
      }
      const request = readJsonInput(inputPath);
      const response = subcommand === 'create'
        ? await orchestration.create(request)
        : await orchestration.call(coordinationId, request);
      printValue(response, true);
      if (response.ok) return 0;
      return ['ORCHESTRATION_INVALID_INPUT', 'ORCHESTRATION_UNSUPPORTED_VERSION', 'USAGE_ERROR']
        .includes(response.error?.code) ? 2 : 1;
    }
    if (subcommand === 'prune') {
      printValue(await orchestration.prune(), json);
      return 0;
    }
    throw new AiCliError('USAGE_ERROR', `Unknown orchestration subcommand: ${String(subcommand)}`, { exitCode: 2 });
  }

  throw new AiCliError('USAGE_ERROR', `Unknown command: ${argv.slice(0, 2).join(' ')}`, { exitCode: 2 });
}

export async function main() {
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes('--json') || argv[0] === 'tool-call';
  try {
    process.exitCode = await runCli(argv, process.env);
  } catch (error) {
    const typed = asAiCliError(error);
    const payload = { ok: false, error: typed.toJSON() };
    if (wantsJson) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stderr.write(`${typed.code}: ${typed.message}\n`);
    process.exitCode = typed.exitCode;
  }
}
