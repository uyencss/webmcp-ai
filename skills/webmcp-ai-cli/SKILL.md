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

Coordination runtime routing is owned by the companion package
`@gyga-browser/webmcp-ai-orchestration`; install that package to obtain its
brief/runtime guides and `webmcp-ai-orchestration` CLI. The legacy
`webmcp-ai orchestration …` command is a lazy compatibility shim only and
requires the companion package. This core skill intentionally contains no
supervisor, journal, managed-host or orchestration reference copy.

Read the companion package guide before creating a Coordination. Adapter
maturity is honest and evidence-derived: alpha adapters are `fixture-only`,
which is **not** supported; fixture GREEN never promotes itself.

`webmcp-ai` remains the safe discovery and one-shot/review invocation surface. Without
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

Migration: prefer portable `taskIntent` (`compose|review|implement|plan`) with
`accessProfile` (`compose-only|review-readonly|bounded-edit|full`) over legacy
`agentMode`. Unknown intents fail with `TASK_INTENT_INVALID`;
intent/profile contradictions (including `implement` without
`bounded-edit`/`full`) fail with `TASK_INTENT_ACCESS_CONFLICT` before spawn.
`agentMode` remains for `generate` compatibility but is rejected
for `review`. `ai.review` (`webmcp-ai review`) accepts only `taskIntent: review`
(default) with `accessProfile: review-readonly` and returns
`schema: webmcp-ai-review-result/1` (`approve|request-changes|blocked|
indeterminate`; `severity: critical|high|medium|low`; findings carry
`id/severity/message/recommendation` with `file`/`line` optional only for
architectural findings; `blocked` requires `blockedReason`; `approve` rejects
`critical`/`high`/`medium`). `plan` needs a separate `webmcp-ai-plan-result/1`
contract and is uniformly rejected. No vNext intent selects native Plan mode
(OpenCode review/compose use `build` with generated read-only/deny-all
permissions). Claude review uses version-probed `dontAsk`, `Read,Glob,Grep`,
deny `Edit,Write,NotebookEdit`, `safe-mode`, `--no-chrome`,
`--no-session-persistence`, no MCP, no fallback to full, and native
`stream-json --verbose` only when events are requested in `generate`
(`review` disallows `--stream`/`--events`). Omitted review workspace defaults
to `cwd` read-only (prefer explicit; never written). Resumed reviews set
`resumed:true` and are not fresh final-auditor evidence. `review`/`plan`
accept only `review-readonly` (`review`+`compose-only` fails
`TASK_INTENT_ACCESS_CONFLICT` before any compose workspace is created; legacy
no-`taskIntent` `compose-only` is unchanged). `providers inspect
<id> --task-intent review` probes each provider's required CLI mapping via
installed version/help without model invocation — Claude the reviewer flags,
Codex `exec`/`--sandbox`/`read-only`/`--ephemeral`/`--ignore-user-config`/
`--ignore-rules`/`--skip-git-repo-check`/`--output-last-message`/`--color`
plus resume (`resume`/`-c`); its
resume sandbox mapping uses config key `sandbox_mode` and is tested separately,
opencode `run`/`--format`/`--agent`/`--model` plus the detected profile
syntax (v1 1.x: `--dir`, `--variant`; v2 2.x: `--standalone`, variant folded
as `model#variant`, no `--dir`; `mapping.profile` reports it) with the wrapper
read-only config mapping — and reports
installed/authenticated/policy-supported/canary-proven/
task-ready without leaking paths/secrets. `task-ready` means only that the
wrapper mapping is installed and help-proven; it does not claim authentication
or canary acceptance, which remain separate null/false axes when unproven.
Managed or enterprise settings may
override command-line grants; reviewer flags are requested, not guaranteed.

Provider capability discovery: `providers list --json` (and the same
`capabilities` object echoed by `providers inspect`, `models inspect`,
`preflight`, and `doctor`) exposes `agentModes` plus a `taskIntents` entry for
every portable intent with `supported`, the accepted `accessProfile(s)`,
`probe`, and a typed `reason` when unsupported. `providers inspect <id>
--task-intent compose|implement|plan --json` reports that declaration without
spawning (`probe: declared`, exit 0); `--task-intent review` keeps the bounded
help probe above. `plan` is unsupported everywhere until a separate
`webmcp-ai-plan-result/1` contract exists. `tools describe` is protocol-level,
not a provider capability surface — route decisions belong to the `providers`
discovery.

When the caller depends on a constrained AGY custom agent, pass its discovered
name as `agent` in JSON input or via `--agent`. The AI CLI selects the agent but
does not install it or change machine-level permissions.

## OpenCode profiles (v1/v2)

Every opencode spawn detects the installed profile with one bounded
`<bin> --version` probe (no model). v1 (1.x) keeps the legacy argv
(`--dir`/`--variant`) and v1 `permission`/`external_directory` config. v2
(2.x) runs `--standalone` (private server so the invocation env/config apply
instead of the shared background service), uses the spawn `cwd` as workspace
(no `--dir`), folds effort as `--model provider/model#variant`, and receives
the v2 ordered `permissions` config (`mcp.servers`/`plugins` emptied, updates
disabled). An unrecognized major or unparseable version fails closed with
typed `PROVIDER_CAPABILITY_DRIFT` before any argv or temp artifact exists;
`--effort` without a model on v2 is `INVALID_INPUT`. No profile is guessed
from help text.

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
`--allowed-write-root` or `--protected-path` is needed. `--full` is an explicit
provider workspace/tool access profile and does not place private keys,
credentials, bearer tokens, or machine identity into model context, child
authority env, or portable receipts. What it does is provider-specific (do not
promise unrestricted ambient access for non-OpenCode providers): OpenCode
(v1 and v2) is the only provider that keeps the ambient operator config, tools,
and MCP surface (only the session database stays isolated to `opencode-cli.db`
via `OPENCODE_DB`; v2 additionally runs its private server via `--standalone`);
Codex uses the `workspace-write` sandbox instead of
`read-only` but keeps `--ephemeral --ignore-user-config --ignore-rules`, so it
does not inherit ambient user config/MCP (and explicit resume binds
`-c sandbox_mode="workspace-write"`, never claiming `danger-full-access`);
Claude drops the `--tools '' --safe-mode` text-only deny; AGY drops the forced
`--sandbox`. The receipt reports `capability.accessProfile: "full"` with
`fullPassthrough: true`.

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

Live progress: add `--stream` to forward raw provider stdout/stderr bytes live
to stderr as advisory output (stdout keeps exactly one JSON envelope or final
response text). Without `--stream`, output arrives only once at process exit.
Orchestrators that only capture stdout add `--stream-to stdout` (also applies
to `--events`): in `--json` mode the final envelope prints compact on its own
last line (parse the last line carrying an `ok` field); in text mode, the final
response text is separated by a leading newline so it cannot concatenate with
raw provider bytes. Default stderr target (`--stream-to stderr`) keeps live
bytes on stderr and final output on stdout. The protocol `tool-call` command
is JSON-over-stdio only and does not support `--stream` or `--stream-to`.

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

OpenCode native JSON failures are normalized without raw diagnostics: a native
`provider.no-route` becomes `PROVIDER_NO_ROUTE` with
`details.providerCode: "provider.no-route"`.

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
For OpenCode v2, an explicit override must point to an existing non-empty
database file; a missing or empty override fails closed as
`PROVIDER_STATE_UNINITIALIZED` and is never silently replaced.

V2 (beta) resolves contention architecturally through a background server that
serializes all writes. The wrapper still sets `OPENCODE_DB` on v2 and adds
`--standalone` per spawn, so the private server starts with the invocation
env/config (isolated DB with synchronized credentials, wrapper `permissions`,
empty MCP/plugins) instead of inheriting the shared background service.

## Native AI CLI Matrix & Cheatsheet

For direct native CLI invocations (bypassing the wrapper when needed or running raw shell tasks), refer to the comprehensive cheatsheet at [`docs/native-cli-matrix.md`](../../docs/native-cli-matrix.md). It documents exact 1-shot headless syntax, required non-interactive flags, prompt piping conventions, and output extraction rules for Codex (`gpt-6-sol`, `gpt-5.6-luna`), Claude Code CLI (`claude-opus-5-5`, `opus`), OpenCode v2 (`opencode-go/deepseek-v4.1-flash`), and AGY.

## Safety

- Do not use implicit `--continue` or "last session" behavior.
- Resume only an explicit session ID owned by the current task. Codex
  explicit resume binds the sandbox mode via `-c sandbox_mode="read-only|workspace-write"`
  and omits unsupported resume flags (`--sandbox`, `--color`), never claiming
  `danger-full-access`.
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
