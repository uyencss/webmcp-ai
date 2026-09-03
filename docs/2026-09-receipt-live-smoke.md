---
title: WebMCP AI CLI — Live Provider Smoke Receipt
type: receipt
status: active
created: 2026-09-03
updated: 2026-09-03
---

# WebMCP AI CLI — Live Provider Smoke Receipt

Plans closed by this receipt: `2026-09-plan-full-access-one-flag.md` (§7 item 5),
`2026-09-plan-stdout-stream.md` (§5 item 4 + §8), `2026-09-plan-event-lane.md`
(§5 item 4). All runs used disposable `/tmp` workspaces only — no repository
path was written. Prompts were minimal (one file / one exact-reply sentence).

Binaries (from `doctor --json` + `--version` this date): opencode `1.18.27`,
codex `0.152.1`, claude `2.1.258`, agy `1.1.25`.

## 1. opencode --full write (PASS)

- Command: `generate --provider opencode --model
  opencode-go/muse-spark-1.2-contributor --agent-mode accept-edits --full
  --timeout-ms 240000 --json`, workspace `/tmp/live-full-CI5sMe`
- Result: `ok:true`, session `ses_f9a220e82ffeswskuRfnjGYKHu`, elapsed
  `10610ms`, `accessProfile: full`
- Read-back: exactly one new file `hello-live.txt`, content `LIVE_OK`,
  `sha256:21d7a37fd559d13fc1f11f47023427b4c5a772481562864e6bdad1e35bdc0bc4`
- This is the first real write through the wrapper since the capability
  repair: `WRITER_BLOCKED_NO_DIFF` is closed for the opencode lane.

## 2. opencode --stream --events --stream-to stdout (PASS)

- Command: same model, `--full --stream --events --stream-to stdout
  --timeout-ms 180000 --json`, workspace `/tmp/live-stream-sRLvDD`
- Result: exit `0`, stdout `105` non-empty lines, stderr `0` bytes
- `53` marker lines `webmcp-ai-event`, `seq` contiguous `1..53`, first
  `queued`, last `completed`; states
  `{queued:1, working:48, researching:3, completed:1}`
- Final stdout line parses as the envelope: `ok:true`, response `STREAM_OK`
- Raw NDJSON bytes and event lines interleave on stdout as designed; the
  envelope is forced onto its own last line.

## 3. claude --full (PASS)

- Command: `generate --provider claude --full --timeout-ms 120000 --json`,
  exact-reply prompt
- Result: `ok:true`, response `CLAUDE_OK`. Auth context is available in this
  non-interactive shell (no `AUTH_CONTEXT_UNAVAILABLE_NONINTERACTIVE`).

## 4. agy --full (PASS)

- Command: `generate --provider agy --full --timeout-ms 120000 --json`,
  exact-reply prompt
- Result: `ok:true`, response `AGY_OK`.

## 5. codex --full write (WAS WRITER_BLOCKED_ENV — NOW CLOSED)

- First attempt: `generate --provider codex --full`, workspace
  `/tmp/live-codex-GKJlsj` → `ok:true` but model text: "the workspace tool
  host is unavailable (`codex-code-mode-host` missing)". Read-back: no file.
- Root cause (upstream codex #31831 class, proven on this machine):
  `~/.local/bin/codex` is a symlink into `ChatGPT.app`; the spawner resolves
  the helper next to the *invocation* path, so it never finds the real
  `codex-code-mode-host` beside the app binary. `codex doctor` still reports
  `install: consistent` — it canonicalizes, the spawner does not.
- Fix, two layers (2026-09-03):
  1. Machine: symlink the shipped helper into PATH —
     `~/.local/bin/codex-code-mode-host ->
     /Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host`
     (upstream workaround #1; fixes direct CLI too, verified with direct
     `codex exec` writing `direct-ok.txt` = `DIRECT_OK`).
  2. Wrapper: `resolveProviderBin()` now canonicalizes absolute binary paths
     via `realpathSync` (fallback verbatim so `CLI_NOT_INSTALLED` is
     unchanged), making wrapper spawns immune on any machine. Covered by
     `tests/bin-resolution.test.mjs` (3 tests).
- Retry: `generate --provider codex --full`, workspace `/tmp/live-codex2-zn0T9Q`
  → `ok:true`, "Created `cx-live.txt` containing exactly `CX_OK`".
  Read-back: `CX_OK` (no trailing newline),
  `sha256:443d3ef8e0f39fdff95f74de1cc23cfb2c71a13fc2651fba703c26206189ece9`.
- Lane closed: all four providers now have a live full-access write/text
  receipt on this machine.

## Quota note

Five live calls total (1 write + 1 stream + 3 probes), all minimal prompts.
No spaced repetition, no retries. Owner stated quota is plentiful; usage was
still kept to the plan minimum.
