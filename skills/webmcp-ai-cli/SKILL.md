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

Two packaged coordination surfaces exist — use exactly one per task:

- **Brief fallback** — [references/cli-subagent-orchestration.md](references/cli-subagent-orchestration.md).
  An instruction contract (full handoff vs supervision, task packet, bounded
  monitoring, cleanup, independent verification). It needs no runtime state
  and stays the correct choice for one-shot handoffs or whenever the runtime
  is absent or disabled.
- **Runtime routing** — [references/orchestration-runtime.md](references/orchestration-runtime.md).
  The opt-in machine-local coordination runtime (`webmcp-ai orchestration …`):
  single-writer supervisor, append-only journal, fenced epochs, worker
  callbacks, and an independent verifier. Use it for multi-step supervised
  lanes that must survive restarts.

Read the brief before any dispatch; read the runtime guide before creating a
Coordination. Adapter maturity is honest and evidence-derived: alpha adapters
are `fixture-only`, which is **not** supported; `capabilities --json` under
`webmcp-ai orchestration` reports the current truth. Fixture GREEN never
promotes itself.

For spawning, delegating to, or supervising an AI CLI worker, read
[references/cli-subagent-orchestration.md](references/cli-subagent-orchestration.md)
before dispatch. It defines full handoff vs. supervision, exact executable and
model discovery, the task packet, bounded monitoring and intervention, worker
cleanup, and independent verification.

`webmcp-ai` remains the safe discovery and one-shot invocation surface. Without
`--stream`/`--events`, it buffers provider output until process exit and does
not expose a live supervision/control stream. With `--stream` (raw provider
bytes) and `--events` (one advisory JSON object per line), progress appears
live on stderr while stdout keeps one JSON envelope; both lanes are advisory
telemetry only, never control/approval/cancellation/acceptance signals.
When supervision needs provider-native events or
controls, either own the selected installed CLI/server process directly and
use only its documented interface, or create a Coordination in the runtime.
Do not silently switch executable, provider, model, or session after failure.

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

## Full access (opt-in passthrough)

When the task needs the provider to run with full folder + tool access,
pass `--full` (or `accessProfile: "full"` in JSON / `tool-call` input):

```bash
webmcp-ai generate \
  --provider opencode \
  --prompt-file ./prompt.md \
  --workspace /abs/ws \
  --full \
  --json
```

`--full` is the only extra input required besides provider/prompt/workspace. No
`--allowed-write-root` or `--protected-path` is needed. What it does is
provider-specific: OpenCode v1 is the only provider that keeps the ambient
operator config, tools, and MCP surface (only the session database stays
isolated to `opencode-cli.db` via `OPENCODE_DB`); Codex uses the
`workspace-write` sandbox instead of `read-only` but keeps `--ephemeral
--ignore-user-config --ignore-rules`, so it does not inherit ambient user
config/MCP; Claude drops the `--tools '' --safe-mode`
text-only deny; AGY drops the forced `--sandbox`. The receipt reports
`capability.accessProfile: "full"` with `fullPassthrough: true`.

Rules: never combine `--full` with `--tool-policy compose-only` (rejected as
`INVALID_INPUT`); `--full` counts as the user's explicit permission grant, so
the "no unsafe permissions" rule below is satisfied by the flag itself, not
bypassed. Without `--full`, every profile stays fail-closed as before.

Environment and output: `--full` passes the ambient environment through like
the native CLI (provider API keys included) except the authority boundary,
which never reaches the child: the entire `WEBMCP_*` namespace (signing,
permit, gateway, runner, vault, worker/callback/orchestration selectors)
plus `OPENCODE_SERVER_PASSWORD`, `VAULT_TOKEN`, and `VAULT_ADDR`.
Long generations can raise the output cap with `--max-output-bytes <n>`
(default 32MB, 128MB with `--full`).

Live progress: add `--stream` to forward provider stdout/stderr bytes to
`webmcp-ai`'s stderr as they arrive (stdout keeps exactly one JSON envelope).
Without `--stream`, output arrives only once at process exit. Orchestrators
that only capture stdout add `--stream-to stdout` (also applies to `--events`;
in `--json` mode the final envelope prints compact on its own last line —
parse it as the last JSON line carrying an `ok` field).

Structured progress: add `--events` for one advisory JSON object per line on
stderr (`{"event":"webmcp-ai-event","seq":N,"state":"researching|editing|\
testing|verifying|working|question|...","summary":"...","provider":"..."}`),
starting with `queued` and ending with `completed|failed|blocked|cancelled`.
States are advisory telemetry only — observe them, never use them for control,
approval, cancellation, or acceptance (never gate, approve, or kill on
them); completion is decided by the final envelope plus independent
verification. `--stream` and `--events` combine freely.

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
