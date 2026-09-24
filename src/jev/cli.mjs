// M2 `webmcp-jev` command surface: help, doctor, query and canary.
// Help and doctor never spawn a provider binary. query validates the request
// offline and fails closed without a server-side key (no network, no quota
// spent). canary is opt-in only and stays BLOCKED while Gate 0 is unattested.
// Unknown subcommands exit 2 and stay inside the jev route (no Browser
// fallback).
import { readFileSync } from 'node:fs';
import { jevDoctor } from './doctor.mjs';
import { validateRequest } from './schemas.mjs';
import { createJevClient } from './client.mjs';
import { readKeyFile } from './transport.mjs';
import { asAiCliError, AiCliError } from '../errors.mjs';
import { decideFallback, guardAction, CONTROL_OPERATIONS } from './policy/policy.mjs';
import { resolveRolloutConfig } from './policy/rollout.mjs';

export const JEV_COMMAND_NAME = 'webmcp-jev';

// Frozen M2 model pin: the only model the CLI dispatches to unless --model
// overrides it explicitly. The skill digest pin defaults to null (unpinned)
// and is passed through when --skill-digest is given.
export const JEV_PINNED_MODEL = 'jev-1.13.0';

export function jevHelpText(commandName = JEV_COMMAND_NAME) {
  return `${commandName} — WebMCP Jev decision runtime

Usage:
  ${commandName} <command> [options]
  ${commandName} doctor [--json]
  ${commandName} query --request <path> [--key-file <path> --base-url <url> --model <model> --skill-digest <digest>]
  ${commandName} canary [--live]
  ${commandName} --version

Commands:
  doctor      Report runtime readiness (no provider model call)
  query       Validate a request offline, then dispatch via TypeSafe (needs server-side key)
  canary      Bounded live probe (opt-in only, never runs by default)
  help        Print this help

Exit codes:
  0  help, version, or doctor succeeded
  1  typed Jev failure (CODE: message on stderr, no silent fallback)
  2  unknown subcommand (never falls back to another route)
`;
}

export function jevCanaryHelpText(commandName = JEV_COMMAND_NAME) {
  return `${commandName} canary — bounded live TypeSafe probe (opt-in only)

Usage:
  ${commandName} canary --help
  ${commandName} canary --live --attest-gate0 --key-file <path> --base-url <url>

Gate 0 attestation is an explicit operator act: pass --attest-gate0 only
when the TypeSafe key rotation is attested. Without --live this command
exits 2 and performs no network call. With --live but without --attest-gate0
it exits 1 BLOCKED_BY_GATE0 and performs no network call. With both it
dispatches one bounded request (frozen pin ${JEV_PINNED_MODEL}, no retries)
through the mode-0600 key file, and prints the advisory result as JSON.
`;
}

export function jevQueryHelpText(commandName = JEV_COMMAND_NAME) {
  return `${commandName} query — dispatch one Jev request via TypeSafe

Usage:
  ${commandName} query --request <path> [--key-file <path> --base-url <url> --model <model> --skill-digest <digest>]

The request file must match webmcp-jev-request/1. It is validated offline
first; without a server-side key the command fails closed with
JEV_CONFIG_MISSING and never touches the network. Pass --key-file (a
mode-0600 file — the only wired key source in M2; a vault-broker first
source is an M3 open item) together with --base-url to dispatch via the
bounded TypeSafe transport. --model defaults to the frozen pin
(${JEV_PINNED_MODEL}); --skill-digest pins the expected skill digest and is
passed into the client so the finding-9 pin runs on the CLI path.
`;
}

function isHelpToken(token) {
  return token === '--help' || token === '-h' || token === 'help';
}

function writeErrorAndCode(error, policyEvaluation = null) {
  const typed = asAiCliError(error);
  process.stderr.write(`${typed.code}: ${typed.message}\n`);
  const evaluation = policyEvaluation ?? typed.details?.policyEvaluation;
  if (evaluation) {
    process.stderr.write(`${JSON.stringify({ policyEvaluation: evaluation })}\n`);
  }
  return typed.exitCode || 1;
}

export function wireFallbackPolicy({ request, error, circuit = 'closed', env = process.env } = {}) {
  const typed = asAiCliError(error);
  const failureCode = typed.code;
  const circuitState = typed.details?.fallback?.circuit ?? circuit ?? 'closed';

  let flags;
  let cohort;
  try {
    const rollout = resolveRolloutConfig({ env });
    flags = rollout.flags;
    cohort = rollout.cohort;
  } catch {
    const killSwitch = env?.JEV_FAST_PATH_DISABLED === '1' ||
      env?.JEV_FAST_PATH_DISABLED === 'true' ||
      (Boolean(env?.JEV_FAST_PATH_DISABLED) && env?.JEV_FAST_PATH_DISABLED !== '0' && env?.JEV_FAST_PATH_DISABLED !== 'false');
    const enabled = !(env?.JEV_ENABLED === 'false' || env?.JEV_ENABLED === '0');
    flags = { enabled, killSwitch };
  }

  let policyEvaluation = null;
  try {
    policyEvaluation = decideFallback({
      kind: request?.kind ?? 'query',
      fallbackPolicy: request?.fallbackPolicy ?? 'normal-agent',
      failure: failureCode,
      circuit: circuitState,
      attempts: 2,
      maxAttempts: 2,
      flags,
      cohort: cohort ?? undefined,
      urlOrigin: request?.state?.urlOrigin,
    });
  } catch {
    // Fail-safe: if decideFallback throws for any reason, do not crash error reporting
  }

  if (policyEvaluation) {
    if (!typed.details) typed.details = {};
    typed.details.policyEvaluation = policyEvaluation;

    // Fail-safe override: if M6 disagrees with M2 directive route, M6 verdict MUST win
    if (typed.details.fallback && policyEvaluation.engine && policyEvaluation.engine !== typed.details.fallback.decisionEngine) {
      typed.details.fallback = {
        ...typed.details.fallback,
        decisionEngine: policyEvaluation.engine,
      };
    }
  }

  return { typed, policyEvaluation };
}

export function wireSuccessPolicy({ request, result, circuit = 'closed', env = process.env, permit = null, snapshot = null } = {}) {
  let rollout = { flags: { enabled: true, killSwitch: false }, cohort: null };
  try {
    rollout = resolveRolloutConfig({ env });
  } catch (error) {
    const typed = asAiCliError(error);
    return { allowed: false, typed, policyEvaluation: null };
  }
  const { flags, cohort } = rollout;

  let decision = null;
  try {
    decision = decideFallback({
      kind: request?.kind ?? 'query',
      fallbackPolicy: request?.fallbackPolicy ?? 'normal-agent',
      failure: null,
      circuit,
      attempts: result?.timing?.attempts ?? 1,
      maxAttempts: 2,
      flags,
      cohort: cohort ?? undefined,
      urlOrigin: request?.state?.urlOrigin,
    });
  } catch (err) {
    const typed = asAiCliError(err);
    return { allowed: false, typed, policyEvaluation: null };
  }

  let operation = null;
  if (result?.answers?.operation?.choice) {
    operation = result.answers.operation.choice;
  } else if (typeof result?.answers?.operation === 'string') {
    operation = result.answers.operation;
  }

  const isCompletionClaim = operation === 'DONE' ||
    Object.values(result?.answers ?? {}).some((a) => a?.choice === 'DONE');

  const effectiveSnapshot = snapshot ?? (request?.state?.snapshotDigest ? {
    expectedDigest: request.state.snapshotDigest,
    observedDigest: request.state.snapshotDigest,
  } : null);

  const effectivePermit = permit ?? (request?.caller?.permitId ? {
    allowed: true,
    permitId: request.caller.permitId,
  } : null);

  let guard = null;
  try {
    guard = guardAction({
      decision,
      operation,
      snapshot: effectiveSnapshot,
      permit: effectivePermit,
    });
  } catch (err) {
    const typed = asAiCliError(err);
    return { allowed: false, typed, policyEvaluation: null };
  }

  const wouldDriveExecution = (operation != null && !CONTROL_OPERATIONS.includes(operation)) ||
    (request?.kind === 'browser-step' && operation !== 'DONE' && operation !== 'WAIT' && operation !== 'BLOCKED');

  const guardRefuses = guard && (guard.allowed === false || guard.action === 'blocked' || guard.action === 'human');
  const decisionRefuses = decision && (decision.engine === 'blocked' || decision.engine === 'human' || decision.engine !== 'jev');

  const shouldBlock = (wouldDriveExecution && guardRefuses) || decisionRefuses;

  const effectiveEngine = shouldBlock
    ? (guard?.action === 'blocked' || decision?.engine === 'blocked' ? 'blocked' : (guard?.action === 'human' || decision?.engine === 'human' ? 'human' : decision?.engine))
    : decision.engine;

  const effectiveReason = shouldBlock
    ? (guard?.reason ?? decision?.reason ?? (effectiveEngine === 'blocked' ? 'BLOCKED' : 'HUMAN_REQUIRED'))
    : null;

  const policyEvaluation = {
    ...decision,
    decision,
    guard,
    completionClaim: isCompletionClaim,
    engine: effectiveEngine,
    reason: effectiveReason,
  };

  if (shouldBlock) {
    const refusalCode = effectiveReason ?? (effectiveEngine === 'blocked' ? 'BLOCKED' : 'HUMAN_REQUIRED');
    const message = `policy evaluation refused execution: ${effectiveEngine} (${refusalCode})`;
    const typed = new AiCliError(refusalCode, message, { details: { policyEvaluation } });
    return { allowed: false, typed, result, policyEvaluation };
  }

  return { allowed: true, result, policyEvaluation };
}

function readRequestFile(path) {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw);
}

function flagValue(args, flag) {
  const at = args.indexOf(flag);
  if (at === -1) return null;
  const value = args[at + 1];
  return typeof value === 'string' && !value.startsWith('--') ? value : null;
}

export async function runQuery(rest, { env = process.env, ...deps } = {}) {
  if (rest.some(isHelpToken) || !rest.includes('--request')) {
    process.stdout.write(jevQueryHelpText());
    return 0;
  }
  const path = flagValue(rest, '--request');
  if (!path) {
    process.stderr.write('JEV_REQUEST_INVALID: query requires --request <path>\n');
    return 1;
  }
  let request = null;
  try {
    request = readRequestFile(path);
  } catch {
    // Fixed message (round 5 N3): the parser error carries a source excerpt
    // on recent Node, so a secret inside a malformed file would reach
    // stderr. No parser detail in user-facing output.
    process.stderr.write('JEV_REQUEST_INVALID: cannot read request file (unreadable or malformed JSON)\n');
    return 1;
  }
  try {
    validateRequest(request);
  } catch (error) {
    return writeErrorAndCode(error);
  }
  // Explicit key wiring (finding 1, corrected M2-R5): --key-file (mode-0600)
  // is the ONLY wired key source in M2. A vault-broker first source is not
  // wired anywhere; it is recorded as an M3 open item. Without both
  // --key-file and --base-url the command fails closed here and never
  // touches the network.
  const keyFile = flagValue(rest, '--key-file');
  const baseUrl = flagValue(rest, '--base-url');
  if (!keyFile || !baseUrl) {
    process.stderr.write('JEV_CONFIG_MISSING: jev api key is missing: provide it explicitly via a mode-0600 --key-file (vault broker is an M3 open item)\n');
    return 1;
  }
  let apiKey = null;
  try {
    apiKey = readKeyFile(keyFile);
  } catch (error) {
    return writeErrorAndCode(error);
  }
  // The finding-9 pin runs on the CLI path (M2-R6): --model defaults to the
  // frozen pin and --skill-digest (null when absent) is passed through.
  const model = flagValue(rest, '--model') ?? JEV_PINNED_MODEL;
  const skillDigest = flagValue(rest, '--skill-digest');
  let client = null;
  try {
    client = createJevClient({ baseUrl, apiKey, model, skillDigest, ...deps });
    const { result } = await client.query(request);
    const circuitState = client?.getCircuitState?.() ?? 'closed';
    const { allowed, typed, policyEvaluation } = wireSuccessPolicy({ request, result, circuit: circuitState, env });

    if (!allowed) {
      return writeErrorAndCode(typed, policyEvaluation);
    }

    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (policyEvaluation) {
      process.stderr.write(`${JSON.stringify({ policyEvaluation })}\n`);
    }
    return 0;
  } catch (error) {
    const circuitState = client?.getCircuitState?.() ?? 'closed';
    const { typed, policyEvaluation } = wireFallbackPolicy({ request, error, circuit: circuitState, env });
    return writeErrorAndCode(typed, policyEvaluation);
  }
}

// Minimal bounded probe request for the attested canary path (round 14
// item 2): a valid browser-step with no secrets in it, one question, no
// retries at dispatch time. Fixed content so runs are deterministic.
export function minimalCanaryRequest() {
  const digest = `sha256:${'00'.repeat(32)}`;
  return {
    schema: 'webmcp-jev-request/1',
    requestId: 'canary@live-probe',
    kind: 'browser-step',
    state: {
      snapshotDigest: digest,
      urlOrigin: 'https://example.test',
      goal: 'Canary probe: choose the next operation.',
      elements: [],
      recentActions: [],
    },
    questionSet: { id: 'browser-step', version: 1, digest },
    questions: {
      operation: {
        type: 'choice',
        instructions: { question: 'Choose exactly one next operation.' },
        criteria: { CLICK: null, WAIT: null },
      },
    },
    bounds: { maxStateBytes: 32768, maxQuestions: 8, timeoutMs: 15000, maxRetries: 0 },
    caller: { runId: 'canary', permitId: null },
    fallbackPolicy: 'normal-agent',
  };
}

async function runCanary(rest, { fetchFn = null } = {}) {
  if (rest.some(isHelpToken)) {
    process.stdout.write(jevCanaryHelpText());
    return 0;
  }
  if (!rest.includes('--live')) {
    process.stderr.write('canary is opt-in only: re-run with `canary --live` as an explicit operator action; no network call was made\n');
    return 2;
  }
  // Default stays blocked (round 14 item 2): --live alone never dispatches.
  if (!rest.includes('--attest-gate0')) {
    process.stderr.write('BLOCKED_BY_GATE0: Gate 0 (TypeSafe key rotate) is not attested; canary stays blocked and no live call was made\n');
    process.stderr.write('JEV_CONFIG_MISSING: jev api key is missing: provide it explicitly via a mode-0600 --key-file (vault broker is an M3 open item)\n');
    return 1;
  }
  const keyFile = flagValue(rest, '--key-file');
  const baseUrl = flagValue(rest, '--base-url');
  if (!keyFile || !baseUrl) {
    process.stderr.write('JEV_CONFIG_MISSING: attested canary needs --key-file and --base-url\n');
    return 1;
  }
  let apiKey = null;
  try {
    apiKey = readKeyFile(keyFile);
  } catch (error) {
    return writeErrorAndCode(error);
  }
  try {
    const client = createJevClient({ baseUrl, apiKey, model: JEV_PINNED_MODEL, fetchFn });
    const { result } = await client.query(minimalCanaryRequest());
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    return writeErrorAndCode(error);
  }
}

export async function runJevCli(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const [command, ...rest] = argv;
  if (!command || isHelpToken(command)) {
    process.stdout.write(jevHelpText());
    return 0;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    const payload = await jevDoctor({ env });
    process.stdout.write(`${payload.version}\n`);
    return 0;
  }
  if (command === 'doctor') {
    for (const token of rest) {
      if (!isHelpToken(token) && token !== '--json') {
        process.stderr.write(`Unknown jev doctor option: ${token}\n`);
        return 2;
      }
    }
    if (rest.some((token) => isHelpToken(token))) {
      process.stdout.write(jevHelpText());
      return 0;
    }
    const payload = await jevDoctor({ env });
    if (rest.includes('--json')) {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      const lines = [
        `${JEV_COMMAND_NAME} doctor`,
        `version: ${payload.version}`,
        `route: ${payload.route}`,
        `bin: ${payload.bin}`,
        `envOverrideUsed: ${payload.envOverrideUsed}`,
        `provider.installed: ${payload.provider.installed}`,
        `provider.authenticated: ${payload.provider.authenticated}`,
        `provider.canary: ${payload.provider.canary}`,
      ];
      process.stdout.write(`${lines.join('\n')}\n`);
    }
    return 0;
  }
  if (command === 'query') {
    return runQuery(rest, { env, ...deps });
  }
  if (command === 'canary') {
    return runCanary(rest, deps);
  }
  process.stderr.write(`Unknown jev command: ${command}\n`);
  return 2;
}
