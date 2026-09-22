# Native AI CLI Invocation Matrix & Cheatsheet

Tài liệu chuẩn hóa cú pháp gọi **Native AI CLI** và **WebMCP AI CLI Wrapper** trên toàn cụm máy (ATLAS local và ORBIT / Mac M1 remote).
Mục tiêu: Cung cấp lệnh headless 1-shot đã được kiểm chứng cho mọi AI Agent/Coordinator, loại bỏ hoàn toàn nhu cầu phải chạy `--help` gây tốn token và lượt gọi tool.

---

## 1. Bảng Tổng Hợp Nhanh (At-a-Glance Matrix)

| Provider | Model Chủ Lực | CLI Binary | Cờ Headless Bắt Buộc | Input Prompt | Trích Xuất Kết Quả | Lưu Ý Sống Còn |
|---|---|---|---|---|---|---|
| **Codex CLI** | `gpt-6-sol`<br>`gpt-5.6-luna` | `codex` | `exec --sandbox read-only --ephemeral --skip-git-repo-check -c approval_policy=never` | Stdin + dấu `-` cuối lệnh | `--output-last-message <f.md>` (hoặc parse stream JSONL) | **BẮT BUỘC** `--skip-git-repo-check` trên Codex 0.155.0+. Thiếu `-` ở cuối sẽ bị treo prompt. |
| **Claude Code** | `claude-opus-5-5`<br>`claude-sonnet-4-6` | `claude` | `-p --output-format json --restricted` | `< prompt.txt` (stdin) | Thuộc tính `.result` trong stdout JSON | **BẮT BUỘC** `-p` để tránh mở UI TUI interactive. `--restricted` tắt tools can thiệp shell/code. |
| **OpenCode (v2)** | `opencode-go/deepseek-v4.1-flash`<br>`opencode-go/muse-spark-1.3-contributor` | `opencode` | `run --standalone` | Đối số chuỗi hoặc stdin `< prompt.txt` | Text trực tiếp trên stdout hoặc parse NDJSON | **KHÔNG** ép biến `OPENCODE_DB` sang file DB rỗng/chưa sync vì sẽ mất quyền subscription Go models. |
| **Antigravity** | `gemini-3.8-flash-high`<br>`claude-opus-4-6-thinking` | `agy` (hoặc wrapper) | `--agent-mode plan` (khi qua wrapper) | `-p "..."` hoặc stdin | `response.text` (hoặc brain artifact .md) | `claude-opus-4-6-thinking` **KHÔNG** hỗ trợ `--effort` (sẽ lỗi exit 1). Gemini Flash hỗ trợ `--effort high`. |
| **WebMCP AI** | Mọi model trên | `webmcp-ai` | `generate --json` | `--prompt "..."` hoặc `--prompt-file <path>` | Chuẩn JSON `{ ok: true, response: { text } }` | Wrapper thống nhất tự động cô lập workspace, chuẩn hóa mã lỗi `error.code`. |

---

## 2. Chi Tiết Từng Provider & Mẫu Lệnh 1-Shot

### A. Codex CLI (Native)
- **Đường dẫn binary**:
  - ATLAS: `/Users/ttcenter/.local/bin/codex` hoặc `/Applications/ChatGPT.app/Contents/Resources/codex`
  - ORBIT (Mac M1): `/Users/uyenuyen/.local/bin/codex` (truy cập qua `ssh mac-m1`)
- **Mẫu lệnh Headless 1-Shot**:
  ```bash
  codex exec \
    --model gpt-6-sol \
    --sandbox read-only \
    --ephemeral \
    --skip-git-repo-check \
    -c model_reasoning_effort=high \
    -c approval_policy=never \
    --output-last-message "/path/to/response.md" \
    - < "/path/to/prompt.txt" > /path/to/events.jsonl 2> /path/to/stderr.log
  ```
- **Quy tắc trích xuất**:
  - Nội dung phản hồi hoàn chỉnh của model được lưu trực tiếp vào file chỉ định tại `--output-last-message`.
  - Stdout in stream telemetry JSONL; stderr chứa log chẩn đoán.

---

### B. Claude Code CLI (Native)
- **Đường dẫn binary**:
  - `/Users/ttcenter/.local/bin/claude` (Claude Code CLI v2.1.280+)
- **Mẫu lệnh Headless 1-Shot**:
  ```bash
  claude -p \
    --model claude-opus-5-5 \
    --effort high \
    --output-format json \
    --restricted \
    < "/path/to/prompt.txt" > "/path/to/out.json" 2> "/path/to/stderr.log"
  ```
- **Quy tắc trích xuất**:
  - Đọc trường `.result` từ file `out.json`.
  - Nếu `is_error: true`, đọc mã lỗi tại `.subtype`.

---

### C. OpenCode CLI v2 (Native)
- **Đường dẫn binary**:
  - `/Users/ttcenter/.opencode/bin/opencode` (OpenCode v2.0.12+)
- **Model độc quyền**:
  - DeepSeek: `opencode-go/deepseek-v4.1-flash` (BẮT BUỘC dùng v4.1, TUYỆT ĐỐI CẤM model `deepseek-v4-flash` cũ).
  - Muse: `opencode-go/muse-spark-1.3-contributor` (hỗ trợ `--effort xhigh`).
  - 9Router: `9router/deepseek-v4.1-flash`.
- **Mẫu lệnh 1-Shot**:
  ```bash
  # Cách 1: Truyền prompt inline trực tiếp
  opencode run --standalone --model opencode-go/deepseek-v4.1-flash "Nội dung prompt ở đây"

  # Cách 2: Nhận prompt từ file qua format JSON
  opencode run --standalone --format json --agent plan --model opencode-go/deepseek-v4.1-flash \
    < "/path/to/prompt.txt" > "/path/to/out.json" 2> "/path/to/stderr.log"
  ```
- **Lưu ý Database & Subscription**:
  - OpenCode v2 quản lý subscription và credentials trong bảng `credential` của database `~/.local/share/opencode/opencode.db`.
  - Khi chạy native, luôn để CLI tự kết nối database mặc định, không override biến `OPENCODE_DB` trừ khi đã đồng bộ bảng `credential`.

---

### D. WebMCP AI CLI Wrapper (Khuyên Dùng Cho Workflow Tự Động)
- **Đường dẫn binary**:
  - `/Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-ai-cli/bin/webmcp-ai.mjs`
  - Hoặc alias toàn cục: `webmcp-ai`
- **Mẫu lệnh 1-Shot**:
  ```bash
  # 1. Gọi DeepSeek qua OpenCode:
  node "$AI_CLI" generate \
    --provider opencode \
    --model opencode-go/deepseek-v4.1-flash \
    --prompt-file "/path/to/prompt.txt" \
    --workspace "$PWD" \
    --agent-mode plan \
    --json > out.json

  # 2. Gọi Codex qua wrapper:
  node "$AI_CLI" generate \
    --provider codex \
    --model gpt-6-sol \
    --effort high \
    --prompt-file "/path/to/prompt.txt" \
    --json > out.json

  # 3. Gọi Gemini Flash qua AGY:
  node "$AI_CLI" generate \
    --provider agy \
    --model gemini-3.8-flash-high \
    --effort high \
    --prompt-file "/path/to/prompt.txt" \
    --json > out.json
  ```
- **Quy tắc trích xuất**:
  - Kiểm tra `ok: true` $\rightarrow$ lấy nội dung tại `response.text`.
  - Nếu `ok: false` $\rightarrow$ đọc mã lỗi tại `error.code` (ví dụ: `PROVIDER_AUTH_FAILED`, `PROVIDER_NO_ROUTE`, `RATE_LIMIT_EXCEEDED`).

---

## 3. Checklist Preflight Cho Agent Trước Khi Dispatch Lệnh
1. **Kiểm tra Quota**:
   - `node /Users/ttcenter/Desktop/VIBE_CODE/.agents/skills/ai-cli-usage/scripts/get-quotas.mjs --all --json`
2. **Quy tắc Fallback Model**:
   - Codex 5h window = 0% $\rightarrow$ Route sang Mac M1 (`ssh mac-m1`) hoặc chuyển Reviewer L2 sang Claude Opus 5.5 / DeepSeek v4.1 Flash.
   - Claude Weekly < 20% $\rightarrow$ Ưu tiên dùng AGY Claude hoặc AGY Gemini Flash để bảo vệ hạn ngạch Claude Code CLI.
3. **Lineage Honesty**:
   - Ghi nhận đúng provider và model trong nhật ký / ledger; không ngụy tạo model hoặc đổi tên route.
