import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { generate, listModels, probeProviders } from './client.mjs';
import { AiCliError, asAiCliError } from './errors.mjs';
import { listProviders } from './providers/index.mjs';
import { describeTools, handleToolCall, TOOL_PROTOCOL } from './protocol.mjs';

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
  ${commandName} models list --provider <agy|claude|codex> [--json]
  ${commandName} generate --provider <id> (--prompt <text> | --prompt-file <path>) [options]
  ${commandName} generate --input-json <path|-> [--json]
  ${commandName} tools describe [--json]
  ${commandName} tool-call --json

Generate options:
  --model <model>          Provider model override
  --effort <level>        Provider reasoning/effort override
  --schema <path>         JSON Schema for structured output
  --session-id <id>       Resume only this explicit provider session
  --agent-mode <mode>     AGY only: plan (default) or accept-edits
  --timeout-ms <ms>       Process timeout (default: 600000)
  --workspace <path>      Trusted working directory for the provider
  --json                  Emit stable JSON on stdout

Environment:
  AGY_BIN, CLAUDE_BIN, CODEX_BIN   Override provider executables
`;
}

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
    if (equalAt >= 0) {
      options[token.slice(2, equalAt)] = token.slice(equalAt + 1);
      continue;
    }
    const name = token.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[name] = next;
      index += 1;
    } else {
      options[name] = true;
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

function generateInput(options) {
  const fromJson = options['input-json'] ? readJsonInput(options['input-json']) : {};
  const schema = options.schema ? readJsonInput(options.schema) : fromJson.schema;
  const prompt = options['prompt-file']
    ? readFileSync(options['prompt-file'], 'utf8')
    : (options.prompt ?? fromJson.prompt);
  return {
    ...fromJson,
    provider: options.provider ?? fromJson.provider,
    prompt,
    model: options.model ?? fromJson.model,
    effort: options.effort ?? fromJson.effort,
    schema,
    sessionId: options['session-id'] ?? fromJson.sessionId,
    agentMode: options['agent-mode'] ?? fromJson.agentMode,
    timeoutMs: options['timeout-ms'] ? Number(options['timeout-ms']) : fromJson.timeoutMs,
    workspace: options.workspace ?? fromJson.workspace,
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
  const allArgs = argv.slice(command === 'providers' || command === 'models' || command === 'tools' ? 2 : 1);
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
