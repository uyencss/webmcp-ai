---
title: WebMCP AI CLI — Event-Level Progress Lane Plan (v1 only)
type: plan
status: implemented
created: 2026-09-03
updated: 2026-09-03
---

# WebMCP AI CLI — Event-Level Progress Lane Plan (v1 only)

> Package docs của `@gyga-browser/webmcp-ai@0.3.0-alpha.0` (ngoài phạm vi lint
> `docs/` gốc). **Đã implement toàn bộ — xem §7 As-built.** Nối tiếp
> `2026-09-plan-stdout-stream.md` (raw passthrough đã xong).

## 1. Goal

Trên cùng đường stdout đã stream, orchestrator còn nhận được **working-state
rút gọn theo từng dòng** — đúng vocab của
`skills/webmcp-ai-cli/references/cli-subagent-orchestration.md §5`
(`queued → researching → editing → testing → verifying → completed`, cộng
`question | blocked | failed | cancelled`, thêm `working` cho activity mờ):

```bash
webmcp-ai generate --provider opencode --prompt-file ./prompt.md --workspace /abs/ws --full --events --json
# stderr: {"event":"webmcp-ai-event","seq":0,"state":"queued",...}
#         {"event":"webmcp-ai-event","seq":1,"state":"researching",...}
#         ...
# stdout: 1 JSON envelope cuối như cũ
```

## 2. Grounding (không tốn quota, đã kiểm chứng)

- `opencode run --format json` = raw JSON events từng dòng: `session.created`,
  `message.part.updated` / `message.part.delta` (part có `type`: text/tool/...),
  `permission.asked` / `permission.replied`, `file.edited`, `session.diff`,
  `session.error`, `session.idle` (SDK `types.gen.d.ts` trong `node_modules`).
  Parser hiện tại (`src/providers/opencode.mjs:206-225`) đã đọc `sessionID` và
  `type:'text'` — classifier tái dùng đúng 2 field đó + mở rộng.
- `codex exec --json` in JSONL (không đổi invocation trong lane này — codex vẫn
  đọc qua `--output-last-message`; dòng JSON lạ → `working`).
- Claude (`--output-format json` 1 object cuối) và AGY (text) → heuristic text.

## 3. Design — advisory-only, fail-closed

Telemetry không phải control: state chỉ để orchestrator **quan sát**, không bao
giờ gate/cancel dựa vào nó. Quy tắc:

1. **`src/events.mjs` mới**: `createLineSplitter(onLine)` (gom chunk cắt dòng,
   split `\n`, strip `\r`, bỏ dòng rỗng) + `classifyProviderLine(provider, line)`
   → `{ state, summary }` (summary cắt 200 ký tự).
2. Mapping (opencode JSON ưu tiên field thật, text dùng heuristic bảo thủ):
   `session.created|sessionID` → `researching`; part text/reasoning →
   `researching`; part tool → `editing` (tool/command khớp test-runner →
   `testing`); `permission.asked` → `question`; `permission.replied` →
   `researching`; `file.edited`/`session.diff` → `editing`; `session.error` →
   `blocked`; text khớp lệnh test → `testing`; text báo pass → `verifying`;
   text hỏi/quyền → `question`; còn lại → `working`.
3. **Terminal do wrapper phát** (đáng tin, không phải heuristic):
   `queued` lúc dispatch; `completed` (exit 0) / `failed` (exit ≠ 0) /
   `blocked` (timeout/output-limit) / `cancelled` (abort) lúc kết thúc — kể cả
   nhánh throw (emit trước khi rethrow).
4. **`generate({ onEvent })`** (library-only): `onEvent({ seq, stream, state,
   summary, provider })`. Nối sau `onStream` hiện có — cả hai sống chung được.
5. **CLI `--events`**: mỗi event 1 dòng JSON có marker
   `"event":"webmcp-ai-event"` ra stderr; stdout giữ nguyên 1 envelope.
   Kết hợp được với `--stream`/`--full`/mọi provider. `tool-call` không có
   `--events` (JSON stdio không chở callback — fail-closed như `--stream`).

## 4. Thay đổi source dự kiến

| File | Việc |
|---|---|
| `src/events.mjs` (mới) | splitter + classifier + terminal mapper + state vocab export |
| `src/client.mjs` | `generate()`: emit `queued`, feed splitter từ 2 stream, emit terminal cả 2 nhánh ok/throw |
| `src/cli.mjs` | flag `--events` + help; `generate` branch ghi JSONL ra stderr |
| `tests/events.test.mjs` (mới) | splitter cắt chunk, mapping từng shape, terminal cả nhánh lỗi, CLI tách stdout/stderr |
| `SKILL.md`, `README.md` | đoạn `--events` + vocab + cảnh báo advisory-only |

Không chạm: invocation các provider, envelope JSON, protocol, orchestration
runtime, timeout/kill.

## 5. Test & DoD

1. `node --test tests/events.test.mjs` xanh.
2. `npm test` không regression.
3. `node --check` + `git diff --check` sạch.
4. Smoke fake provider: stderr ra JSONL parse được + marker, stdout `ok:true`.

## 6. Non-goals / Risks

- Không đổi codex sang `--json`, không đổi claude sang `stream-json` — invocation
  giữ nguyên để khỏi vỡ parse hiện tại.
- Heuristic text có thể mislabel (ví dụ prose "I will update the file" → vẫn
  là tín hiệu editing, chấp nhận được vì advisory). Không dùng state để auto
  approve/kill/commit.
- `escalation` có trong vocab nhưng v1 chưa phát hiện được → không emit, ghi rõ.
- Summary cắt 200 ký tự; text provider vẫn nhạy cảm như `response.text` — chỉ đi
  ra stderr của operator, không vào receipt.

## 7. As-built (implement 2026-09-03, đúng plan + 1 fix)

- `src/events.mjs` (mới): `createLineSplitter`, `classifyProviderLine`,
  `terminalStateForError`, `EVENT_STATES`. Fix so với plan: legacy opencode
  text shape `{type:'text', part:{text}}` đặt kind ở `event.type` (parser cũ
  đọc đúng field này) nên classifier accept cả hai vị trí.
- `src/client.mjs`: `generate({ onEvent })`, emit `queued` lúc dispatch,
  feed splitter từ cả 2 stream, emit terminal cả nhánh ok lẫn throw
  (completed/failed/blocked/cancelled).
- `src/cli.mjs`: flag `--events` + help; JSONL có marker
  `"event":"webmcp-ai-event"` ra stderr.
- `tests/events.test.mjs` (mới, 8 tests): splitter cắt chunk, mapping từng
  shape grounded + heuristic, terminal mapper, `generate` cả nhánh lỗi, CLI
  tách stdout/stderr.
