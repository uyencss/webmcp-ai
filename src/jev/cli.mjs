// M1 `webmcp-jev` command surface: help and doctor only. Help and doctor
// never spawn a provider binary. Unknown subcommands exit 2 and stay inside
// the jev route (no Browser fallback). Later milestones add query,
// browser-step, captcha and canary subcommands here.
import { jevDoctor } from './doctor.mjs';

export const JEV_COMMAND_NAME = 'webmcp-jev';

export function jevHelpText(commandName = JEV_COMMAND_NAME) {
  return `${commandName} — WebMCP Jev decision runtime

Usage:
  ${commandName} <command> [options]
  ${commandName} doctor [--json]
  ${commandName} --version

Commands:
  doctor      Report runtime readiness (no provider model call)
  help        Print this help

Exit codes:
  0  help, version, or doctor succeeded
  2  unknown subcommand (never falls back to another route)
`;
}

function isHelpToken(token) {
  return token === '--help' || token === '-h' || token === 'help';
}

export async function runJevCli(argv = process.argv.slice(2), env = process.env) {
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
  process.stderr.write(`Unknown jev command: ${command}\n`);
  return 2;
}
