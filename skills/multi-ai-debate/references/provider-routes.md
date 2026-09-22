# Provider routes — exact commands, quirks, extraction

Re-probe before every program: `node "$AI_CLI" doctor --json` and
`models list --provider agy|opencode --json`. Paths/models verified 2026-09-10 on
ATLAS; treat as defaults with env overrides, not timeless facts.

> **Dispatch is config-driven.** `scripts/dispatch-round.mjs` builds each
> participant's command from `debate.config.json` via `scripts/lib/config.mjs`
> (`routeCommand`), using the per-debater `route/model/effort/options`. The
> commands below document the shape and quirks of each route; the default
> `roles.default.json` reproduces them. Change roles with `--roles`/`--debaters`
> instead of editing the dispatcher.

```bash
# $VIBE_CODE = gốc workspace VIBE_CODE (vd: $HOME/Desktop/VIBE_CODE); $HOME = thư mục người dùng
AI_CLI=${WEBMCP_AI_CLI:-$VIBE_CODE/webmcp-automation-kit/packages/webmcp-ai-cli/bin/webmcp-ai.mjs}
AGY_BIN=${AGY_BIN:-$HOME/.local/bin/agy}
CLAUDE_BIN=${CLAUDE_BIN:-$HOME/.local/bin/claude}
CODEX_BIN=${CODEX_BIN:-$HOME/.local/bin/codex}
OPENCODE_BIN=${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}
```

## Quota preflight

```bash
curl -s "http://127.0.0.1:8421/api/quotas?all=1" | python3 -m json.tool | head -80
node $VIBE_CODE/.agents/skills/ai-cli-usage/scripts/get-quotas.mjs --all --json
```

Routing rules: Codex 5h=0 → mac-m1 (`ssh mac-m1`) or AGY; Claude weekly <20% →
prefer AGY Claude, warn owner before burning direct Claude calls; large-context
lane → AGY Gemini (highest quota). A quota/transport failure is a typed blocker
(`REVIEW_BLOCKED_PROVIDER_ROUTE`), never a lane verdict.

## Lane D1 — AGY Claude (`claude-opus-4-6-thinking`)

```bash
cd "$ROOT/lanes/agy-claude"
AGY_BIN="$AGY_BIN" node "$AI_CLI" generate \
  --provider agy --model claude-opus-4-6-thinking \
  --prompt-file "$PROMPT" --workspace "$PWD" --agent-mode plan \
  --events --timeout-ms 2300000 --json > out.json 2> stderr.log
```

Quirks:
- AGY does **not** support `--access-profile review-readonly` → `UNSUPPORTED_CAPABILITY`.
  Use default `--agent-mode plan` (read-only agent behavior).
- `--effort` is **not supported** for `claude-opus-4-6-thinking` → provider exits 1
  with "invalid model selection". Omit effort.
- The model may answer with a short summary only and write the full artifact to
  `~/.gemini/antigravity-cli/brain/<uuid>/<name>.md`. `extract-responses.mjs`
  resolves the brain file (link in text, else newest matching .md) and copies it.

## Lane D4 — AGY Gemini Flash (`gemini-3.8-flash-high`)

Same as D1 but `--model gemini-3.8-flash-high --effort high` (effort supported).
Returns full text in `response.text`. stderr with `--events` can be large (20MB+
for long R2 prompts) — it is progress only, safe to keep or delete.

## Lane D2 — direct Claude Code CLI (Claude Opus 5.5)

```bash
"$CLAUDE_BIN" -p --model claude-opus-5-5 --effort high --output-format json --restricted \
  < "$PROMPT" > out.json 2> stderr.log
```

- Sử dụng Claude Code CLI 2.1.280+ với model `claude-opus-5-5` (alias `opus`).
- `--restricted` removes command/code tools; debate needs none.
- Run with cwd = empty lane dir so no project CLAUDE.md pollutes context.
- Output JSON: `{ is_error, subtype, result, usage, total_cost_usd, ... }`.
  Text = `.result`; treat `is_error: true` as lane failure.
- Costs real weekly quota; keep prompts bounded and monitor quota between rounds.

## Lane D5 — Muse via OpenCode

```bash
cd "$ROOT/lanes/muse"
OPENCODE_BIN="$OPENCODE_BIN" node "$AI_CLI" generate \
  --provider opencode --model opencode-go/muse-spark-1.3-contributor --effort xhigh \
  --prompt-file "$PROMPT" --workspace "$PWD" --agent-mode plan \
  --events --timeout-ms 2300000 --json > out.json 2> stderr.log
```

Exact model id must exist in `models list`: `opencode-go/muse-spark-1.3-contributor`.

## Lane D3 — native Codex Sol (GPT-6-Sol)

```bash
cd "$ROOT/lanes/codex"
"$CODEX_BIN" exec --model gpt-6-sol --sandbox read-only --ephemeral --json \
  --skip-git-repo-check --output-last-message "$OUT/codex.md" \
  -c model_reasoning_effort=high -c approval_policy=never - \
  < "$PROMPT" > codex.events.jsonl 2> stderr.log
```

- Final text = `codex.md` (last message). `codex.events.jsonl` = progress stream.
- Alternative route when local quota is spent: `ssh mac-m1 '... same command ...'`
  (ORBIT has native Codex; verify quota first).
- Do not label an OpenCode alias as native Sol — lineage honesty.

## Wrapper envelope (`generate ... --json`)

Success: `{ "ok": true, "response": { "text": "..." }, "session": {...}, "timing": {...} }`.
Failure: `{ "ok": false, "error": { "code": "...", "message": "...", "retryable": bool } }`.
Consume `response.text`; branch on `error.code`; never fabricate content on failure.

## Gotcha: `review` vs `generate` for prose reviews (verified 2026-09-16)

- `webmcp-ai review` enforces the `webmcp-ai-review-result/1` JSON schema on the
  model output. A free-text review fails with `REVIEW_RESULT_INCOMPLETE`
  (`malformed-json`, non-retryable) — even when the model did the work.
- `review` also rejects `--events` (`INVALID_INPUT: stream/events are not
  supported for review`).
- For independent-reviewer prose (tally-check/challenge/verdict), use
  `generate --provider <id> --model <model> --prompt-file <f> --workspace <dir>
  --agent-mode plan [--events] --timeout-ms <ms> --json` — same shape as an
  opencode debate lane, read-only, no dispatch script needed.

## Timeout helper (macOS has no GNU timeout)

```bash
tmo() { local secs=$1; shift; perl -e 'alarm shift; exec @ARGV' "$secs" "$@"; }
tmo 2400 <command...>
```

## Parallel dispatch pattern

Background subshell per lane + `wait` per PID, each writing to its own
`r<N>/out/<lane>.{json,md,stderr.log}`; keep lane prompts in files (never shell
history); run all five concurrently (~4–10 min/round in the 2026-09 case).
