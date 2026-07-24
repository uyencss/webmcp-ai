---
name: webmcp-ai-cli
description: Inspect and invoke locally installed AGY, Claude Code, and Codex CLIs through the provider-neutral webmcp-ai command. Use when Codex needs to check provider availability, discover AGY models, generate text or schema-constrained output, invoke ai.generate through the webmcp-tool-v1 JSON protocol, or diagnose provider execution failures.
---

# WebMCP AI CLI

Names: the published npm package is `@gyga-browser/webmcp-ai` and the executable
is `webmcp-ai`. The `-cli` suffix (this skill and the `webmcp-ai-cli/` directory)
is a repository convention only; nothing you run is named `webmcp-ai-cli`.

Providers vs. agent hosts are two different lists:

- **Providers** (what `webmcp-ai` invokes): `agy`, `claude`, `codex`. AGY is a
  provider but is not an install target.
- **Agent hosts** (where `install:agent` copies this skill): `codex`, `gemini`,
  `claude`. Gemini is an install host but is not a provider.

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

AGY defaults to `agentMode: "plan"`. Use `agentMode: "accept-edits"` only when
the caller is a supervised executor with a pinned workspace, bounded timeout,
cancellation, and strict output/evidence validation. Pass it through JSON stdin
or `--agent-mode accept-edits`; never combine it with dangerous permission
bypass. Claude and Codex reject this AGY-only option.

## Choose the response interface

Use `generate` for one-shot generation. Use `tool-call` only when the caller
needs the protocol request ID for correlation.

- `generate --json`: require `ok: true`, then consume `response.text`.
- `tool-call --json`: require `ok: true`, then consume `output.text`.
- On failure, read `error.code`; do not parse diagnostics from stderr.

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

Treat stdout as machine-readable output and stderr as diagnostics.

## Safety

- Do not use implicit `--continue` or “last session” behavior.
- Resume only an explicit session ID owned by the current task.
- Do not enable unsafe provider permissions unless the user explicitly requires them.
- Use `--json` for automation and branch on stable `error.code` values.
- Override provider executables only with `AGY_BIN`, `CLAUDE_BIN`, or `CODEX_BIN`.
