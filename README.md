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
webmcp-ai providers install --plan --json
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

### Codex native Git diff review (`reviewTarget`)

`webmcp-ai review` accepts an optional, Codex-only `reviewTarget` that scopes
the review to a Git diff instead of the whole prompt:

```bash
webmcp-ai review --provider codex --prompt-file ./prompt.md --review-target uncommitted --workspace "$PWD" --json
webmcp-ai review --provider codex --prompt-file ./prompt.md --review-target base --review-base main --workspace "$PWD" --json
webmcp-ai review --provider codex --prompt-file ./prompt.md --review-target commit --review-commit HEAD --workspace "$PWD" --json
```

- Exactly one of `{type:"uncommitted"}` / `{type:"base",ref}` /
  `{type:"commit",sha}`; an absent/empty value keeps the ordinary portable
  review lane byte-identical. Any provider other than `codex` fails typed
  `UNSUPPORTED_CAPABILITY`. Combining `reviewTarget` with `--session-id` fails
  typed `TASK_INTENT_ACCESS_CONFLICT` (resume scope is not provable for a
  native diff review). The workspace must be a Git repository (a bounded
  `git rev-parse --show-toplevel` probe fails typed `REVIEW_TARGET_NOT_GIT`
  otherwise). `ai.generate` rejects `reviewTarget` outright — it is review-only.
- **Real-CLI constraint (codex-cli 0.157.1, verified 2026-09-29):** although
  `codex exec review --help` lists `--uncommitted`/`--base`/`--commit`, the
  installed binary refuses to combine any of them with a custom prompt
  (including the `-` stdin marker this wrapper needs to deliver the
  `webmcp-ai-review-result/1` JSON-contract instructions), and even without a
  custom prompt that built-in flow does not honor `--output-schema` (its
  final message is free prose, never the JSON contract). So this wrapper
  never passes `--uncommitted`/`--base`/`--commit` as CLI flags — the scope is
  named in the prompt instead, and the model is instructed to gather the
  actual diff itself via read-only `git diff`/`git show`, run inside
  `-c sandbox_mode="read-only" -c approval_policy="never" --ephemeral
  --ignore-user-config --ignore-rules`. `--sandbox`, `--color`, and
  `--skip-git-repo-check` are never used on this lane.

## Dispatch preflight and per-model facts

`webmcp-ai preflight --json` is a read-only aggregate for multi-lane dispatch:
each provider's installed state and capabilities, the per-provider prompt-size
cap, artifact behavior, and where to query quota — without spawning a provider.
`webmcp-ai models inspect --provider <id> [--model <model>] --json` adds the
per-model facts installed CLIs do not advertise (effort support, prompt cap,
artifact mode). `generate` rejects `--effort` for a model positively known to
refuse it with typed `UNSUPPORTED_EFFORT` before any spawn.

The optional direct Muse route
`openrouter/meta/muse-spark-1.3-contributor` is separately recognized when its
explicit route has been verified. The current evidence proves `high` effort
only; it does not imply authentication, canary acceptance, or support for
other effort values. Keep the historical
`opencode-go/muse-spark-1.3-contributor` route unchanged and never use the bare
`openrouter/muse-spark-1.3-contributor` form.

AGY has two prompt lanes: a prompt at or below 128 KiB uses the `-p` argv
lane; above that it moves transparently to the `--input-format stream-json`
lane (a single NDJSON line on stdin, never in argv) up to a 4 MiB cap
(`PROMPT_TOO_LARGE` above it). AGY print mode can also return only a summary
while writing the full answer under its brain directory. Pass
`--resolve-artifacts` (optionally `--agy-brain-dir <path>`) to recover the
full text; the envelope then carries `artifacts` (`name`/`bytes`/`digest`, no
machine path) and `artifactsResolved`.

AGY (1.2.13+) supports structured output: pass `--schema <path>` and AGY adds
`--output-format json --json-schema <file>` (or, on the stream lane, just
`--json-schema`) natively. A missing `structured_output` in the response when
a schema was requested is a typed `PROVIDER_STRUCTURED_OUTPUT_MISSING`
failure, not a silent success.

A concurrent `--provider opencode` run can hit the shared SQLite database with
`database is locked`. The wrapper classifies this as retryable
`PROVIDER_DB_LOCKED` and retries with backoff (`--retry-lock <n>`, default 3);
serialize or limit concurrent opencode lanes if it persists.

### OpenCode v2-only policy

OpenCode invocations are strictly v2-only. Every opencode spawn detects the
installed binary version with one bounded `<bin> --version` probe (no model):

- **v2 (2.x)** is required — `--standalone` private server (so the invocation env/config
  apply instead of the shared background service), workspace taken from the
  spawn `cwd` (no `--dir`), variant folded as `--model provider/model#variant`,
  and the v2 ordered `permissions` config schema (`mcp.servers`/`plugins`
  emptied, updates disabled).
- Legacy **v1 (1.x)** binaries and explicit `'v1'` overrides are refused before spawn
  with typed `PROVIDER_CAPABILITY_DRIFT` (`OpenCode v1 is not supported; v2 is required`).
  There is no credential sync and no legacy `opencode-cli.db` path.

An unrecognized major or unparseable version fails closed with typed
`PROVIDER_CAPABILITY_DRIFT` before any argv or temp artifact exists;
`--effort` without a model on v2 is `INVALID_INPUT`. `providers inspect
opencode --task-intent review` reports the detected profile in
`mapping.profile`. Dry-run deliberately never spawns a provider binary, so it
cannot auto-detect the installed profile: absent `--opencode-profile` is
reported as `opencodeProfileSource: "unresolved"` and previews with v2 args.
An explicit `--opencode-profile v1` dry-run is refused with typed drift.

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
and is tested separately, opencode requires `run`/`--standalone`/`--format`/`--agent`/
`--model` (v2-only: no `--dir`, variant folded into
`--model provider/model#variant`) with the wrapper read-only config mapping
(`mapping.profile` reports the detected profile; v1 is refused) —
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
access for non-OpenCode providers): OpenCode (v2-only) is the only provider
that keeps the ambient operator config, tools, and MCP surface (all invocations select
the accepted `opencode.db` via `OPENCODE_DB` without fallback, migration, or copy of legacy
databases; OpenCode additionally runs its private server via `--standalone`); Codex uses the `workspace-write` sandbox
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
  OpenCode is v2-only (`--standalone`, `model#variant`, v2 `permissions` schema);
  v1 binaries and explicit v1 overrides are refused with `PROVIDER_CAPABILITY_DRIFT`.
- `compose-only`: empty temporary workspace; no task MCP/browser bridge or
  writable project data.
- Resume and explicit session fork require an explicit session ID (`--session-id <id>`).
  There is no implicit “last session”. `sessionAction` defaults to `resume`;
  specifying `fork` (`--session-action fork`) forks the session natively on
  supported providers (`claude` via `--fork-session`, `opencode` via `--fork`),
  returning `session: { id, resumable, forkedFrom }`. On `agy` and `codex` (unproven
  within call budget), fork requests fail closed with typed `UNSUPPORTED_CAPABILITY`
  rather than degrading silently to resume.
- Review lane keeps the frozen `{ id: null, resumable: false }` envelope (no session
  id or `forkedFrom` leakage).
- Live progress events (`--events`) emit advisory JSON on stderr. On the Codex
  generate lane, events enable native JSONL (`--json`); the final answer is always
  read from `--output-last-message`. Review lane never enables `--json`.

Override provider binaries with `AGY_BIN`, `CLAUDE_BIN`, `CODEX_BIN`, or
`OPENCODE_BIN`.

## Provider install plan/apply

`webmcp-ai providers install` manages provider installation plan and apply workflows:

```bash
webmcp-ai providers install --plan --json
webmcp-ai providers install --read-back --json
webmcp-ai providers install --apply [--execute] [--receipt <path>] --json
webmcp-ai providers install --host orbit --plan --json
webmcp-ai providers install --host m1 --plan --json
```

- **Version pins**: pinned to active runtime measurements (Claude `2.1.283`, OpenCode `2.0.18`, Codex `0.157.1`, AGY `1.2.13`). Missing pins fail with `PROVIDER_PIN_MISSING`.
- **ORBIT host**: host-scoped plan and read-only inspection only (`authorized: false`). Apply requires explicit owner authorization per host and throws `HOST_SCOPE_NOT_AUTHORIZED` (M3 not authorized).
- **m1 host (remote Claude over SSH)**: an operator-declared remote Claude host (SSH alias `mac-pro14`), resolved and probed through `src/remote.mjs` (bounded, read-only `--version`/`--help` over `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes ...`). `plan`/`read-back` report `state: match|drift|missing|unreachable` and never fall back to a local binary; a probe or config failure resolves to `unreachable` rather than throwing. `apply` has no mutation path over SSH and always throws typed `REMOTE_INSTALL_UNSUPPORTED` (`exitCode: 3`). Override the declared host fields with `WEBMCP_AI_CLAUDE_SSH_ALIAS`, `WEBMCP_AI_CLAUDE_REMOTE_BIN`, `WEBMCP_AI_CLAUDE_REMOTE_WORKER`, `WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE` (strictly validated; invalid values fail with typed `CLAUDE_REMOTE_CONFIG_INVALID` and never echo the raw value).
- **Separation of concerns**: 5 separate layers (binary, model, auth, canary, skill). Installer never performs login, credential extraction, or auth copy. Receipts record package, version, and action; `auth` (`not-assessed`) and `canary` (`not-run`) remain strictly separated from installation receipts.
- **Print-mode guard flags**: bounded (non-`full`) AGY and Claude lanes add `--disable-slash-commands` (both providers) and, on the Claude review lane, `--permission-prompts none`, so a prompt cannot expand interactive-only skills or block on a permission prompt in a headless print session. The installed CLI is probed (`<bin> --help`) before spawn; a drifted install fails closed with typed `PROVIDER_CAPABILITY_DRIFT` rather than silently spawning without the guard. `--full` (native passthrough) is unaffected — no new flags are added. See `printModeGuards` in `providers inspect <id>`.

## Remote Claude transport (opt-in ssh)

Status: `declared; live canary pending`

`webmcp-ai` supports dispatching Claude Code CLI tasks to an operator-declared remote host over SSH (host `m1`), avoiding quota exhaustion on local developer machines while guaranteeing identical review, compose, and generation contracts.

### Environment configuration

| Variable | Default | Purpose |
|---|---|---|
| `WEBMCP_AI_CLAUDE_HOST` | `local` (unset) | Host selector. Set to `m1` to opt into remote execution. Unknown values fail closed. |
| `WEBMCP_AI_CLAUDE_SSH_ALIAS` | `mac-pro14` | SSH hostname/alias passed to `ssh`. Validated against `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. |
| `WEBMCP_AI_CLAUDE_REMOTE_BIN` | `/Users/ttcenter/.local/bin/claude` | Absolute path to the Claude Code CLI binary on the remote host. |
| `WEBMCP_AI_CLAUDE_REMOTE_WORKER` | `/Users/ttcenter/.webmcp-ai/claude-remote-worker.mjs` | Absolute path to the WebMCP remote worker script on the remote host. |
| `WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE` | `/Users/ttcenter/Desktop/VIBE_CODE` | Remote workspace root containing valid project workspaces. |
| `WEBMCP_AI_CLAUDE_REMOTE_MAP` | Unset | Optional local-to-remote workspace path mapping override (`localPath=remotePath`). |
| `WEBMCP_AI_CLAUDE_REMOTE_NODE` | `node` | Node.js binary name or absolute path on the remote host. |

### Fail-closed semantics

- **Configuration integrity**: Operator overrides are strictly validated before any SSH invocation. Paths containing shell metacharacters, whitespace, null bytes, or `..` path traversal segments fail closed with typed `CLAUDE_REMOTE_CONFIG_INVALID` (`exitCode: 2`). Error messages and details report only the invalid field name, never echoing raw paths or usernames.
- **Fail-closed transport**: If the remote host is unreachable (SSH connection refused, key mismatch, DNS failure, timeout, non-zero SSH exit), execution fails immediately with typed `CLAUDE_REMOTE_UNREACHABLE` (`exitCode: 2`). The wrapper **never falls back silently to a local Claude binary**.
- **Version pin enforcement**: Remote Claude CLI version is probed before execution; any drift from the pinned version (`2.1.283`) fails closed with typed `CLAUDE_REMOTE_VERSION_DRIFT`.
- **Worker protocol enforcement**: The remote worker validates every argument against a strict allowlist. Disallowed flags (e.g. `--dangerously-skip-permissions`) cause the worker to reject the request with exit code 64, mapped to typed `CLAUDE_REMOTE_WORKER_ERROR`.

### Workspace mapping & fingerprint verification

- **Path translation**: Local workspaces are mapped to remote paths using longest-prefix matching over declared pairs (default: `/Users/ttcenter/Desktop/VIBE_CODE` -> `/Users/uyenuyen/Desktop/VIBE_CODE`) and operator overrides (`WEBMCP_AI_CLAUDE_REMOTE_MAP`). Unmapped paths fail closed with `CLAUDE_REMOTE_WORKSPACE_UNMAPPED`.
- **Pre-spawn fingerprint verification**: For state-sensitive intents (`review` and `implement`), the local workspace and remote workspace are verified prior to spawning the model. Both sides compute an exact git fingerprint:
  - Commit SHA (`git rev-parse HEAD`)
  - Tree SHA (`git rev-parse HEAD^{tree}`)
  - Working tree status digest (sha256 of `git status --porcelain=v1 -z`)
  - Working tree diff digest (sha256 of `git diff HEAD`)
  - Untracked files count and content digest (sha256 of sorted paths, sizes, and `git hash-object --no-filters` hashes, with a 1 MiB file cutoff)
  If the digests differ or either side is not a git repository, execution fails closed with `CLAUDE_REMOTE_WORKSPACE_MISMATCH` and the remote Claude model is **never spawned**.
  Verification also fails closed (`reason: 'unverifiable-fingerprint'`) when a fingerprint input cannot be computed on either side — e.g. an untracked file larger than 1 MiB, or a failed git probe. `.gitignore`d files are not covered by the fingerprint (documented limitation: `git ls-files --others --exclude-standard` skips them, so they are invisible to verification).
- **Compose isolation**: In `compose` or `compose-only` modes, execution occurs in an ephemeral temporary directory on the remote host (`cwd: null`), completely decoupled from the caller workspace and automatically cleaned up upon completion.

### No credential transfer

SSH transport carries only task requests, prompts, and sanitized environment variables. **No API tokens, auth credentials, Anthropic keys, or WebMCP Vault secrets are ever transferred over SSH.** Authentication remains strictly local to the remote machine running Claude Code.

## Jev Policy Promotion (M6 Phase B)

The policy core under `src/jev/policy/` is a promoted copy of the runner policy module (`packages/webmcp-automation-runner/src/runner/jev-fallback/policy.mjs`) at runner source commit `aae9d8ed0d5ebea199f13650f4113c07b58917da` (runner source `policy.mjs` sha256: `6f6148601d17ae113456c60da5d727562ab59be8c03739ff85aa0df9e96a2814`, promoted copy sha256: `d792835e2468b80811e87d31014e33a52aeccfd543885cc1b8698481452fefe3`), verified against the G13 oracle with 4890/4890 agreement (`temp/m5m6m7-closeout/evidence/m6-oracle-phaseB-part2.json`). In Phase B Part 1, the failure path was wired through `decideFallback` (`wireFallbackPolicy`). In Part 2, success-path guard action wiring (`wireSuccessPolicy` via `guardAction`) and ai-cli-local rollout-config resolution and validation (`rollout.mjs`, supporting `$JEV_ROLLOUT_CONFIG` file precedence over `JEV_FAST_PATH_DISABLED`/`JEV_ENABLED` env vars without reading M3-owned files) landed with fail-safe overrides and completion-signal diagnostic hooks (`completionClaim` invariant recording for Gate 5 enablement). Remaining follow-up is live execution runs for Gate 5; divergence risk is explicitly disclosed with two copies existing across the repository until M7 single-sources the engine.
