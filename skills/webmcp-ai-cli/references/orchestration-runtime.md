# Portable CLI Agent Orchestration Runtime (v0)

Package version: **{{PACKAGE_VERSION}}** · Protocol: `webmcp.ai-orchestration/v0`

This is the opt-in, machine-local coordination runtime for `@gyga-browser/webmcp-ai`.
The stable one-shot commands (`generate`, `tool-call`, `providers`, `doctor`)
remain unchanged and remain valid when the runtime is absent or disabled.

## 0. Two coordination surfaces — pick exactly one per task

| Surface | What it is | When to use it |
| --- | --- | --- |
| **Brief fallback** — [cli-subagent-orchestration.md](cli-subagent-orchestration.md) | An instruction contract for the agent itself: modes, packets, evidence gates. No processes, no state, works with zero installs | The runtime is absent, disabled, or the task is a one-shot handoff |
| **Runtime routing** — this guide | Machine-local supervisor, journal, IPC, adapters, verifier | Multi-step supervised lanes that need durable recovery, fences, and independent acceptance |

The brief is never wrong to follow; the runtime adds durability on top of the
same rules. Do not mix them mid-task: once a Coordination exists, lifecycle
decisions go through its operations, not ad-hoc process spawns.

## 1. CLI surface (alpha)

```bash
webmcp-ai orchestration capabilities --json
webmcp-ai orchestration guide --format markdown
webmcp-ai orchestration create --input-json path-or-dash --json
webmcp-ai orchestration call --coordination coord-id --input-json path-or-dash --json
webmcp-ai orchestration prune --json
```

`create` and `call` accept JSON through a file or stdin. They never accept a
capability token or an arbitrary executable on argv. `call` loads machine-local
authority by explicit Coordination ID; there is no implicit "last" Coordination.

Kill switch: set `WEBMCP_AI_ORCHESTRATION_DISABLED=1` to reject all state
mutation (`create`, `call`, `prune` return `ORCHESTRATION_DISABLED`) while
`capabilities` and `guide` stay readable and every one-shot command keeps
working. No supervisor or state directory is created while disabled.

## 2. Request and response envelopes

Caller request:

```json
{
  "protocol": "webmcp.ai-orchestration/v0",
  "requestId": "req_018f47ad-9af0-7b4e-a3dd-1d3f3d4ef001",
  "operation": "delivery.wait",
  "input": { "afterSequence": 41, "timeoutMs": 30000 }
}
```

Success response:

```json
{
  "protocol": "webmcp.ai-orchestration/v0",
  "requestId": "req_018f47ad-9af0-7b4e-a3dd-1d3f3d4ef001",
  "coordinationId": "coord_018f47ad-9af0-7b4e-a3dd-1d3f3d4ef000",
  "ok": true,
  "result": { "deliveries": [], "lastSequence": 41, "acknowledgedThrough": 41, "timedOut": true }
}
```

Failure responses use `{ ok: false, error: { code, message, retryable, details } }`
with the stable alpha error codes listed in section 8. The CLI injects the
current epoch and a machine-local capability into the IPC request after parsing
caller JSON; neither field is echoed in any response.

Allowed coordinator operations are exactly:

```text
coordination.inspect coordination.transfer coordination.close
task.create task.cancel dispatch.start dispatch.reply dispatch.guidance
dispatch.permission.resolve dispatch.interrupt dispatch.verify
decision-gate.create decision-gate.resolve delivery.wait delivery.ack
```

Retry/rework always uses a new `dispatch.start`; no operation resets or reuses
an old Dispatch identity.

## 3. State roots, modes, tiers

State is machine-local and lives outside repositories, `/tmp` and provider
stores:

```text
darwin:  ~/Library/Application Support/webmcp-ai/orchestration/
linux:   $XDG_STATE_HOME/webmcp-ai/orchestration/  (~/.local/state fallback)
win32:   %LOCALAPPDATA%\webmcp-ai\orchestration\   (fixture-only)
```

Each Coordination directory holds a mode-`0600` manifest, append-only
`events.jsonl`, atomic `snapshot.json`, bounded `refs/`, capability files and
the single-writer `supervisor.lock`. The only state-root override is
`WEBMCP_AI_ORCHESTRATION_STATE_DIR`.

Three orchestration modes exist — `full-handoff`, `delegated-result-return`,
`supervised-orchestration` — across four guarantee tiers:
`native-controlled`, `owned-process`, `attached-observer`, `unsupported`.
A requested mode must satisfy its minimum tier/capability seam before Dispatch
creation; `attached-observer` never satisfies mutable supervised modes and
`unsupported` can never create a Dispatch.

## 4. Coordinator loop

```text
create/reattach by explicit Coordination ID
  → task.create bounded packets
  → delivery.wait (blocking, max 60,000 ms per call)
  → process the entire ordered batch
  → persist effects, then delivery.ack through the processed sequence
  → reply/guide/gate/retry as capability permits
  → independently verify before acceptance
  → close with cleanup recorded
```

Empty waits and timeouts are health checkpoints only. A heartbeat, recent
activity, process exit, or worker completion claim is **never** acceptance.
Only `dispatch.verify` backed by independent workspace/write-set/test evidence
can produce `acceptance_recorded`.

Reattach requires the explicit `coordinationId`. A recovered supervisor replays
the journal, increments its process generation and reuses the same endpoint;
older epochs are fenced with `STALE_COORDINATOR_EPOCH`.

## 5. Provider adapters and maturity honesty

Alpha ships four validated adapters, all `fixture-only`:

| Adapter id | Surface | Guarantees in alpha |
| --- | --- | --- |
| `owned-process` | argv-array child in a owned process group | SIGINT→SIGTERM→SIGKILL ladder, group sweep, bounded output refs; no live events |
| `opencode-server` | Runtime-owned OpenCode `serve` (pinned `1.18.21`) | Per-binding isolated SQLite db, Basic Auth, SSE events, explicit resume, observer-only attach |
| `claude-stream` | Claude Code stream-json | Bounded event mapping, permission gate passthrough |
| `codex-exec` | Codex exec protocol | Terminal evidence mapping, bounded digests |

`dispatch.verify` is the only path to `acceptance_recorded`; it runs
independent workspace/write-set/test evidence through the verifier seam and
never trusts worker claims. Adapter-backed dispatch beyond these adapters —
and every operation on an empty registry — fails closed with
`UNSUPPORTED_CAPABILITY`.

Adapter maturity labels follow evidence, not aspiration:

| Label | Meaning |
| --- | --- |
| `unavailable` | Executable/surface absent or incompatible |
| `fixture-only` | Recorded/fake stream tests pass — this is NOT supported |
| `canary-proven` | Installed-version live scenario passed with receipt |
| `supported` | Full compatibility-range gates passed |

Fixture GREEN is only ever `fixture-only`. OpenCode/Claude/Codex guarantees
follow reported maturity and capabilities output for the installed versions.
Promotion to `canary-proven` requires a separately authorized live canary
receipt; nothing in this package self-promotes.

### Authorized live canaries

```bash
WEBMCP_AI_LIVE_CANARY=1 WEBMCP_AI_LIVE_OWNED=1 npm run canary -- owned-process
WEBMCP_AI_LIVE_CANARY=1 WEBMCP_AI_LIVE_OPENCODE=1 npm run canary -- opencode-server
WEBMCP_AI_LIVE_CANARY=1 WEBMCP_AI_LIVE_CLAUDE=1 npm run canary -- claude-stream
WEBMCP_AI_LIVE_CANARY=1 WEBMCP_AI_LIVE_CODEX=1 npm run canary -- codex-exec
```

Each run needs BOTH the global flag and the per-adapter flag; without them it
fails closed before touching any executable (`CANARY_GATE_CLOSED`). Scenarios
are time-bounded and auth-free by default: `owned-process` proves process
identity plus the terminal ladder on a trivial worker; `opencode-server`
proves bootstrap, health, session lifecycle, isolated-database topology and
clean group stop against the pinned real binary (add `--prompt` for exactly
one bounded model round trip); `claude-stream` / `codex-exec` drive one tiny
stdin prompt through the owned process. A passing run writes a mode-`0600`
receipt under `<stateRoot>/canary/<adapter>.json` binding the adapter digest,
resolved executable path digest and node runtime version; `capabilities --json`
then reports that single adapter as `canary-proven` on this machine only, and
dispatch time re-verifies strictly. Upgrading or moving a provider binary
invalidates its receipt until the canary is re-run.

## 6. Retention and cleanup

Active Coordinations are retained until closed. Abandonment becomes eligible
after seven days without supervisor liveness, proven owned-worker liveness, or
unacknowledged critical Deliveries. Closed state is retained seven days; large
output refs expire after 24 hours. `prune` never signals workers and never
deletes provider-owned sessions or databases.

## 7. Automation Runner boundary

For `execution: runbook`, the Automation Runner remains the sole authority for
enqueue, claim/admission, heartbeat and `runs report`. This runtime never marks
an official Runner run complete.

## 8. Typed errors

`ORCHESTRATION_DISABLED`, `ORCHESTRATION_INVALID_INPUT`,
`ORCHESTRATION_UNSUPPORTED_VERSION`, `COORDINATION_NOT_FOUND`,
`COORDINATION_CLOSED`, `COORDINATION_LOCKED`, `TASK_NOT_FOUND`,
`DISPATCH_NOT_FOUND`, `DECISION_GATE_NOT_FOUND`, `DECISION_GATE_BLOCKING`,
`STALE_COORDINATOR_EPOCH`, `WORKER_IDENTITY_UNPROVEN`,
`WORKER_CALLBACK_UNAUTHORIZED`, `ORCHESTRATION_CURSOR_EXPIRED`,
`ORCHESTRATION_EVENT_GAP`, `WORKER_PROCESS_LOST`, `PERMISSION_REQUIRED`,
`POLICY_DENIED`, `PROVIDER_PROTOCOL_ERROR`, `ORCHESTRATION_INDETERMINATE`,
`JOURNAL_BACKPRESSURE`, `JOURNAL_LIMIT_REACHED`, `JOURNAL_CORRUPT`,
`SNAPSHOT_CORRUPT`, `UNSUPPORTED_CAPABILITY`.
