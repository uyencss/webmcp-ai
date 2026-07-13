---
name: webmcp-ai-cli
description: Inspect and invoke locally installed AGY, Claude Code, and Codex CLIs through the provider-neutral webmcp-ai command. Use when Codex needs to check provider availability, discover AGY models, generate text or schema-constrained output, invoke ai.generate through the webmcp-tool-v1 JSON protocol, or diagnose provider execution failures.
---

# WebMCP AI CLI

Start with:

```bash
command -v webmcp-ai
webmcp-ai doctor --json
webmcp-ai providers list --json
```

Use the standalone `webmcp-ai` command for workflow and pipeline integration.
The optional `webmcp ai` umbrella bridge is intended for interactive use.

## Generate

Prefer prompt files or JSON stdin so prompts do not enter shell history:

```bash
webmcp-ai generate \
  --provider claude \
  --model sonnet \
  --prompt-file ./prompt.md \
  --json
```

For structured output, pass a JSON Schema file with `--schema`. AGY 1.1.1 does
not expose structured output; choose Claude or Codex for schema-constrained work.

## Tool protocol

Inspect the tool contract before integrating it:

```bash
webmcp-ai tools describe --json
```

Invoke `ai.generate` through JSON stdin:

```bash
printf '%s' '{"protocol":"webmcp-tool-v1","requestId":"run-1@compose","tool":"ai.generate","input":{"provider":"codex","prompt":"Summarize the input"}}' \
  | webmcp-ai tool-call --json
```

Treat stdout as machine-readable output and stderr as diagnostics. Check `ok`
before consuming `output`.

## Safety

- Do not use implicit `--continue` or “last session” behavior.
- Resume only an explicit session ID owned by the current task.
- Do not enable unsafe provider permissions unless the user explicitly requires them.
- Use `--json` for automation and branch on stable `error.code` values.
- Override provider executables only with `AGY_BIN`, `CLAUDE_BIN`, or `CODEX_BIN`.
