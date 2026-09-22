# Debate ledger — <CHỦ ĐỀ>

- Program: `<program-slug>`
- Host: ATLAS (`ttcenter`), macOS, <YYYY-MM-DD> Asia/Ho_Chi_Minh
- Type: design consultation (NOT implementation). <file đích> và source owners
  không bị chạm; write-set chỉ trong program root này.
- Strategy: `<strategy-id>` (xem `debate.config.json` + `references/strategies.md`).
- Cast: theo `debate.config.json` (merge từ `roles.default.json` + override).
- Input: <đường dẫn plan/tài liệu đích> (read-only), baseline liên quan.
- Status: <SCAFFOLDED | R1_DONE | ... | COMPLETE>

## Lanes and honest lineage (verified <date>)

Cast lấy từ `debate.config.json`; bảng dưới là mặc định khi không override.

| Lane | Route | Version | Role in debate |
| --- | --- | --- | --- |
| agy-claude (D1) | WebMCP AI CLI -> AGY -> `claude-opus-4-6-thinking` | <ver> | Debater 1 |
| claude-cli (D2) | direct `<claude> -p --model claude-opus-5-5 --effort high --restricted` | <ver> | Debater 2 |
| codex (D3) | native `codex exec --model gpt-6-sol --sandbox read-only` | <ver> | Debater 3 |
| agy-flash (D4) | WebMCP AI CLI -> AGY -> `gemini-3.8-flash-high` | <ver> | Debater 4 |
| muse (D5) | WebMCP AI CLI -> OpenCode -> `opencode-go/muse-spark-1.3-contributor` | <ver> | Debater 5 |

Notes:
- <quota observations, provider quirks, failed calls & re-runs>
- <agy-claude brain artifact handling>

## Evidence hashes (SHA-256)

- context-brief.md `<hash>`
- r1/prompt.md `<hash>`
- r2/prompt.md `<hash>`
- r3/prompt-D1..D5.md `<hashes>`
- Round outputs: `shasum -a 256 r1/out/*.md r2/out/*.md r3/out/*.md`

## Round structure

- Theo `strategy` trong `debate.config.json` (mặc định cross-exam):
  - R1 — independent position statements on owner questions.
  - R2 — cross-examination against moderator-selected contested points.
  - R3 — final ballot: decisions, confidence, dissent conditions, vetoes.

## Result summary

- <x>/<m> decisions resolved; consensus vs near-consensus points.
- Minority notes recorded; veto conditions checked against final package.

## Cleanup eligibility

- Design-consultation artifact; keep until owner review and any downstream
  amendment is accepted, then archive per workspace convention.
- No ACTIVE/REVIEWING candidates; no writer processes.
