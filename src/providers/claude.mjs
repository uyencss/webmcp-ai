import { AiCliError } from '../errors.mjs';

export const claudeProvider = {
  id: 'claude',
  name: 'Claude Code',
  envBin: 'CLAUDE_BIN',
  defaultBin: 'claude',
  capabilities: {
    structuredOutput: true,
    stdinPrompt: true,
    explicitResume: true,
    modelDiscovery: false,
  },
  buildInvocation(request) {
    if (request.agentMode) {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'Claude does not support AGY agentMode', {
        exitCode: 2,
      });
    }
    if (request.agent) {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'Claude does not support AGY custom agents', {
        exitCode: 2,
      });
    }
    const args = [
      '-p',
      '--tools', '',
      '--safe-mode',
      '--no-chrome',
      '--output-format', 'json',
      ...(request.sessionId ? ['--resume', request.sessionId] : ['--no-session-persistence']),
      ...(request.model ? ['--model', request.model] : []),
      ...(request.effort ? ['--effort', request.effort] : []),
      ...(request.schema ? ['--json-schema', JSON.stringify(request.schema)] : []),
    ];
    return { args, stdin: request.prompt };
  },
  parseOutput({ stdout }) {
    const trimmed = stdout.trim();
    try {
      const parsed = JSON.parse(trimmed);
      const structured = parsed.structured_output ?? null;
      const rawText = parsed.result ?? parsed.response ?? parsed.text ?? structured ?? '';
      return {
        text: typeof rawText === 'string' ? rawText.trim() : JSON.stringify(rawText),
        structured,
        sessionId: parsed.session_id ? String(parsed.session_id) : null,
      };
    } catch {
      return { text: trimmed, structured: null, sessionId: null };
    }
  },
};
