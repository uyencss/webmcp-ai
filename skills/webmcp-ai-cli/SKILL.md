---
name: webmcp-ai-cli
description: Inspect and invoke locally installed AGY, Claude Code, Codex, and OpenCode CLIs through the provider-neutral webmcp-ai command. Use when an agent needs to check provider availability, discover models, generate text or schema-constrained output, invoke ai.generate through the webmcp-tool-v1 JSON protocol, diagnose provider failures, or coordinate bounded CLI-agent work with machine-readable progress and independent acceptance.
---

# WebMCP AI CLI

Names: the published npm package is `@gyga-browser/webmcp-ai` and the executable
is `webmcp-ai`. The `-cli` suffix (this skill and the `webmcp-ai-cli/` directory)
is a repository convention only; nothing you run is named `webmcp-ai-cli`.

Providers vs. agent hosts are two different lists:

- **Providers** (what `webmcp-ai` invokes): `agy`, `claude`, `codex`,
  `opencode`. AGY and opencode are providers but are not install targets.
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

## CLI-agent orchestration

A Coordinator is a portable role held by the agent that owns task assignment,
worker lifecycle, decisions, and acceptance; it is not tied to Codex or any
other provider. Choose a native subagent or CLI worker by the capability and
visibility the task needs.

For spawning, delegating to, or supervising an AI CLI worker, read
[references/cli-subagent-orchestration.md](references/cli-subagent-orchestration.md)
before dispatch. It defines full handoff vs. supervision, exact executable and
model discovery, the task packet, bounded monitoring and intervention, worker
cleanup, and independent verification.

`webmcp-ai` remains the safe discovery and one-shot invocation surface. It
buffers provider output until process exit and does not expose a live
supervision/control stream. When supervision needs provider-native events or
controls, the Coordinator must own the selected installed CLI/server process
and use only its documented interface. Do not silently switch executable,
provider, model, or session after failure.

## Generate

Prefer prompt files or JSON stdin so prompts do not enter shell history:

```bash
webmcp-ai generate \
  --provider claude \
  --model sonnet \
  --prompt-file ./prompt.md \
  --json
```

For structured output, pass a JSON Schema file with `--schema`. AGY 1.1.1 and
opencode do not expose structured output; choose Claude or Codex for
schema-constrained work.

For pure composition before browser/payment/publish actions, pass
`toolPolicy: "compose-only"` in JSON input or `--tool-policy compose-only`.
Compose-only uses a wrapper-owned empty workspace. Codex remains ephemeral and
read-only there; AGY receives a workspace-local deny-all `PreToolUse` hook.

AGY defaults to `agentMode: "plan"`. Use `agentMode: "accept-edits"` only when
the caller is a supervised executor with a pinned workspace, bounded timeout,
cancellation, and strict output/evidence validation. Pass it through JSON stdin
or `--agent-mode accept-edits`; never combine it with dangerous permission
bypass. opencode honors the same `plan`/`accept-edits` option (accept-edits adds
`--auto` plus a bash deny-list); Claude and Codex reject it.

When the caller depends on a constrained AGY custom agent, pass its discovered
name as `agent` in JSON input or via `--agent`. The AI CLI selects the agent but
does not install it or change machine-level permissions.

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

## SQLite database isolation and selection

OpenCode v1 keeps sessions in a single SQLite database (`opencode.db`) that
enforces single-writer access. A shared database can contend when another
OpenCode instance holds the write lock during a concurrent write; contention is
timing-dependent, so not every concurrent run fails with `SQLITE_BUSY`, but a
shared database leaves CLI runs exposed to it.

At OpenCode `1.18.21`, the wrapper's isolated-database behavior is a
version-pinned, source-verified capability: `webmcp-ai` sets `OPENCODE_DB` to
`opencode-cli.db` inside the effective data directory
(`$XDG_DATA_HOME/opencode/`, falling back to `~/.local/share/opencode/`),
separating the CLI namespace from the IDE/default database. Configuration
(`~/.config/opencode/`) stays shared while session histories stay independent.
Sessions created in `opencode.db` do not appear in `opencode-cli.db`, and the
wrapper never searches or migrates sessions across databases automatically.

An explicit `OPENCODE_DB` value in the calling environment is respected as an
operator override. Task JSON and model prompts cannot select the database path.

V2 (beta) resolves contention architecturally through a background server that
serializes all writes.

## Safety

- Do not use implicit `--continue` or "last session" behavior.
- Resume only an explicit session ID owned by the current task.
- Treat provider streams as telemetry, not as control channels; steer, gate, or
  interrupt only through a documented provider seam.
- A worker completion claim is not acceptance. Verify the exact write-set,
  diff, tests, and output contract independently.
- Do not enable unsafe provider permissions unless the user explicitly requires them.
- Use `toolPolicy: "compose-only"` for pure composition stages that must not
  inherit task MCP/browser bridges or writable project data.
- Use `--json` for automation and branch on stable `error.code` values.
- Override provider executables only with `AGY_BIN`, `CLAUDE_BIN`, `CODEX_BIN`,
  or `OPENCODE_BIN`.
- Override the OpenCode database only with `OPENCODE_DB`; the default
  `opencode-cli.db` isolation is intentional.
