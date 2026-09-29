# Changelog

All notable changes to `@gyga-browser/webmcp-ai` are documented here.

## Unreleased

- Post-accept hardening (R7/R8, 2026-09-29):
  - **Remote fail-closed fixes (R7)**: `runRemoteClaude` now rejects a zero-exit run whose worker reported truncated
    stdout/stderr with typed `PROVIDER_OUTPUT_LIMIT` (previously capped output could be reported as success).
    `verifyRemoteWorkspace` now fails closed with `CLAUDE_REMOTE_WORKSPACE_MISMATCH`
    (`reason: 'unverifiable-fingerprint'`) when any fingerprint input cannot be computed on either side (untracked
    file >1 MiB, failed git probe) instead of comparing `null === null` as a match; `.gitignore`d files remain
    outside the fingerprint (documented). The AGY single-blob JSON lane now requires `status === 'SUCCESS'`,
    mirroring the stream-json lane's typed `PROVIDER_EXIT_ERROR`.
  - **Review-result parsing robustness & observability (R8)**: `tryParseJson` tolerates cosmetic wrapping (a single
    ``` / ```json fence, or a JSON object embedded in surrounding prose) while every semantic validation rule stays
    equally strict; each `REVIEW_RESULT_INCOMPLETE` raised from model text now carries a bounded `rawExcerpt`
    (≤2000 chars, control chars normalized) so malformed provider output is diagnosable.

- Remote Claude transport over SSH (R2, opt-in ssh, status `declared; live canary pending`):
  - **Opt-in host routing (`WEBMCP_AI_CLAUDE_HOST=m1`)**: dispatches Claude Code generation and review tasks to an operator-declared remote host over SSH (`mac-pro14`), avoiding developer machine quota exhaustion. Default unset/`local` keeps local execution untouched.
  - **Fail-closed transport & configuration**: config validation strictly rejects shell metacharacters and path traversals with typed `CLAUDE_REMOTE_CONFIG_INVALID` without leaking raw values. SSH failures map to typed `CLAUDE_REMOTE_UNREACHABLE` (never falls back silently to local binary). Remote CLI version drift from `2.1.283` raises `CLAUDE_REMOTE_VERSION_DRIFT`. Worker rejections (exit code 64) map to `CLAUDE_REMOTE_WORKER_ERROR`.
  - **Workspace mapping & pre-spawn git fingerprint verification**: longest-prefix path translation (`WEBMCP_AI_CLAUDE_REMOTE_MAP`). State-sensitive intents (`review`, `implement`) verify git `HEAD`, `HEAD^{tree}`, status, diff, and untracked file digests byte-for-byte before model spawn; divergence raises `CLAUDE_REMOTE_WORKSPACE_MISMATCH` without spawning the model binary. `compose` runs in an isolated remote temp directory (`cwd: null`) with automatic cleanup.
  - **Remote worker (`scripts/claude-remote-worker.mjs`)**: headless runner supporting `--mode selftest|fingerprint|run`, strict flag allowlisting, prohibited env stripping, output byte caps, and timeout management.
  - **Envelopes**: `generate` and `review` envelopes carry `transport: { type: 'ssh', host: '<id>' }` on success and in sanitized dry-run previews.
  - **No credential transfer**: auth tokens and Vault secrets are never transferred across SSH; remote Claude uses its own local authentication.

- Codex native JSONL telemetry and explicit session fork (R5, canary 2026-09-29):
  - **Codex native JSONL telemetry (`--json`)**: on the generate lane, when `--events` is requested (`eventsRequested: true`), Codex `exec` argv includes `--json` on the fresh path; `exec resume` includes `--json` only when proved by `exec resume --help`. Telemetry stays strictly advisory: the final response text continues to be read from the `--output-last-message` file; regression tests prove that stdout JSONL never corrupts the parsed output or structured envelope. Review lane (`taskIntent === 'review'`) remains unchanged without `--json`.
  - `src/events.mjs`: added `classifyCodexEvent` and routed `classifyProviderLine('codex', line)` to it for JSONL lines. Canary-proven shapes from Codex 0.157.1 map conservatively: `thread.started` -> `researching`, `turn.started` -> `working`, `item.completed(agent_message)` -> `researching`, and `turn.completed` -> `verifying`. Added defensive branches for documented-but-unobserved shapes: `turn.failed` -> `blocked`, and item lifecycle events (`item.started`, `reasoning` -> `researching`, `command_execution` -> `testing` for test/build commands else `editing`, `file_change` -> `editing`, `todo_list` -> `working`, error items -> `blocked`).
  - **Explicit session fork (`sessionAction: 'resume' | 'fork'`)**: new input `sessionAction`, default `'resume'`, valid only with `sessionId`. Requests without `sessionId` or with unknown values fail with typed `INVALID_INPUT` (`details: { field: 'sessionAction' }`). `'resume'` remains byte-identical to prior behavior across all providers.
  - **Provider mapping & capability truth**:
    - `claude`: `--resume <id> --fork-session` when `sessionAction: 'fork'`. Probed for `--fork-session` before spawn; missing flag raises `PROVIDER_CAPABILITY_DRIFT`. Advertises `explicitFork: true` (canary-proven).
    - `opencode`: `--session <id> --fork` when `sessionAction: 'fork'`. Probed for `--fork` before spawn; missing flag raises `PROVIDER_CAPABILITY_DRIFT`. Advertises `explicitFork: true` (canary-proven).
    - `codex`: maps to `exec fork <SESSION_ID> ...` with shared flags and prompt via `-`. Under strict quota guard, `capabilities.explicitFork` is truthfully declared `false` (`reason: "fork works but the new session id is not surfaced within the codex call budget"`), and real runs fail closed with typed `UNSUPPORTED_CAPABILITY`. Dry-run reflects `exec fork` args.
    - `agy`: session fork is not native -> fails closed with typed `UNSUPPORTED_CAPABILITY` (`capability: 'explicitFork'`).
  - **Envelope & CLI**:
    - Generate envelope returns `session: { id: <new_id|null>, resumable: <bool>, forkedFrom: <source_id|null> }` (`forkedFrom` included only when `sessionAction === 'fork'`). The new session id comes from provider output (Claude JSON `session_id`, OpenCode JSONL `sessionID`), never invented.
    - Review lane retains the frozen `{ id: null, resumable: false }` envelope (no leakage of session id or `forkedFrom`).
    - CLI adds `--session-action <resume|fork>` for both `generate` and `review`. Dry-run outputs `sessionAction` and redacts session IDs to `<session>`.
    - `webmcp-tool-v1` schema includes `sessionAction` in `ai.generate` and `ai.review`.

- Codex native Git diff review (`reviewTarget`) and OpenCode v2 real-fixture
  verification (R4, canary 2026-09-29):
  - New optional review-only input `reviewTarget`: exactly one of
    `{type:"uncommitted"}` / `{type:"base",ref}` / `{type:"commit",sha}`.
    Codex-only (`UNSUPPORTED_CAPABILITY` on other providers); conflicts with
    `sessionId` (`TASK_INTENT_ACCESS_CONFLICT`, resume scope is not provable
    for a native diff review); an empty object/absent value keeps the
    portable review lane byte-identical. `ref`/`sha` are validated against
    `^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$` (never a leading `-`, no null
    bytes) before any spawn. The workspace must be a Git repository (bounded
    `git rev-parse --show-toplevel` probe; typed `REVIEW_TARGET_NOT_GIT`
    otherwise). Exposed as `--review-target/--review-base/--review-commit`
    on `webmcp-ai review` (typed rejection on `generate`/`ai.generate`).
  - **Real-CLI finding that reshaped the design** (codex-cli 0.157.1):
    `codex exec review --help` lists `--uncommitted`/`--base`/`--commit`, but
    the installed binary hard-rejects combining any of them with a custom
    `[PROMPT]` (clap conflict, exit 2, before any spawn) — including the `-`
    stdin marker this wrapper needs for the JSON-contract instructions — and
    even without a custom prompt, that built-in flow ignores
    `--output-schema` entirely (free prose, never schema-shaped). The
    adapter therefore never emits `--uncommitted`/`--base`/`--commit` as
    argv; the diff scope is named in the prompt instead, and the model
    gathers it itself via read-only `git diff`/`git show` inside
    `-c sandbox_mode="read-only" -c approval_policy="never"`. Verified
    end-to-end against the real CLI for both `uncommitted` and `base` scopes.
  - `src/review-result.mjs` exports `REVIEW_RESULT_JSON_SCHEMA`, a JSON
    Schema literal for `webmcp-ai-review-result/1`, used as the Codex
    `--output-schema` file for the reviewTarget lane.
  - OpenCode v2 JSONL classification/parsing is now proven against real
    captured fixtures (`tests/fixtures/opencode-v2-jsonl/`) instead of
    hand-constructed shapes: `text`/`tool_use`/`error` (top-level
    `{"type":"error","error":{"type":"provider.no-route",...}}`, not
    `session.error`). `classifyProviderLine` gained a `type === 'error'`
    branch and no longer lets a bare `sessionID` on a real flat CLI event
    (text/tool_use/step_start/step_finish/error all carry one) shadow its
    specific classification.
- AGY structured output, long-prompt stream-json lane, and two-layer effort
  metadata (canary 2026-09-29, AGY 1.2.13):
  - `agy` provider accepts `request.schema`, adding native
    `--output-format json --json-schema <file>` (bounded and `full`, argv
    lane), or just `--json-schema` on the stream-json lane (output format is
    already `stream-json` there). The schema is written to a bounded
    `webmcp-ai-agy-*` temp dir (mode `0o600`) always removed via the
    invocation cleanup hook, including on a later `buildInvocation` failure.
    A response missing `structured_output` when a schema was requested is
    typed `PROVIDER_STRUCTURED_OUTPUT_MISSING`; a malformed `--json-schema`
    file classifies as typed `PROVIDER_SCHEMA_INVALID`.
  - A prompt above the existing 128 KiB `-p` argv cap (`MAX_PROMPT_ARG_BYTES`)
    and at or below a new 4 MiB cap (`MAX_STREAM_PROMPT_BYTES`) now moves to
    the `--input-format stream-json --output-format stream-json` lane: one
    `{"event":"user",...}` NDJSON line on stdin, never in argv. Above the
    stream cap it is typed `PROMPT_TOO_LARGE`. `model-capabilities.mjs`
    publishes the bounded 4 MiB AGY prompt cap (never unbounded).
  - Provider-level effort closed sets, verified via each installed CLI's own
    `--help`: agy `low|medium|high|max`, claude `low|medium|high|xhigh|max`
    (codex/opencode omit the field; no documented closed set). An effort
    outside the provider's set fails before spawn with the existing typed
    `UNSUPPORTED_EFFORT`; a model-level `MODEL_OVERRIDES` entry that
    positively rejects `--effort` still wins over the provider list. Exposed
    via `providers list`/`providers inspect`/`models inspect`
    (`capabilities.effort`).
- Add `src/remote.mjs`: a declared, code-only registry of remote Claude hosts
  (host `m1`, SSH alias `mac-pro14`) with strictly validated operator env
  overrides (`WEBMCP_AI_CLAUDE_SSH_ALIAS`, `WEBMCP_AI_CLAUDE_REMOTE_BIN`,
  `WEBMCP_AI_CLAUDE_REMOTE_WORKER`, `WEBMCP_AI_CLAUDE_REMOTE_WORKSPACE`), host
  selection (`WEBMCP_AI_CLAUDE_HOST`), and a bounded read-only SSH probe
  (`--version`/`--help` over `BatchMode`/`StrictHostKeyChecking` ssh options,
  256 KiB output cap). Every failure mode (missing ssh, non-zero exit,
  timeout, host key mismatch, DNS) maps to typed `CLAUDE_REMOTE_UNREACHABLE`
  with a bounded reason code; invalid config maps to typed
  `CLAUDE_REMOTE_CONFIG_INVALID` naming only the field, never the raw value.
  This lane never falls back to a local binary. Worker/run/fingerprint
  protocol is out of scope for this round.
- Wire host `m1` into the provider install manifest (`transport: 'ssh'`):
  `providers install --plan|--read-back --host m1` probe through the bounded
  SSH read-only probe (state `match|drift|missing|unreachable`, never
  mutates); `--apply --host m1` always refuses with typed
  `REMOTE_INSTALL_UNSUPPORTED` (`exitCode: 3`) since there is no SSH mutation
  path. Bump local pins to active runtime measurements: Claude `2.1.283`,
  OpenCode `2.0.18`, Codex `0.157.1`, AGY `1.2.13`.
- Add a bounded print-mode guard to every non-`full` AGY and Claude lane:
  `--disable-slash-commands` (both providers) and, on the Claude review lane,
  `--permission-prompts none`, so a prompt cannot expand interactive-only
  skills or block on a permission prompt in a headless print session. The
  installed CLI is probed (`<bin> --help`) before spawn on the live generate
  lane; a drifted install fails closed with typed `PROVIDER_CAPABILITY_DRIFT`
  instead of silently spawning without the guard. `--full` (native
  passthrough) stays byte-identical — no new flags are added. Declared via
  `printModeGuards` in each provider's `capabilities` (`providers inspect`).
- Register `opencode-go/union-alpha` in model capabilities table with `supportsEffort: false`
  to fail closed against unsupported `--effort` flags before process spawn.
- Record the verified optional OpenCode/OpenRouter route
  `openrouter/meta/muse-spark-1.3-contributor` as a separate model fact with
  `high` effort only; preserve the historical
  `opencode-go/muse-spark-1.3-contributor` lineage and reject no model merely
  because its static metadata is unknown. Add
  explicit `--opencode-profile v1|v2` plumbing to sanitized dry-runs so v2
  previews can use `--standalone` and `provider/model#variant` without
  spawning a provider; absent profiles remain explicitly unresolved and real
  dispatch keeps bounded version auto-detection.
- Support installed OpenCode v2 (2.x) alongside v1 (1.x) in the opencode
  adapter: per-spawn profile detection from one bounded `<bin> --version`
  probe; v2 runs with `--standalone`, drops `--dir` (workspace is the spawn
  cwd), folds effort as `--model provider/model#variant`, and receives the v2
  ordered `permissions` config (`mcp.servers`/`plugins` emptied, updates
  disabled), while v1 argv/config stays byte-compatible; an unrecognized major
  or unparseable version fails closed with typed `PROVIDER_CAPABILITY_DRIFT`
  before any argv/temp artifact, and `providers inspect opencode
  --task-intent review` reports `mapping.profile`.
- Extract the durable orchestration runtime into the companion package
  `@gyga-browser/webmcp-ai-orchestration`; keep a lazy typed compatibility shim
  for `webmcp-ai orchestration ...` while removing orchestration code and the
  OpenCode SDK from the core artifact.
- Add `--stream-to stdout` routing for advisory live provider output and events,
  separating the JSON envelope onto its own last line and separating text-mode
  final output with a leading newline to prevent concatenation with provider
  bytes, while preserving default stderr streaming and tool-call boundaries.
- Bind Codex explicit resume to `-c sandbox_mode="read-only|workspace-write"`
  while omitting unsupported resume flags (`--sandbox`, `--color`), maintaining
  bounded read-only or full workspace-write sandboxing without claiming
  `danger-full-access`.
- Update default test suite and publish lifecycle scripts to discover test files
  recursively via `scripts/orchestration-coverage.mjs --test-only`, ensuring
  managed-host tests are included while live canaries remain strictly excluded.
- Make teardown receipts proof-driven across all four process adapters and
  crash recovery: on POSIX, `group-stopped` now requires `kill(-pgid, 0)` to
  report `ESRCH`, including when the group leader exits before escalation.
- Document the accepted Windows alpha limitation: without Job Object support,
  teardown remains pid-only and does not prove that descendants are absent.
- Isolate every OpenCode test runtime database under a per-test temporary data
  root, reject unsandboxed starts under `node:test`, and use unique binding IDs
  so concurrent suites cannot share or mutate the real user data root.
- Align `webmcp-ai-review-result/1` with the frozen task-intent plan: finding
  severity is `critical|high|medium|low` with fields
  `id/severity/file/line/message/recommendation` (`file`/`line` optional only
  for architectural findings); safe aliases (`summary` for `message`, `path`
  for `file`) apply only as fallbacks and never discard canonical fields;
  `approve` rejects `critical`/`high`/`medium`; malformed or plan-only output
  is `REVIEW_RESULT_INCOMPLETE`.
- Add typed task-intent errors: unknown intents fail with
  `TASK_INTENT_INVALID`; intent/profile contradictions (including `implement`
  without explicit `bounded-edit`/`full`) fail with
  `TASK_INTENT_ACCESS_CONFLICT` before spawn; malformed primitives stay
  `INVALID_INPUT`.
- Remove implicit native Plan mode from every vNext path: OpenCode
  review/compose use the known `build` agent with generated read-only/deny-all
  permissions; Codex `plan` and AGY vNext intents are uniformly rejected until
  a separate `webmcp-ai-plan-result/1` contract exists.
- Harden the Claude reviewer to the exact plan mapping (version-probed
  `dontAsk`, `Read,Glob,Grep`, deny `Edit,Write,NotebookEdit`, `safe-mode`,
  `--no-chrome`, `--no-session-persistence`, no MCP, no fallback to full) and
  use native `stream-json --verbose` only when events are requested in
  `generate`; `review` intentionally disallows `--stream`/`--events`. The
  review/`ai.review` spawn lane now version-probes `claude --help` (bounded,
  read-only, no model) before spawn and maps drift/unavailable to typed
  `PROVIDER_CAPABILITY_DRIFT`/`CLI_NOT_INSTALLED` without leaking paths or
  raw help; dry-run remains no-spawn and legacy `generate` without review is
  unchanged. Managed or enterprise settings may override command-line grants;
  reviewer flags are requested, not guaranteed.
- Harden the Codex reviewer to its exact mapping (version-probed `exec`,
  `--sandbox`, `read-only`, `--ephemeral`, `--ignore-user-config`,
  `--ignore-rules`, `--skip-git-repo-check`, `--output-last-message`, `--color`
  plus resume `resume`/`-c`; the
  `sandbox_mode` resume mapping is a config key tested separately)
  and the opencode reviewer to its exact mapping (version-probed `run`,
  `--format`, `--agent`, `--dir`, `--model`/`--variant` with the generated
  read-only config mapping); the review spawn lane probes each provider's
  `--help` before the model and maps drift/unavailable to typed
  `PROVIDER_CAPABILITY_DRIFT`/`CLI_NOT_INSTALLED` without leaking paths or raw
  help; dry-run remains no-spawn; `authenticated:null` and `canaryProven:false`
  are preserved (no canary or auth claim).
- Narrow the task-intent matrix so `review`/`plan` accept only
  `review-readonly` (`review`+`compose-only` fails
  `TASK_INTENT_ACCESS_CONFLICT` before any compose temp workspace is created;
  legacy no-`taskIntent` `compose-only` is unchanged) with a regression proving
  no new compose directory appears after the rejection.
- Make `providers inspect <id> --task-intent review` truthful: it probes each
  provider's required CLI mapping via the installed binary/version/help in a
  bounded read-only way (no model), calls `validateClaudeReviewSupport`,
  `validateCodexReviewSupport`, and `validateOpencodeReviewSupport`
  respectively, and reports
  `installed/authenticated/policy-supported/canary-proven/task-ready`
  separately with typed `PROVIDER_CAPABILITY_DRIFT`/unavailable reasons and no
  path/secret leakage; ordinary review dry-run never spawns. Claude review
  inspection reports a bounded `limitations` field whenever
  task-ready/support is reported: managed or enterprise settings may override
  command-line grants; reviewer flags are requested, not guaranteed.
- Sanitize review dry-run previews so resumed session identifiers are represented
  only by `resumed:true`/`<resumed-session>` and never echoed as resumable argv
  material; provider `task-ready` remains explicitly mapping-only, separate from
  authentication and canary proof.
- Document the review read boundary (omitted workspace defaults to `cwd`
  read-only for compatibility; prefer explicit; never writes caller files)
  and mark resumed reviews with `resumed:true` (not fresh final-auditor
  evidence) while keeping legacy `generate` resume compatibility.

## 0.3.0-alpha.1 - 2026-09-10

- Publish the extracted one-shot/review core as a distinct artifact identity;
  the companion orchestration package pins this release instead of reusing the
  pre-extraction `0.3.0-alpha.0` monolith.

## 0.3.0-alpha.0 - 2026-08-23

- Add the opt-in portable CLI-agent orchestration runtime (alpha): explicit
  Coordination lifecycle, single-writer supervisor with fenced epochs, an
  append-only machine-local journal, worker callbacks, and independent
  acceptance through `dispatch.verify`.
- Ship four validated adapters — `owned-process`, `opencode-server` (pinned
  OpenCode 1.18.21 with a per-binding isolated SQLite database),
  `claude-stream`, and `codex-exec`. Every adapter reports honest
  evidence-derived maturity; alpha maturity is always `fixture-only`, which is
  not supported.
- Add `webmcp-ai orchestration capabilities|guide|create|call|prune` plus a
  kill switch: `WEBMCP_AI_ORCHESTRATION_DISABLED=1` blocks all mutations while
  read-only verbs and every one-shot command stay stable.
- Harden runtime teardown: bootstrap failures never orphan a server process,
  stops sweep the whole detached process group, and worker close escalates
  SIGTERM to SIGKILL at group level.
- Publish the version-matched orchestration runtime guide alongside the CLI
  subagent brief, with explicit brief-fallback vs. runtime-routing guidance.
- Add `npm run test:package-closure`: a hermetic package-closure verifier that
  audits the packed tarball surface, version consistency, and kill-switch
  stability without ambient npm configuration.
- Add the authorized live canary lane (`npm run canary -- <adapter-id>`):
  dual-opt-in bounded scenarios that record machine-local mode-`0600` receipts
  binding adapter digest, executable path digest and runtime version, letting
  `orchestration capabilities` report evidence-derived `canary-proven` for a
  single adapter on one machine. The runner never logs in and fails closed
  without explicit authorization.

## 0.2.1 - 2026-07-24

- Add an enum-safe AGY custom-agent selector through JSON input and
  `--agent`, while other providers reject the AGY-only option.
- Add normalized AGY custom-agent discovery through `agents list`.

## 0.2.0 - 2026-07-24

- Add an explicit, enum-constrained AGY `agentMode` with safe `plan` default
  and supervised `accept-edits` opt-in; Claude and Codex reject the option.
- Keep failed `tool-call` responses protocol-shaped, echoing `protocol` and
  `requestId` alongside `ok: false`.
- Rename the stray `agents/openai.yaml` skill descriptor to `agents/codex.yaml`
  and correct its provider list; there is no OpenAI provider.
- Document the package/bin name (`webmcp-ai`) vs. the `-cli` directory/skill
  convention, and the provider list vs. agent-host list.

## 0.1.0 - 2026-07-13

- Add the provider-neutral `webmcp-ai` CLI.
- Add safe AGY, Claude Code, and Codex adapters.
- Add the versioned `webmcp-tool-v1` JSON-over-stdio protocol.
- Add provider diagnostics, normalized errors, timeouts, and output limits.
- Add the `webmcp-ai-cli` companion skill and multi-agent installer.
