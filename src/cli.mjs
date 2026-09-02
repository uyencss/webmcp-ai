import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  generate, listAgents, listModels, probeProviders,
} from './client.mjs';
import { AiCliError, asAiCliError } from './errors.mjs';
import { listProviders } from './providers/index.mjs';
import { describeTools, handleToolCall, TOOL_PROTOCOL } from './protocol.mjs';
import { createOrchestrationClient } from './orchestration/client.mjs';

const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

export function getCommandName(env = process.env) {
  return env.WEBMCP_AI_COMMAND_NAME || 'webmcp-ai';
}

function helpText(commandName) {
  return `${commandName} — provider-neutral local AI CLI

Usage:
  ${commandName} <command> [options]
  ${commandName} doctor [--json]
  ${commandName} providers list [--json]
  ${commandName} providers inspect <provider> [--json]
  ${commandName} models list --provider <agy|claude|codex|opencode> [--json]
  ${commandName} agents list --provider agy [--json]
  ${commandName} generate --provider <id> (--prompt <text> | --prompt-file <path>) [options]
  ${commandName} generate --input-json <path|-> [--json]
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
  --agent-mode <mode>     AGY/opencode only: plan (default) or accept-edits
  --agent <name>          AGY/opencode only: select a discovered custom agent
  --tool-policy <policy>  provider-default (default) or compose-only (legacy)
  --access-profile <profile>  provider-default, compose-only, review-readonly, bounded-edit, gateway-tool
  --workspace <path>      Trusted working directory for the provider
  --allowed-read-root <path>   Repeatable: additional readable root (absolute)
  --allowed-write-root <path>  Repeatable: writable root inside workspace (absolute)
  --protected-path <path>      Repeatable: protected path inside workspace (overrides writes)
  --project-id <id>       Opaque project binding identifier
  --store-revisions <json> JSON object of store revisions
  --timeout-ms <ms>       Process timeout (default: 600000)
  --json                  Emit stable JSON on stdout

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
    accessProfile: options['access-profile'] ?? fromJson.accessProfile,
    timeoutMs: options['timeout-ms'] ? Number(options['timeout-ms']) : fromJson.timeoutMs,
    workspace: options.workspace ?? fromJson.workspace,
    allowedReadRoots,
    allowedWriteRoots,
    protectedPaths,
    projectId: options['project-id'] ?? fromJson.projectId,
    storeRevisions,
    gatewayCapabilityHandle: options['gateway-capability-handle'] ?? fromJson.gatewayCapabilityHandle,
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
  if (command === 'providers' && subcommand === 'inspect') {
    const id = positional[0] || rest.find((token) => !token.startsWith('--'));
    const provider = listProviders().find((entry) => entry.id === id);
    if (!provider) throw new AiCliError('UNKNOWN_PROVIDER', `Unknown provider: ${id || '(missing)'}`, { exitCode: 2 });
    printValue({ ok: true, provider }, json, (value) => JSON.stringify(value.provider, null, 2));
    return 0;
  }
  if (command === 'models' && subcommand === 'list') {
    const provider = options.provider;
    const models = await listModels(provider, { env });
    printValue({ ok: true, provider, models }, json, (value) => value.models.join('\n'));
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
    const result = await generate({ ...generateInput(options), env });
    printValue(result, json, (value) => value.response.text);
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
    const orchestration = createOrchestrationClient({ env });
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
