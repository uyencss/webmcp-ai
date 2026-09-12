# Changelog

All notable changes to `@gyga-browser/webmcp-ai` are documented here.

## Unreleased

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
