---
title: WebMCP AI CLI — Full Access One-Flag Receipt
type: receipt
status: active
created: 2026-09-03
updated: 2026-09-03
---

# WebMCP AI CLI — Full Access One-Flag Receipt

Plan: `2026-09-plan-full-access-one-flag.md` (status `implemented`, §10 As-built).
Scope: package `@gyga-browser/webmcp-ai@0.3.0-alpha.0`, OpenCode v1 only.

## Candidate baseline and milestones

- Candidate base: commit `33ffb07` (`test(ai-cli): fix full-access env fixture delimiters`), preceded by `85ae196` (canonical bin resolution for codex helper) and `b2e7570` (live provider smoke receipt).
- Current candidate contains an uncommitted bounded delta in working tree (`package.json`, `scripts/orchestration-coverage.mjs`, `src/cli.mjs`, `src/providers/codex.mjs`, `tests/providers.test.mjs`, `tests/release-metadata.test.mjs`, `tests/stream.test.mjs`) implementing text-mode stream newline separation, Codex explicit-resume sandbox binding, and recursive test discovery.
- Milestones committed in history:
  - `4d69fab` feat(ai-cli): add full-access one-flag passthrough
  - `8acd191` feat(ai-cli): add stdout stream passthrough (`--stream`, `onStream`)
  - `709e872` feat(ai-cli): add advisory event-level progress lane (`--events`, `onEvent`)
  - `b2e7570` docs(ai-cli): record live provider smoke receipt
  - `85ae196` fix(ai-cli): resolve codex sibling-helper lookup via canonical bin path
  - `33ffb07` test(ai-cli): fix full-access env fixture delimiters

## Write-set

- `src/capabilities.mjs` — `full` profile, fast-path validation, `buildFullChildEnv` + denylist, `toOpenCodeRelativePatterns`, `bounded-edit` relative rules, `buildOpenCodeConfig('full')`
- `src/client.mjs` — `full` valid for every provider, `maxOutputBytes` validation, env builder per profile, default cap 32MB / 128MB with `full`, `onStream`/`onEvent` advisory lanes
- `src/protocol.mjs` — schema `full` + `maxOutputBytes`, metadata `fullPassthrough`
- `src/cli.mjs` — `--full`, `--max-output-bytes`, `--stream`, `--stream-to`, `--events`, help text
- `src/events.mjs` — line splitter plus provider classifier and terminal mapper (advisory telemetry only)
- `src/process-runner.mjs` — `onStdout`/`onStderr` live forwarding
- `src/providers/opencode.mjs` — `full` passthrough keeps ambient operator config/tools/MCP (OpenCode v1 only, `OPENCODE_DB` stays isolated to `opencode-cli.db`)
- `src/providers/codex.mjs` — `full` uses `--sandbox workspace-write` (and on explicit resume binds `-c sandbox_mode="workspace-write"` while bounded resume binds `-c sandbox_mode="read-only"`; omits unsupported resume flags `--sandbox` and `--color`; never claims `danger-full-access`) while keeping `--ephemeral --ignore-user-config --ignore-rules`, so ambient user config/MCP is not inherited
- `src/providers/claude.mjs` — `full` drops the `--tools '' --safe-mode` text-only deny
- `src/providers/agy.mjs` — `full` drops the forced `--sandbox`
- `tests/full-access.test.mjs` — 29 focused tests
- `tests/events.test.mjs` — 15 focused tests
- `tests/stream.test.mjs` — 12 focused tests (covering stdout/stderr routing, JSON envelope separation, text-mode newline separation, invalid target rejection)
- `tests/providers.test.mjs` — covers Codex resume sandbox binding via `-c sandbox_mode="..."` and omission of `--sandbox`/`--color`
- `tests/release-metadata.test.mjs` — covers recursive default test discovery (including managed-host, excluding live)
- `tests/capabilities.test.mjs` — enum + relative-rule assertions
- `tests/skill-content.test.mjs` — skill `--full` / `--events` assertions
- `tests/fixtures/fake-ai-cli.mjs` — `FAKE_ECHO_ENV` (test-only env observability)
- `skills/webmcp-ai-cli/SKILL.md` — `Full access` section with per-provider scope plus `--stream`/`--events` advisory lanes
- `README.md` — `--full` + `--max-output-bytes` + `--stream`/`--events` with per-provider scope

Provider scope is precise: `--full` is an explicit provider workspace/tool access
profile and does not place private keys, credentials, bearer tokens, or machine
identity into model context, child authority env, or portable receipts. Do not
promise unrestricted ambient access for non-OpenCode providers: only OpenCode v1
keeps ambient operator config/tools/MCP under `--full` (session database still
isolated to `opencode-cli.db` via `OPENCODE_DB`); Codex `workspace-write` keeps
`--ephemeral --ignore-user-config --ignore-rules` and does not inherit ambient
config/MCP (and its explicit resume binds `-c sandbox_mode="workspace-write"`,
never `danger-full-access`); Claude and AGY follow their documented provider-specific
`--full` mapping. Without `--stream`/`--events`, output arrives only at process
exit; with them, stderr (or stdout when redirected via `--stream-to stdout`)
carries advisory telemetry only, never control/approval/cancellation/acceptance.

## Verification (candidate tree based on `33ffb07` with uncommitted bounded delta)

- `node --test tests/full-access.test.mjs tests/events.test.mjs tests/stream.test.mjs` → 56 focused tests (29 full-access + 15 event + 12 stream) pass
- Authoritative checks on candidate code: 637/637 default tests pass (`npm test`), full production universe 54/54 files, coverage lines 90.84%, functions 92.40%, branches 81.09% (`npm run test:coverage`), package closure ok (`npm run test:package-closure`), and pack dry-run 78 files (`npm run pack:dry-run`)
- `node --check` on changed sources plus `git diff --check` → clean
- Smoke fake provider: `opencode/codex/claude/agy --full` all `ok:true`;
  env `WEBMCP_AI_FULL_PROBE` reaches the child, `WEBMCP_GATEWAY_TOKEN` is stripped;
  `--full + --tool-policy compose-only` → `INVALID_INPUT` fail-closed

## Follow-up lanes (already committed above)

Stdout stream passthrough (`--stream`, `onStream`, `--stream-to`): see
`2026-09-plan-stdout-stream.md` (status `implemented`).
Advisory event lane (`--events`, `onEvent`): see
`2026-09-plan-event-lane.md` (status `implemented`).

## Acceptance status

Not accepted until a fresh independent review passes. This receipt makes no
E4/E5/E9 acceptance claim and makes no production claims.

## Not in this receipt

This package receipt is bounded to `@gyga-browser/webmcp-ai`. It does not include
or claim E4/E5/E9 acceptance, Runner permit or Gateway broker integration,
Browser automation features, A2/Z3 platform milestones, or production deployment
claims. Live provider smoke execution is recorded in a separate receipt
(`2026-09-receipt-live-smoke.md`).
