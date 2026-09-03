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
Chưa commit — write-set nằm ở working tree của package.

## Write-set

- `src/capabilities.mjs` — `full` profile, fast-path validation, `buildFullChildEnv` + denylist, `toOpenCodeRelativePatterns`, `bounded-edit` relative rules, `buildOpenCodeConfig('full')`
- `src/client.mjs` — `full` hợp lệ mọi provider, validate `maxOutputBytes`, env builder theo profile, default cap 32MB / 128MB khi `full`
- `src/protocol.mjs` — schema `full` + `maxOutputBytes`, metadata `fullPassthrough`
- `src/cli.mjs` — `--full`, `--max-output-bytes`, help text
- `src/providers/opencode.mjs` — `full` passthrough (ambient config, chỉ giữ `OPENCODE_DB`)
- `src/providers/codex.mjs` — `full` → `--sandbox workspace-write`
- `src/providers/claude.mjs` — `full` → bỏ `--tools '' --safe-mode`
- `src/providers/agy.mjs` — `full` → bỏ `--sandbox` ép buộc
- `tests/full-access.test.mjs` — mới, 15 tests
- `tests/capabilities.test.mjs` — update enum + relative-rule assertions
- `tests/skill-content.test.mjs` — test khóa skill document `--full`
- `tests/fixtures/fake-ai-cli.mjs` — `FAKE_ECHO_ENV` (test-only env observability)
- `skills/webmcp-ai-cli/SKILL.md` — section `Full access` (+ env/cap note)
- `README.md` — đoạn `--full` + `--max-output-bytes`

## Verification

- `node --test tests/full-access.test.mjs` → **15/15 pass**
- `npm test` → **527/527 pass** (511 gốc + 16 mới), 0 fail
- `node --check` 11 file đổi → sạch; `git diff --check` → sạch
- Smoke fake provider: `opencode/codex/claude/agy --full` đều `ok:true`;
  env `WEBMCP_AI_FULL_PROBE` tới child, `WEBMCP_GATEWAY_TOKEN` bị strip;
  `--full + --tool-policy compose-only` → `INVALID_INPUT` fail-closed

## Không thuộc receipt này

Live provider smoke (tốn quota, chờ owner duyệt), Runner permit/Gateway broker,
streaming output, doctor canary, version/route print — xem plan §10.
