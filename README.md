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

## Orchestration runtime (alpha)

Beyond one-shot generation, `webmcp-ai` ships an opt-in, machine-local
coordination runtime for supervised CLI-agent lanes: an explicit Coordination
lifecycle, a single-writer supervisor with fenced epochs, an append-only
journal for durable recovery, worker callbacks, and independent acceptance
through `dispatch.verify`.

```bash
webmcp-ai orchestration capabilities --json
webmcp-ai orchestration guide --format markdown
```

The runtime is disabled by default in spirit — nothing runs unless you create
a Coordination. Set `WEBMCP_AI_ORCHESTRATION_DISABLED=1` to hard-disable all
mutations while one-shot commands stay stable. Adapter maturity is honest:
alpha adapters (`owned-process`, `opencode-server`, `claude-stream`,
`codex-exec`) are `fixture-only`, which is not supported; promotion requires
separately authorized live canary receipts.

After separate operator authorization (`WEBMCP_AI_LIVE_CANARY=1` plus a
per-adapter flag), `npm run canary -- <adapter-id>` records a machine-local
receipt that promotes exactly that adapter to `canary-proven` on this machine.

Teardown proof is platform-scoped. On POSIX, `group-stopped` is emitted only
after an independent `kill(-pgid, 0)` probe proves the whole process group is
absent. On Windows, this alpha has no Job Object integration, so the same label
proves only that the single owned process exited; descendant-group absence is
not guaranteed there.

See [skills/webmcp-ai-cli/references/orchestration-runtime.md](skills/webmcp-ai-cli/references/orchestration-runtime.md)
for the operator guide and
[skills/webmcp-ai-cli/references/cli-subagent-orchestration.md](skills/webmcp-ai-cli/references/cli-subagent-orchestration.md)
for the no-runtime coordination brief.

## Commands

```bash
webmcp-ai doctor --json
webmcp-ai providers list --json
webmcp-ai providers inspect claude --json
webmcp-ai models list --provider agy --json
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

AGY defaults to `agentMode: "plan"`. A supervised executor that owns its
workspace, policy, cancellation, and output validation may explicitly opt into
`agentMode: "accept-edits"` through JSON stdin or
`--agent-mode accept-edits`. The value is enum-constrained, remains sandboxed,
and never enables dangerous permission bypass. opencode honors the same option
(default `plan`; `accept-edits` adds `--auto` and a bash deny-list); Claude and
Codex reject it.

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

For full folder + tool access like the native CLI (edits, shell, MCP, web as
the operator configured), pass `--full` (or `accessProfile: "full"`):

```bash
webmcp-ai generate --provider opencode --prompt-file ./prompt.md --workspace /abs/ws --full --json
```

`--full` needs no `--allowed-write-root`/`--protected-path`. Never combine it
with `--tool-policy compose-only`. Without `--full`, all profiles stay
fail-closed. Ambient environment passes through under `--full` except the
authority boundary (the whole `WEBMCP_*` namespace plus
`OPENCODE_SERVER_PASSWORD`, `VAULT_TOKEN`, `VAULT_ADDR`); raise long-output
caps with `--max-output-bytes <n>` (128MB default with `--full`). Add
`--stream` to watch provider output live on stderr while stdout keeps one
JSON envelope.
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
- AGY: sandboxed plan mode; unsafe permission bypass is never enabled.
- AGY `accept-edits` is opt-in for a supervised agent host; plan remains the
  default.
- opencode: read-only `plan` agent with an injected deny-by-default permission
  sandbox; `accept-edits` is opt-in supervised writes with a bash deny-list.
- `compose-only`: empty temporary workspace; no task MCP/browser bridge or
  writable project data.
- Resume requires an explicit session ID. There is no implicit “last session”.

Override provider binaries with `AGY_BIN`, `CLAUDE_BIN`, `CODEX_BIN`, or
`OPENCODE_BIN`.
