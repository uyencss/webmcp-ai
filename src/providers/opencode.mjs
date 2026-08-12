import { AiCliError } from '../errors.mjs';

const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

    let permission;
    let auto = false;
    if (request.toolPolicy === 'compose-only') {
      // Pure text composition: deny every tool and never auto-approve.
      permission = { '*': 'deny' };
    } else if (agentMode === 'accept-edits') {
      // Supervised write mode: read-only tools plus edits and a bash deny-list.
      permission = {
        '*': 'deny',
        read: 'allow',
        grep: 'allow',
        glob: 'allow',
        lsp: 'allow',
        edit: 'allow',
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
      auto = true;
    } else {
      // Default read-only advisor.
      permission = {
        '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', lsp: 'allow',
      };
    }

    const agentName = request.agent || (agentMode === 'accept-edits' ? 'build' : 'plan');
    const args = [
      'run', '--format', 'json', '--agent', agentName,
      ...(auto ? ['--auto'] : []),
      ...(request.model ? ['--model', request.model] : []),
      ...(request.effort ? ['--variant', request.effort] : []),
      ...(request.sessionId ? ['--session', request.sessionId] : []),
      '--dir', request.workspace,
    ];

    return {
      args,
      stdin: request.prompt,
      // The client spreads invocation.env into the process env. Injecting the
      // sandbox config here keeps it off disk and never emits an "ask" value.
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission, share: 'disabled', autoupdate: false }),
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      },
    };
  },
  parseOutput({ stdout }) {
    // opencode --format json emits NDJSON; every event carries the sessionID and
    // assistant prose lives on type:"text" parts. The parser must not depend on a
    // terminal step_finish event (upstream bug #26855 can drop it).
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
};
