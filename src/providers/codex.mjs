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
    toolPolicies: ['provider-default', 'compose-only'],
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

    // Full passthrough (opt-in via --full): explicit workspace-write sandbox.
    // Omitting the sandbox would fall back to the config default (usually
    // read-only), so full must state workspace-write to get real folder +
    // tool access. danger-full-access is never used.
    // Truthful scope: full still passes --ephemeral --ignore-user-config
    // --ignore-rules, so ambient user config/MCP is NOT inherited — only the
    // workspace-write sandbox (folder + tools) is granted. Only the opencode
    // provider keeps ambient operator config/MCP in full mode.
    // Resume limitation (codex 0.152.1): `exec resume` rejects --sandbox/-s
    // and --color, so the resume path expresses the same sandbox via
    // `-c sandbox_mode="..."` (accepted on both exec and resume) and omits
    // --color. Bounded resume stays read-only; full resume stays
    // workspace-write.
    const isFull = request.accessProfile === 'full';
    const sandboxMode = isFull ? 'workspace-write' : 'read-only';
    const shared = [
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--output-last-message', outputFile,
      ...(schemaFile ? ['--output-schema', schemaFile] : []),
      ...(request.model ? ['--model', request.model] : []),
      ...(request.effort ? ['-c', `model_reasoning_effort="${request.effort}"`] : []),
    ];

    const args = request.sessionId
      ? ['exec', 'resume', '-c', `sandbox_mode="${sandboxMode}"`, ...shared, request.sessionId, '-']
      : ['exec', '--sandbox', sandboxMode, ...shared, '--color', 'never', '-'];

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
