import { AiCliError } from '../errors.mjs';

const MAX_PROMPT_ARG_BYTES = 128 * 1024;

export const agyProvider = {
  id: 'agy',
  name: 'AGY',
  envBin: 'AGY_BIN',
  defaultBin: 'agy',
  capabilities: {
    structuredOutput: false,
    stdinPrompt: false,
    explicitResume: true,
    modelDiscovery: true,
  },
  buildInvocation(request) {
    if (Buffer.byteLength(request.prompt, 'utf8') > MAX_PROMPT_ARG_BYTES) {
      throw new AiCliError(
        'PROMPT_TOO_LARGE',
        `AGY prompts are limited to ${MAX_PROMPT_ARG_BYTES} bytes because AGY 1.1.1 accepts prompts only as command arguments`,
        { exitCode: 2, details: { maxPromptBytes: MAX_PROMPT_ARG_BYTES } },
      );
    }
    if (request.schema) {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'AGY does not expose structured output in the installed CLI', {
        exitCode: 2,
      });
    }
    const seconds = Math.max(1, Math.ceil(request.timeoutMs / 1000));
    return {
      args: [
        '-p', request.prompt,
        '--sandbox',
        '--mode', 'plan',
        '--print-timeout', `${seconds}s`,
        ...(request.model ? ['--model', request.model] : []),
        ...(request.sessionId ? ['--conversation', request.sessionId] : []),
      ],
      stdin: null,
    };
  },
  parseOutput({ stdout }) {
    return { text: stdout.trim(), structured: null, sessionId: null };
  },
  modelsInvocation: { args: ['models'], stdin: null },
};
