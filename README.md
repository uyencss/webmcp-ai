# webmcp-ai

`webmcp-ai` provides one safe, provider-neutral command for invoking locally
installed AGY, Claude Code, and Codex CLIs. It is independent from
`webmcp-workflow-cli`; workflows integrate through the versioned
`webmcp-tool-v1` JSON-over-stdio protocol.

## Install

```bash
npm install -g @gyga-browser/webmcp-ai
webmcp-ai doctor --json
```

In this checkout:

```bash
cd packages/webmcp-ai-cli
npm link
```

Install the companion skill for all supported local agents:

```bash
npm run install:agent
```

## Commands

```bash
webmcp-ai doctor --json
webmcp-ai providers list --json
webmcp-ai providers inspect claude --json
webmcp-ai models list --provider agy --json
webmcp-ai generate --provider claude --prompt-file ./prompt.md --json
webmcp-ai tools describe --json
```

Prefer `--prompt-file` or `--input-json -` over `--prompt` so prompts do not
appear in shell history. Claude and Codex prompts are forwarded over stdin. AGY
1.1.1 only documents argument-based print mode, so the AGY adapter enforces a
bounded prompt size.

## Tool protocol

```bash
printf '%s' '{"protocol":"webmcp-tool-v1","requestId":"run-1@compose","tool":"ai.generate","input":{"provider":"claude","prompt":"Write a short summary"}}' \
  | webmcp-ai tool-call --json
```

Successful JSON responses use `ok: true`. Errors use a stable shape:

```json
{
  "ok": false,
  "error": {
    "code": "PROVIDER_TIMEOUT",
    "message": "Provider exceeded the 600000ms timeout",
    "retryable": true
  }
}
```

A failed `tool-call` keeps the protocol envelope, echoing `protocol` and
`requestId` alongside `ok: false` so callers can correlate the failure.

Stdout contains only command output. Provider diagnostics are not copied into
machine-readable errors, preventing accidental secret disclosure.

## Safe defaults

- Claude: tools disabled, safe mode, Chrome disabled, non-persistent sessions.
- Codex: read-only sandbox, ephemeral session, user config and rules ignored.
- AGY: sandboxed plan mode; unsafe permission bypass is never enabled.
- Resume requires an explicit session ID. There is no implicit “last session”.

Override provider binaries with `AGY_BIN`, `CLAUDE_BIN`, or `CODEX_BIN`.
