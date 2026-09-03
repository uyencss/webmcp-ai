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

## 5. codex --full write (WRITER_BLOCKED_ENV, wrapper OK)

- Command: `generate --provider codex --full --timeout-ms 180000 --json`,
  workspace `/tmp/live-codex-GKJlsj`, single-file prompt
- Result: `ok:true` with model text: "Unable to create `cx-live.txt`: the
  workspace tool host is unavailable (`codex-code-mode-host` missing)."
- Read-back: no file created. The wrapper delivered `workspace-write`
  correctly and returned the model text; the write capability is absent in
  this machine's codex setup. This is exactly the outcome class the docs
  require read-back for: `ok:true` without a diff is not acceptance.
- No blind retry; needs a codex host with the code-mode tool surface.

## Quota note

Five live calls total (1 write + 1 stream + 3 probes), all minimal prompts.
No spaced repetition, no retries. Owner stated quota is plentiful; usage was
still kept to the plan minimum.
