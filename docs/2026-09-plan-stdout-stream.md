---
title: WebMCP AI CLI — Stdout Stream Passthrough Plan (v1 only)
type: plan
status: implemented
created: 2026-09-03
updated: 2026-09-03
---

# WebMCP AI CLI — Stdout Stream Passthrough Plan (v1 only)

> Package docs của `@gyga-browser/webmcp-ai@0.3.0-alpha.0` (ngoài phạm vi lint
> `docs/` gốc). **Đã implement toàn bộ — xem §7 As-built.**

## 1. Goal

Orchestrator (AI agent gọi `webmcp-ai` qua shell, ở cả 2 lane `scheduled` và
`chat session`) **thấy output của provider ngay khi nó sinh ra**, thay vì chờ
tới process exit mới nhận một cục `response.text`.

```bash
webmcp-ai generate --provider opencode --prompt-file ./prompt.md --workspace /abs/ws --full --stream --json
# provider stdout/stderr -> forwarded live ra stderr của webmcp-ai
# stdout của webmcp-ai -> vẫn chỉ có 1 JSON envelope cuối cùng
```

## 2. Background — vì sao hiện tại không thấy gì giữa chừng

`src/process-runner.mjs:101-152` dùng `stdio: pipe`, gom mọi chunk vào mảng
`stdout[]`/`stderr[]`, chỉ `resolve()` ở sự kiện `close`. Đây chính là WAI-08
(`findings-2026-09-02.md:43`): one-shot buffer, không live supervision.
`--full` vừa rồi chỉ mở quyền, không đụng đường output.

## 3. Design — raw passthrough, 3 tầng, backward-compatible

Không parse event, không SSE, không đổi envelope. Chỉ thêm callback forward:

1. **`runProcess`**: thêm options `onStdout(chunk: Buffer)`,
   `onStderr(chunk: Buffer)` — gọi ngay khi chunk tới (trong `try/catch` để
   callback lỗi không giết runner). Byte accounting + `maxOutputBytes` +
   final buffer + exit classification giữ nguyên. Không callback = behaviour cũ.
2. **`generate()`**: thêm `input.onStream({ stream: 'stdout'|'stderr', chunk })`
   (library-only; function không đi qua JSON được). Nối vào 2 callback trên.
3. **CLI `--stream`**: khi bật, `onStream` ghi raw bytes ra `process.stderr`.
   Chọn stderr vì skill/CLI contract đã định: stdout = machine-readable output,
   stderr = diagnostics — stdout vẫn parse được JSON như cũ, orchestrator nhìn
   stderr thấy tiến trình live. Cả 2 lane dùng chung 1 flag, kết hợp được với
   `--full` và mọi provider.

## 4. Thay đổi source dự kiến

| File | Việc |
|---|---|
| `src/process-runner.mjs` | options `onStdout`/`onStderr`, forward trong `collect()` |
| `src/client.mjs` | `generate()` đọc `input.onStream`, nối vào runner |
| `src/cli.mjs` | flag `--stream` + help text; `generate` branch gắn writer ra stderr |
| `tests/stream.test.mjs` (mới) | forward đủ + đúng thứ tự + result cuối vẫn nguyên; không callback = cũ; CLI `--stream`: stderr có provider text, stdout vẫn JSON `ok:true` |
| `skills/.../SKILL.md`, `README.md` | đoạn ngắn về `--stream` |

Không chạm: envelope JSON, protocol `tool-call` (JSON stdio không chở được
callback — streaming là CLI/library-only, ghi rõ), orchestration runtime,
timeout/kill logic.

## 5. Test & DoD

1. `node --test tests/stream.test.mjs` xanh.
2. `npm test` không regression (mục tiêu 527+ mới).
3. `node --check` + `git diff --check` sạch.
4. Smoke: `generate --stream` với fake provider — stderr thấy reply trước khi
   stdout có JSON (assert bằng `spawnSync`: tách 2 stream).

## 6. Non-goals / Risks

- Không parse NDJSON thành semantic state (`researching→editing→...`) — đó là
  lane event-stream riêng, làm sau nếu cần.
- Không guarantee framing: CLI gộp cả 2 stream provider ra cùng stderr, raw
  bytes, orchestrator tự phân biệt (opencode NDJSON vẫn parse được từng dòng).
- Callback `onStream` throw → runner nuốt lỗi và chạy tiếp (ghi rõ trong code).
- Không chống orchestrator đọc nhầm chunk giữa chừng thành "xong việc" —
  completion vẫn chỉ tính ở envelope cuối + verify độc lập như cũ.

## 7. As-built (implement 2026-09-03, đúng plan)

- `src/process-runner.mjs`: options `onStdout`/`onStderr`, forward trong
  `collect()` trước byte accounting; callback bọc `try/catch`; không callback
  = behaviour cũ byte-for-byte.
- `src/client.mjs`: `generate()` đọc `input.onStream({ stream, chunk })`
  (library-only, không qua JSON protocol — `tool-call` vẫn reject field lạ).
- `src/cli.mjs`: flag `--stream` + help; `generate` branch ghi raw bytes ra
  `process.stderr`, stdout giữ đúng 1 JSON envelope.
- `tests/stream.test.mjs` (mới, 5 tests): forward đủ/đúng từng stream (xuyên
  stream không assert thứ tự — 2 pipe riêng), callback throw không giết run,
  `generate onStream` thấy bytes, CLI `--stream` tách đúng stdout/stderr.
- `SKILL.md` + `README.md`: đoạn `--stream` trong mục Full access / generate.
