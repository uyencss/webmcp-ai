import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AiCliError } from '../errors.mjs';

export const codexProvider = {
  id: 'codex',
  name: 'Codex CLI',
  envBin: 'CODEX_BIN',
  defaultBin: 'codex',
  capabilities: {
    structuredOutput: true,
    stdinPrompt: true,
    explicitResume: true,
    modelDiscovery: false,
  },
  buildInvocation(request) {
    if (request.agentMode) {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'Codex does not support AGY agentMode', {
        exitCode: 2,
      });
    }
    if (request.agent) {
      throw new AiCliError('UNSUPPORTED_CAPABILITY', 'Codex does not support AGY custom agents', {
        exitCode: 2,
      });
    }
    const dir = mkdtempSync(join(tmpdir(), 'webmcp-ai-codex-'));
    const outputFile = join(dir, 'last-message.txt');
    const schemaFile = request.schema ? join(dir, 'output-schema.json') : null;
    if (schemaFile) writeFileSync(schemaFile, `${JSON.stringify(request.schema, null, 2)}\n`, { mode: 0o600 });

    const common = [
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--color', 'never',
      '--output-last-message', outputFile,
      ...(schemaFile ? ['--output-schema', schemaFile] : []),
      ...(request.model ? ['--model', request.model] : []),
      ...(request.effort ? ['-c', `model_reasoning_effort="${request.effort}"`] : []),
    ];

    const args = request.sessionId
      ? ['exec', 'resume', ...common, request.sessionId, '-']
      : ['exec', '--sandbox', 'read-only', ...common, '-'];

    return {
      args,
      stdin: request.prompt,
      readOutput: () => readFileSync(outputFile, 'utf8'),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  },
  parseOutput({ stdout, invocation }) {
    let text = stdout.trim();
    try {
      text = invocation.readOutput().trim();
    } catch {
      // Fall back to stdout for forward compatibility and test doubles.
    }
    let structured = null;
    try {
      structured = JSON.parse(text);
    } catch {
      // Plain text is a valid response when no schema was requested.
    }
    // Codex `exec` does not echo a resumable session id. Resume is still
    // supported via an explicitly supplied --session-id (obtained out of band),
    // so this adapter never surfaces one to auto-continue.
    return { text, structured, sessionId: null };
  },
};
