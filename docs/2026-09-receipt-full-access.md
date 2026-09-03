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

## Committed milestones

- `4d69fab` feat(ai-cli): add full-access one-flag passthrough
- `8acd191` feat(ai-cli): add stdout stream passthrough (`--stream`, `onStream`)
- `709e872` feat(ai-cli): add advisory event-level progress lane (`--events`, `onEvent`)
- The exact five-line assertion correction in `tests/full-access.test.mjs`
  (empty-authority echo `(;|$)` form) is preserved in the candidate working tree.

## Write-set

- `src/capabilities.mjs` — `full` profile, fast-path validation, `buildFullChildEnv` + denylist, `toOpenCodeRelativePatterns`, `bounded-edit` relative rules, `buildOpenCodeConfig('full')`
- `src/client.mjs` — `full` valid for every provider, `maxOutputBytes` validation, env builder per profile, default cap 32MB / 128MB with `full`, `onStream`/`onEvent` advisory lanes
- `src/protocol.mjs` — schema `full` + `maxOutputBytes`, metadata `fullPassthrough`
- `src/cli.mjs` — `--full`, `--max-output-bytes`, `--stream`, `--events`, help text
- `src/events.mjs` — line splitter plus provider classifier and terminal mapper (advisory telemetry only)
- `src/process-runner.mjs` — `onStdout`/`onStderr` live forwarding
- `src/providers/opencode.mjs` — `full` passthrough keeps ambient operator config/tools/MCP (OpenCode v1 only, `OPENCODE_DB` stays isolated to `opencode-cli.db`)
- `src/providers/codex.mjs` — `full` uses `--sandbox workspace-write` but keeps `--ephemeral --ignore-user-config --ignore-rules`, so ambient user config/MCP is not inherited
- `src/providers/claude.mjs` — `full` drops the `--tools '' --safe-mode` text-only deny
- `src/providers/agy.mjs` — `full` drops the forced `--sandbox`
- `tests/full-access.test.mjs` — 29 focused tests
- `tests/events.test.mjs` — 15 focused tests
- `tests/stream.test.mjs` — 7 focused tests
- `tests/capabilities.test.mjs` — enum + relative-rule assertions
- `tests/skill-content.test.mjs` — skill `--full` / `--events` assertions
- `tests/fixtures/fake-ai-cli.mjs` — `FAKE_ECHO_ENV` (test-only env observability)
- `skills/webmcp-ai-cli/SKILL.md` — `Full access` section with per-provider scope plus `--stream`/`--events` advisory lanes
- `README.md` — `--full` + `--max-output-bytes` + `--stream`/`--events` with per-provider scope

Provider scope is precise: only OpenCode v1 keeps ambient operator
config/tools/MCP under `--full` (session database still isolated); Codex
`workspace-write` keeps `--ephemeral --ignore-user-config --ignore-rules` and
does not inherit ambient config/MCP; Claude and AGY follow their documented
provider-specific `--full` mapping. Without `--stream`/`--events`, output
arrives only at process exit; with them, stderr carries advisory telemetry
only, never control/approval/cancellation/acceptance.

## Verification (candidate tree at baseline `709e872` plus candidate documentation/test changes)

- `node --test tests/full-access.test.mjs tests/events.test.mjs tests/stream.test.mjs` → 29 full-access + 15 event + 7 stream focused tests pass
- `npm test` → 573/573 pass, 0 fail
- `npm run test:coverage` → exit 0; lines 91.08%, functions 90.23%, branches 80.30%; thresholds 80/80/80; full production universe 54/54 files
- `node --check` on changed sources plus `git diff --check` → clean
- Smoke fake provider: `opencode/codex/claude/agy --full` all `ok:true`;
  env `WEBMCP_AI_FULL_PROBE` reaches the child, `WEBMCP_GATEWAY_TOKEN` is stripped;
  `--full + --tool-policy compose-only` → `INVALID_INPUT` fail-closed

## Follow-up lanes (already committed above)

Stdout stream passthrough (`--stream`, `onStream`): see
`2026-09-plan-stdout-stream.md` (status `implemented`).
Advisory event lane (`--events`, `onEvent`): see
`2026-09-plan-event-lane.md` (status `implemented`).

## Acceptance status

Not accepted until a fresh independent review passes. This receipt makes no
E4/E5/E9 acceptance claim.

## Not in this receipt

Live provider smoke (costs quota, needs owner approval), Runner permit/Gateway broker,
doctor canary, version/route print — see plan §10.
