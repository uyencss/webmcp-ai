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
and MCP surface (v1 isolates the session database to `opencode-cli.db` for
compatibility; v2 uses the accepted `opencode.db` via `OPENCODE_DB` without
fallback, migration, or copy of legacy databases; v2 additionally runs its
private server via `--standalone`); Codex uses the `workspace-write` sandbox instead of
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

For OpenCode v1, the wrapper's isolated-database behavior is a version-pinned
compatibility capability: `webmcp-ai` sets `OPENCODE_DB` to `opencode-cli.db`
inside the effective data directory (`$XDG_DATA_HOME/opencode/`, falling back to
`~/.local/share/opencode/`), separating the CLI namespace from the IDE/default database.
Configuration (`~/.config/opencode/`) stays shared while session histories stay independent.
Sessions created in `opencode.db` do not appear in `opencode-cli.db`, and the
wrapper never searches or migrates sessions across databases automatically.

For OpenCode v2, WebMCP-managed OpenCode uses the accepted `opencode.db` in the
effective data directory; fallback, migration, or copying of `opencode-cli.db` is
strictly prohibited. For OpenCode v2 an explicit `OPENCODE_DB` value is an operator override that must point
to the accepted `opencode.db`; a missing or empty database fails closed with `PROVIDER_STATE_UNINITIALIZED`
and is never silently replaced or fallen back to another database. Task JSON and model prompts
cannot select the database path.

V2 (beta) resolves contention architecturally through a background server that
serializes all writes. The wrapper sets `OPENCODE_DB` to the accepted `opencode.db`
on v2 and adds `--standalone` per spawn, so the private server starts with the invocation
env/config (wrapper `permissions`, empty MCP/plugins, no legacy DB sync) instead of
inheriting the shared background service.

## Native AI CLI Matrix & Cheatsheet

Bảng tra cứu cú pháp gọi 1-shot headless và quy tắc trích xuất cho các AI CLI trên toàn cụm máy (ATLAS & Mac M1). Mọi Agent có thể sao chép và thực thi ngay mà không cần gọi `--help`:

### 1. Bảng Tổng Hợp Nhanh

| Provider | Model Chủ Lực | CLI Command (Headless 1-Shot) | Input Prompt | Trích Xuất Kết Quả | Lưu Ý Sống Còn |
|---|---|---|---|---|---|
| **Codex** | `gpt-6-sol`<br>`gpt-5.6-luna` | `codex exec --model <m> --sandbox read-only --ephemeral --skip-git-repo-check -c model_reasoning_effort=high -c approval_policy=never --output-last-message <f.md> - < <prompt>` | Stdin + `-` | File `<f.md>` (văn bản sạch) | **BẮT BUỘC** `--skip-git-repo-check` trên Codex 0.155.0+. Thiếu `-` ở cuối sẽ bị treo prompt. |
| **Claude** | `claude-opus-5-5`<br>`claude-sonnet-4-6` | `claude -p --model <m> --effort high --output-format json --restricted < <prompt> > out.json` | Stdin `< prompt` | JSON `.result` | **BẮT BUỘC** `-p` để tránh interactive TUI. `--restricted` tắt tools can thiệp shell/code. |
| **OpenCode** | `opencode-go/deepseek-v4.1-flash`<br>`opencode-go/muse-spark-1.3-contributor` | `opencode run --standalone --format json --agent plan --model <m> < <prompt> > out.json` | Stdin `< prompt` hoặc đối số chuỗi | Stdout text hoặc JSON | **KHÔNG** ép biến `OPENCODE_DB` sang file DB rỗng/chưa sync vì sẽ mất quyền subscription Go models. |
| **AGY** | `gemini-3.8-flash-high`<br>`claude-opus-4-6-thinking` | `node "$AI_CLI" generate --provider agy --model <m> [--effort high] --prompt "..." --json` | `--prompt` hoặc stdin | JSON `response.text` | Claude Opus 4.6 **KHÔNG** hỗ trợ `--effort` (exits 1). Flash hỗ trợ `--effort high`. |
| **WebMCP AI** | Mọi model trên | `node "$AI_CLI" generate --provider <p> --model <m> --prompt-file <f> --json` | `--prompt-file` | JSON `response.text` | Wrapper thống nhất tự động cô lập workspace, auto-sync credentials, chuẩn hóa `error.code`. |

### 2. Mẫu Lệnh Headless 1-Shot Chi Tiết

#### A. Codex CLI (Native)
```bash
# Model: gpt-6-sol (primary reviewer/reasoner) hoặc gpt-5.6-luna (orchestrator)
codex exec \
  --model gpt-6-sol \
  --sandbox read-only \
  --ephemeral \
  --skip-git-repo-check \
  -c model_reasoning_effort=high \
  -c approval_policy=never \
  --output-last-message "/path/to/response.md" \
  - < "/path/to/prompt.txt" > /path/to/events.jsonl 2> /path/to/stderr.log
```
- Phản hồi hoàn chỉnh được ghi vào `--output-last-message`; stdout chứa stream JSONL.

#### B. Claude Code CLI (Native)
```bash
# Model: claude-opus-5-5 (alias opus) hoặc claude-sonnet-4-6
claude -p \
  --model claude-opus-5-5 \
  --effort high \
  --output-format json \
  --restricted \
  < "/path/to/prompt.txt" > "/path/to/out.json" 2> "/path/to/stderr.log"
```
- Đọc nội dung phản hồi tại thuộc tính `.result` trong JSON; kiểm tra `.is_error`.

#### C. OpenCode CLI v2 (Native)
```bash
# Model: opencode-go/deepseek-v4.1-flash hoặc opencode-go/muse-spark-1.3-contributor
# Cách 1 (chuỗi prompt):
opencode run --standalone --model opencode-go/deepseek-v4.1-flash "Nội dung prompt"

# Cách 2 (nhận prompt từ file):
opencode run --standalone --format json --agent plan --model opencode-go/deepseek-v4.1-flash \
  < "/path/to/prompt.txt" > "/path/to/out.json" 2> "/path/to/stderr.log"
```
- Tránh ghi đè `OPENCODE_DB` thủ công; OpenCode v2 quản lý subscription qua bảng `credential` trong `opencode.db`.

#### D. WebMCP AI CLI Wrapper (Thống Nhất Đa Provider)
```bash
# DeepSeek v4.1 Flash:
node "$AI_CLI" generate --provider opencode --model opencode-go/deepseek-v4.1-flash --prompt-file "/path/prompt.txt" --workspace "$PWD" --agent-mode plan --json

# Codex gpt-6-sol:
node "$AI_CLI" generate --provider codex --model gpt-6-sol --effort high --prompt-file "/path/prompt.txt" --json

# Gemini 3.8 Flash (AGY):
node "$AI_CLI" generate --provider agy --model gemini-3.8-flash-high --effort high --prompt-file "/path/prompt.txt" --json
```

### 3. Preflight & Fallback Rules Cho Agent
1. **Kiểm tra Quota**: `node $VIBE_CODE/.agents/skills/ai-cli-usage/scripts/get-quotas.mjs --all --json`
2. **Fallback khi hết Quota**:
   - Codex ATLAS 5h = 0% $\rightarrow$ Route sang Mac M1 (`ssh mac-m1 'codex exec ...'`) hoặc đổi Reviewer L2 sang Claude Opus 5.5 / DeepSeek v4.1 Flash.
   - Claude Weekly < 20% $\rightarrow$ Ưu tiên AGY Claude / Gemini Flash để bảo vệ quota Claude Code CLI.
3. **Lineage Honesty**: Ghi đúng provider/model vào ledger; không ngụy tạo tên route.

## Provider install plan/apply

Use `webmcp-ai providers install` to plan, inspect, or apply pinned provider installations:

```bash
webmcp-ai providers install --plan --json
webmcp-ai providers install --read-back --json
webmcp-ai providers install --apply [--execute] [--receipt <path>] --json
webmcp-ai providers install --host orbit --plan --json
```

- **Version pins**: pinned to active runtime measurements (Claude `2.1.280`, OpenCode `2.0.15`, Codex `0.155.0-alpha.16`, AGY `1.2.9`). Missing pins fail with `PROVIDER_PIN_MISSING`.
- **ORBIT host**: host-scoped plan and read-only inspection only (`authorized: false`). Apply requires explicit owner authorization per host and throws `HOST_SCOPE_NOT_AUTHORIZED` (M3 not authorized).
- **Separation of concerns**: 5 separate layers (binary, model, auth, canary, skill). Installer never performs login, credential extraction, or auth copy. Receipts record package, version, and action; `auth` (`not-assessed`) and `canary` (`not-run`) remain strictly separated from installation receipts.

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
- Override the OpenCode database only with `OPENCODE_DB`; v1 keeps `opencode-cli.db`
  for compatibility while v2 uses the accepted `opencode.db` (never falling back to
  or copying `opencode-cli.db`).
