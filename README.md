# webmcp-ai

`webmcp-ai` provides one safe, provider-neutral command for invoking locally
installed AGY, Claude Code, Codex, and opencode CLIs. It is independent from
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

## Orchestration companion package

The durable Coordination runtime is released separately as
`@gyga-browser/webmcp-ai-orchestration`; this package now owns only the
provider-neutral one-shot/review wrapper and `webmcp-tool-v1` protocol.

```bash
npm install @gyga-browser/webmcp-ai-orchestration
webmcp-ai-orchestration capabilities --json
webmcp-ai-orchestration guide --format markdown
```

The legacy `webmcp-ai orchestration ...` command remains a lazy compatibility
shim. It loads the companion package only at that command boundary and returns
typed `ORCHESTRATION_PACKAGE_REQUIRED` when the companion is not installed;
one-shot and review commands never load supervisor code.

The companion package owns the machine-local state root, supervisor, journal,
IPC, adapters, verifier, canary and managed-host runtime. Its fixture-only
alpha adapters and live-canary authorization remain separate from core review
acceptance.

## Commands

```bash
webmcp-ai doctor --json
webmcp-ai preflight --json
webmcp-ai providers list --json
webmcp-ai providers inspect claude --json
webmcp-ai models list --provider agy --json
webmcp-ai models inspect --provider agy --model claude-opus-4-6-thinking --json
webmcp-ai agents list --provider agy --json
webmcp-ai generate --provider claude --prompt-file ./prompt.md --json
webmcp-ai generate --provider codex --prompt-file ./prompt.md --tool-policy compose-only --json
webmcp-ai generate --provider opencode --prompt-file ./prompt.md --json
webmcp-ai tools describe --json
```

Prefer `--prompt-file` or `--input-json -` over `--prompt` so prompts do not
appear in shell history. Claude and Codex prompts are forwarded over stdin. AGY
only documents argument-based print mode, so the AGY adapter enforces a
bounded prompt size.

## Dispatch preflight and per-model facts

`webmcp-ai preflight --json` is a read-only aggregate for multi-lane dispatch:
each provider's installed state and capabilities, the per-provider prompt-size
cap, artifact behavior, and where to query quota — without spawning a provider.
`webmcp-ai models inspect --provider <id> [--model <model>] --json` adds the
per-model facts installed CLIs do not advertise (effort support, prompt cap,
artifact mode). `generate` rejects `--effort` for a model positively known to
refuse it with typed `UNSUPPORTED_EFFORT` before any spawn.

AGY print mode has a 128 KiB prompt cap (`PROMPT_TOO_LARGE` above it) and can
return only a summary while writing the full answer under its brain directory.
Pass `--resolve-artifacts` (optionally `--agy-brain-dir <path>`) to recover the
full text; the envelope then carries `artifacts` (`name`/`bytes`/`digest`, no
machine path) and `artifactsResolved`.

A concurrent `--provider opencode` run can hit the shared SQLite database with
`database is locked`. The wrapper classifies this as retryable
`PROVIDER_DB_LOCKED` and retries with backoff (`--retry-lock <n>`, default 3);
serialize or limit concurrent opencode lanes if it persists.

### OpenCode profiles (v1/v2)

The adapter supports both installed OpenCode majors. Each spawn detects the
profile with one bounded `<bin> --version` probe (no model):

- **v1 (1.x)** — legacy argv (`--dir`, `--variant`) and the v1
  `permission`/`external_directory` config schema; behavior is unchanged.
- **v2 (2.x)** — `--standalone` private server (so the invocation env/config
  apply instead of the shared background service), workspace taken from the
  spawn `cwd` (no `--dir`), variant folded as `--model provider/model#variant`,
  and the v2 ordered `permissions` config schema (`mcp.servers`/`plugins`
  emptied, updates disabled).

An unrecognized major or unparseable version fails closed with typed
`PROVIDER_CAPABILITY_DRIFT` before any argv or temp artifact exists;
`--effort` without a model on v2 is `INVALID_INPUT`. `providers inspect
opencode --task-intent review` reports the detected profile in
`mapping.profile`.

## Capability discovery (agentModes / taskIntents)

Every provider entry from `providers list --json` — and the same
`capabilities` object echoed by `providers inspect <id> --json`,
`models inspect`, `preflight`, and `doctor` — carries the machine-readable
dispatch matrix:

- `capabilities.agentModes`: `{ supported, values, default, reason? }` for the
  legacy `generate --agent-mode` lane (AGY/opencode only).
- `capabilities.taskIntents`: one entry per portable intent
  (`review|compose|implement|plan`) with `supported`, the accepted
  `accessProfile`/`accessProfiles`, `probe` (`help` when the installed binary
  help is probed before spawn), and a typed `reason` when unsupported.

`providers inspect <id> --task-intent compose|implement|plan --json` reports the
declared capability without spawning a provider (`probe: "declared"`, exit 0),
so a caller can choose a route before dispatch; `--task-intent review` keeps the
bounded binary/help probe described above. `plan` is unsupported everywhere
until a separate `webmcp-ai-plan-result/1` contract exists. `tools describe` is
protocol-level and is not a provider capability surface — use the `providers`
discovery for routing decisions.

## Provider quota (external)

Quota is not owned by this wrapper. Query the companion AI Usage Bar service or
its skill before heavy dispatch:

- `GET http://127.0.0.1:8421/api/quotas` (local), `?all=1` (cluster), `/api/devices`
- app: `apps/ai-cli-usage-tray`
- skill: `ai-cli-usage` (`node .agents/skills/ai-cli-usage/scripts/get-quotas.mjs --all --json`)

AGY defaults to `agentMode: "plan"`. A supervised executor that owns its
workspace, policy, cancellation, and output validation may explicitly opt into
`agentMode: "accept-edits"` through JSON stdin or
`--agent-mode accept-edits`. The value is enum-constrained, remains sandboxed,
and never enables dangerous permission bypass. opencode honors the same option
(default `plan`; `accept-edits` adds `--auto` and a bash deny-list); Claude and
Codex reject it.

Migration: prefer portable `taskIntent` (`compose|review|implement|plan`) with
`accessProfile` (`compose-only|review-readonly|bounded-edit|full`) over legacy
`--agent-mode`. Unknown intents fail with `TASK_INTENT_INVALID`;
intent/profile contradictions (including `implement` without
`bounded-edit`/`full`) fail with `TASK_INTENT_ACCESS_CONFLICT` before spawn;
malformed primitives stay `INVALID_INPUT`. `agentMode` remains for `generate`
compatibility but is rejected for `review`. `ai.review` accepts only
`taskIntent: review` with `accessProfile: review-readonly` and returns `schema:
webmcp-ai-review-result/1` (`approve|request-changes|blocked|indeterminate`;
`severity` is `critical|high|medium|low`; findings carry
`id/severity/message/recommendation` with `file`/`line` optional only for
architectural findings; `blocked` requires `blockedReason`; `approve` rejects
`critical`/`high`/`medium`). `plan` needs a separate `webmcp-ai-plan-result/1`
contract and is uniformly rejected. No vNext intent selects native Plan mode:
OpenCode review/compose use the known `build` agent with generated
read-only/deny-all permissions. Claude review uses version-probed `dontAsk`
with `Read,Glob,Grep`, denies `Edit,Write,NotebookEdit`, keeps `safe-mode`,
`--no-chrome` and `--no-session-persistence` (MCP disabled by omission plus
safe-env filtering), never falls back to full, and uses native `stream-json
--verbose` only when events are requested in `generate` (`review`
intentionally disallows `--stream`/`--events`). `review` defaults an omitted
workspace to `cwd` for compatibility (read-only, never written; prefer
explicit). A resumed review sets `resumed:true` and is not fresh
final-auditor evidence. `review`/`plan` accept only `review-readonly`
(`review`+`compose-only` fails `TASK_INTENT_ACCESS_CONFLICT` before any
compose workspace is created; legacy no-`taskIntent` `compose-only` is
unchanged). `providers inspect <id> --task-intent review`
probes each provider's required CLI mapping via the installed
binary/version/help (bounded, read-only, no model) — Claude requires the
reviewer flags, Codex requires `exec`/`--sandbox`/`read-only`/`--ephemeral`/
`--ignore-user-config`/`--ignore-rules`/`--skip-git-repo-check`/
`--output-last-message`/`--color` plus resume
(`resume`/`-c`); the resume sandbox mapping uses config key `sandbox_mode`
and is tested separately, opencode requires `run`/`--format`/`--agent`/
`--model` plus the installed profile syntax (v1 1.x: `--dir` and
`--variant`; v2 2.x: `--standalone`, no `--dir`, variant folded into
`--model provider/model#variant`) with the wrapper read-only config mapping
(`mapping.profile` reports the detected profile) —
and reports `installed`/`authenticated`/`policy-supported`/`canary-proven`/
`task-ready` separately without leaking paths/secrets. Here `task-ready` means
the wrapper's provider mapping is installed and help-proven; it does not claim
authentication or canary acceptance (`authenticated`/`canary-proven` remain
explicitly null/false when unproven). Managed or enterprise
settings may override command-line grants; reviewer flags are requested, not
guaranteed.

```bash
webmcp-ai review --provider opencode --prompt-file ./prompt.md --workspace /abs/ws --json
webmcp-ai review --provider opencode --prompt-file ./prompt.md --workspace /abs/ws --dry-run --json
webmcp-ai providers inspect opencode --task-intent review --json
webmcp-ai generate --provider opencode --prompt-file ./prompt.md --workspace /abs/ws --dry-run --json
```

Use `agent: "webmcp-node-executor"` in JSON input (or
`--agent webmcp-node-executor`) to select a preinstalled AGY custom agent. The
wrapper validates a simple agent name and only selects it; installation and
machine permissions remain the caller's responsibility.

Use `toolPolicy: "compose-only"` (or `--tool-policy compose-only`) only for
pure text composition before any browser, publication, messaging, or paid
action. Compose-only uses a wrapper-owned empty temporary workspace. Codex runs
inside its existing read-only ephemeral sandbox there; AGY receives a
workspace-local deny-all `PreToolUse` hook. The default
`provider-default` policy preserves existing behavior.

For full folder + tool access, pass `--full` (or `accessProfile: "full"`):

```bash
webmcp-ai generate --provider opencode --prompt-file ./prompt.md --workspace /abs/ws --full --json
```

`--full` needs no `--allowed-write-root`/`--protected-path`. Never combine it
with `--tool-policy compose-only`. Without `--full`, all profiles stay
fail-closed. `--full` is an explicit provider workspace/tool access profile
and does not place private keys, credentials, bearer tokens, or machine
identity into model context, child authority env, or portable receipts.
What `--full` grants is provider-specific (do not assume unrestricted ambient
access for non-OpenCode providers): OpenCode (v1 and v2) is the only provider
that keeps the ambient operator config, tools, and MCP surface (the session
database stays isolated to `opencode-cli.db` via `OPENCODE_DB`; v2 additionally
runs its private server via `--standalone`); Codex uses the `workspace-write` sandbox
instead of `read-only` but keeps `--ephemeral --ignore-user-config --ignore-rules`,
so it does not inherit ambient user config/MCP; Claude drops the
`--tools '' --safe-mode` text-only deny; AGY drops the forced `--sandbox`.
The receipt reports `capability.accessProfile: "full"` with
`fullPassthrough: true`. Ambient environment passes through under `--full`
except the authority boundary (the whole `WEBMCP_*` namespace plus
`OPENCODE_SERVER_PASSWORD`, `VAULT_TOKEN`, `VAULT_ADDR`); raise long-output
caps with `--max-output-bytes <n>` (128MB default with `--full`).

Add `--stream` to watch raw provider bytes live as advisory output on stderr by
default while stdout keeps exactly one final JSON envelope (or final response
text). Orchestrators that only capture stdout can pass `--stream-to stdout`:
with `--json`, the final envelope is separated onto its own last line so it can
be parsed by looking for the trailing line with `ok`; in text mode, the final
response text is separated by a leading newline so it cannot concatenate with
raw provider bytes. The default stderr target (`--stream-to stderr`) keeps live
bytes on stderr and final output on stdout. The protocol `tool-call` command
is JSON-over-stdio only and does not support `--stream` or `--stream-to`.
Add `--events` for one advisory progress JSON per line on stderr
(`queued → researching|editing|testing|verifying|working → completed`;
telemetry only, never a control signal).

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

Non-zero provider exits are normalized into stable error codes where possible.
Automation may branch on `error.code`, especially
`PROVIDER_QUOTA_EXHAUSTED`; it must not parse stderr or provider prose.
Authentication failures, rate limits, timeouts, aborts, output limits and
generic exits remain distinct failure classes.

## Safe defaults

- Claude: tools disabled, safe mode, Chrome disabled, non-persistent sessions.
- Codex: read-only sandbox, ephemeral session, user config and rules ignored.
  Explicit resume uses `-c sandbox_mode="read-only"` (or `"workspace-write"`
  with `--full`) and omits unsupported resume flags (`--sandbox`, `--color`);
  `danger-full-access` is never used.
- AGY: sandboxed plan mode; unsafe permission bypass is never enabled.
- AGY `accept-edits` is opt-in for a supervised agent host; plan remains the
  default.
- opencode: read-only `plan` agent with an injected deny-by-default permission
  sandbox; `accept-edits` is opt-in supervised writes with a bash deny-list.
  Both installed profiles are supported (v1 1.x legacy argv/config; v2 2.x
  `--standalone`, `model#variant`, v2 `permissions` schema); an unrecognized
  profile fails closed with `PROVIDER_CAPABILITY_DRIFT`.
- `compose-only`: empty temporary workspace; no task MCP/browser bridge or
  writable project data.
- Resume requires an explicit session ID. There is no implicit “last session”.

Override provider binaries with `AGY_BIN`, `CLAUDE_BIN`, `CODEX_BIN`, or
`OPENCODE_BIN`.
