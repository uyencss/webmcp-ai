---
name: ai-role-dispatch
description: >-
  Phân rã vai trò model AI (Orchestrator, Writer, Reviewer Lớp 1, Reviewer Lớp 2, Auditor)
  kèm ma trận model fallback đa tầng tự động dựa trên hạn ngạch (quota) thời gian thực.
  Quy định nghiêm ngặt ranh giới provider độc quyền OpenCode và cảnh báo chi phí DeepSeek v4.1 flash.
---

# AI Role Dispatch & Fallback Matrix

Tài liệu đặc tả và kỹ năng điều phối phân vai model AI cho WebMCP AI Orchestration. Kỹ năng này phân rã toàn bộ logic gán vai trò model ra khỏi chính sách vận hành chung của workspace, cung cấp một **ma trận vai trò độc lập** (`roles.manifest.json`) kèm **chuỗi fallback tự động** khi cạn quota hoặc sự cố provider.

---

## 1. Nguyên tắc cốt lõi: Tách biệt vai trò (Separation of Duties)

Để đảm bảo tính khách quan và ngăn chặn việc tự phê duyệt sai lệch:
1. **Orchestrator / Coordinator**: Quản lý write-set, kế hoạch, commit, gate và tổng hợp kết quả. **KHÔNG** tự review mã nguồn do mình hoặc do writer dưới quyền tạo ra.
2. **Primary Writer**: Chỉ ghi mã vào candidate workspace được chỉ định. **KHÔNG** commit, không promote và không tự review. Là **Muse Spark 1.3 Contributor** (`opencode-go/muse-spark-1.3-contributor`, `xhigh`). Fallback là AGY Gemini Flash hoặc Claude Sonnet. **TUYỆT ĐỐI CẤM dùng DeepSeek (kể cả DeepSeek v4.1 flash) làm writer dưới mọi hình thức; KHÔNG dùng GLM làm fallback**.
3. **Reviewer Lớp 1 (Pre-acceptance / Hygiene / Review phụ)**: Kiểm tra cú pháp, convention, unit test, documentation. **BẮT BUỘC đổi lineage (swap rule)** so với Writer:
   - Nếu Writer là Muse $\rightarrow$ Reviewer L1 pre-accept / review phụ là AGY Gemini Flash (`gemini-3.8-flash-high`, `high`) hoặc AGY Claude Sonnet (`claude-sonnet-4-6`).
   - Nếu Writer là AGY (fallback) $\rightarrow$ Reviewer L1 pre-accept / review phụ PHẢI ĐỔI sang Muse 1.3 (cấm tự review).
4. **Reviewer Lớp 2 (Milestone & Final Acceptance Gate)**: Độc lập đánh giá logic nghiệp vụ, tính an toàn, hồi quy. Quyết định pass/fail cuối cùng trước khi promote.
5. **Auditor / Red Team**: Độc lập tìm kiếm lỗ hổng, anti-pattern, over-engineering (kết hợp `ponytail-review`).

---

## 2. Ma trận phân vai & Chuỗi Model Fallback

Dữ liệu chuẩn hóa máy đọc được định nghĩa tại [`roles.manifest.json`](roles.manifest.json).

| Vai trò | Primary Model & Route | Fallback Cấp 1 | Fallback Cấp 2 / Dự phòng khẩn cấp |
|---|---|---|---|
| **🎯 Orchestrator** | **Native Codex Sol/Luna**<br>`gpt-5.6-luna` (reasoning `max`) trên ATLAS | **OpenCode DeepSeek**<br>`opencode-go/deepseek-v4.1-flash` (khi Codex 5h = 0%) | **Interactive Coordinator**<br>Agent IDE/CLI đang chủ trì phiên |
| **✍️ Primary Writer**<br>*(⛔ CẤM DeepSeek & GLM)* | **OpenCode Muse Contributor**<br>`opencode-go/muse-spark-1.3-contributor` (`xhigh`) | **AGY Gemini**<br>`gemini-3.8-flash-high` (`high`) | **AGY Claude** (`claude-sonnet-4-6`)<br>*(⛔ CẤM DeepSeek, KHÔNG dùng GLM)* |
| **🔍 Reviewer Lớp 1**<br>*(Pre-acceptance / Review phụ)* | **AGY Gemini Flash High**<br>`gemini-3.8-flash-high` (`high`)<br>*(khi Writer là Muse)* | **OpenCode Muse Contributor**<br>`opencode-go/muse-spark-1.3-contributor`<br>*(khi Writer là AGY)* | **AGY Claude Sonnet** / **9Router Claude Opus**<br>*(khi cần audit sâu hoặc swap)* |
| **🛡️ Reviewer Lớp 2**<br>*(Final Acceptance Gate)* | **Native Codex Sol (ATLAS)**<br>`gpt-5.6-sol` (reasoning `high`) | **Native Codex Sol (ORBIT / Mac M1)**<br>`ssh mac-m1 'codex exec ...'`<br>*(khi ATLAS hết quota 5h)* | **Direct Claude Code CLI** (`opus`) hoặc **OpenCode DeepSeek** (`opencode-go/deepseek-v4.1-flash`) |
| **⚖️ Auditor / Red Team** | **AGY Claude Thinking**<br>`claude-opus-4-6-thinking` (`plan`) | **Native Codex Sol**<br>`gpt-5.6-sol` (ephemeral sandbox `read-only`) | **AGY Gemini Flash**<br>`gemini-3.8-flash-high` (`high`) |

---

## 3. Ranh giới Provider & Ràng buộc Chi phí Bắt buộc

> ### ⚠️ QUY TẮC BẤT DI BẤT DỊCH (INVARIANTS):
>
> 1. **Phạm vi độc quyền của OpenCode (`--provider opencode`)**:
>    - OpenCode **CHỈ ĐƯỢC PHÉP** dùng để gọi các model thuộc **hệ DeepSeek** và **hệ Muse** (`opencode-go/deepseek-v4.1-flash`, `opencode-go/muse-spark-1.3-contributor`). Model Stealth Union Alpha đã bị gỡ bỏ (retired 2026-09-18) do không còn trong provider list.
>    - **TUYỆT ĐỐI NGHIÊM CẤM** dùng OpenCode để spawn các model Claude, GPT, Sol/Luna hay Gemini qua các alias trung gian.
> 2. **CẤM TUYỆT ĐỐI DÙNG DEEPSEEK LÀM WRITER**:
>    - **NGHIÊM CẤM**: Mọi model thuộc hệ DeepSeek (kể cả `deepseek-v4.1-flash`, `opencode-go/deepseek-v4.1-flash` hay qua 9Router) **TUYỆT ĐỐI KHÔNG ĐƯỢC DÙNG LÀM WRITER**.
>    - DeepSeek **CHỈ ĐƯỢC PHÉP** dùng làm fallback khẩn cấp cho **Orchestrator** hoặc **Reviewer Lớp 2** khi Codex Sol / Claude Code cạn kiệt quota.
>    - Writer chỉ thuộc về Muse 1.3 (Primary) hoặc AGY Gemini Flash / Claude Sonnet (Fallback). TUYỆT ĐỐI KHÔNG dùng GLM làm fallback dưới mọi hình thức.
> 3. **CẤM DÙNG GLM LÀM FALLBACK**:
>    - **TUYỆT ĐỐI KHÔNG** dùng GLM (kể cả `9router/glm-5.3-flash`) làm fallback cho Writer hoặc bất kỳ vai trò nào khác trong hệ thống.
> 4. **Ràng buộc chi phí DeepSeek**:
>    - Khi kích hoạt DeepSeek cho Orchestrator/Reviewer L2, **BẮT BUỘC PHẢI DÙNG ĐÚNG** `opencode-go/deepseek-v4.1-flash`.
>    - **TUYỆT ĐỐI KHÔNG DÙNG** `opencode-go/deepseek-v4-flash`, `deepseek-v4-pro` hay các bản `v4` cũ vì chi phí token cực kỳ đắt đỏ.
> 5. **Trạng thái Stealth Union Alpha**:
>    - Model `opencode-go/union-alpha` / `union-stealth` đã bị off và retired hoàn toàn khỏi vòng xoay writer và reviewer. Cấm gọi hoặc định tuyến vào model này.
> 6. **Toàn vẹn Lineage**:
>    - Tất cả model Claude, Sol (OpenAI) và Gemini bắt buộc spawn qua CLI gốc trên máy (`codex`, `claude`, `agy`) hoặc WebMCP AI CLI wrapper (`--provider agy`, `--provider codex`, `--provider claude`).
>    - Biên nhận (Receipt) phải ghi đúng model thực tế, không được dán nhãn OpenCode alias là native Sol/Luna.

---

## 4. Quota Preflight & Điều phối Đa máy (Cluster Dispatch)

Trước khi kích hoạt writer nặng hoặc chạy review:
1. **Kiểm tra Quota toàn cụm**:
   ```bash
   curl -s "http://127.0.0.1:8421/api/quotas?all=1"
   # hoặc script helper:
   node .agents/skills/ai-cli-usage/scripts/get-quotas.mjs --all --json
   ```
2. **Luật kích hoạt Fallback theo Quota**:
   - **Nếu ATLAS Codex 5h window = 0%**:
     - Thử route sang node **ORBIT** (Mac M1 qua Tailscale): `ssh mac-m1 'codex exec --model gpt-5.6-sol ...'`.
     - Nếu ORBIT cũng cạn: Chuyển Reviewer L2 sang Direct Claude Code CLI (nếu Weekly $\ge 20\%$) hoặc kích hoạt fallback `opencode-go/deepseek-v4.1-flash`.
   - **Nếu Claude Code Weekly < 20%**:
     - Khóa Direct Claude Code CLI để bảo tồn quota khẩn cấp.
     - Chuyển sang AGY Claude (dùng quota Google AI Studio/Antigravity riêng) hoặc AGY Gemini Flash.

---

## 5. Mẫu lệnh Dispatch CLI cho từng vai trò

Các lệnh dưới đây sử dụng WebMCP AI CLI entrypoint và OpenCode Native Subagents:
```bash
AI_CLI="${AI_CLI:-$PWD/webmcp-automation-kit/packages/webmcp-ai-cli/bin/webmcp-ai.mjs}"
OPENCODE_BIN="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"
AGY_BIN="${AGY_BIN:-$HOME/.local/bin/agy}"
CODEX_BIN="${CODEX_BIN:-$HOME/.local/bin/codex}"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
```

### ✍️ Writer: Muse Contributor (Primary Option 1)
```bash
OPENCODE_BIN="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}" node "$AI_CLI" generate \
  --provider opencode --model opencode-go/muse-spark-1.3-contributor --effort xhigh \
  --prompt-file "$PROMPT_PATH" --workspace "$PWD" --agent-mode plan \
  --events --timeout-ms 2300000 --json > out.json 2> stderr.log
```

### 🔍 Reviewer Lớp 1: AGY Gemini Flash (Swap khi Writer là Muse)
```bash
AGY_BIN="${AGY_BIN:-$HOME/.local/bin/agy}" node "$AI_CLI" generate \
  --provider agy --model gemini-3.8-flash-high --effort high \
  --prompt-file "$PROMPT_PATH" --workspace "$PWD" --agent-mode plan \
  --events --timeout-ms 2300000 --json > out.json 2> stderr.log
```

### 🛡️ Reviewer Lớp 2: Native Codex Sol trên ATLAS (Primary Acceptance)
```bash
"${CODEX_BIN:-$HOME/.local/bin/codex}" exec \
  --model gpt-5.6-sol --sandbox read-only --ephemeral --json \
  --skip-git-repo-check --output-last-message "$OUT/sol.md" \
  -c model_reasoning_effort=high -c approval_policy=never - \
  < "$PROMPT_PATH" > sol.events.jsonl 2> stderr.log
```

### 🛡️ Reviewer Lớp 2: Remote Codex Sol trên ORBIT (Fallback 1 khi ATLAS hết quota)
```bash
ssh mac-m1 "codex exec \
  --model gpt-5.6-sol --sandbox read-only --ephemeral --json \
  --output-last-message '$REMOTE_OUT/sol.md' \
  -c model_reasoning_effort=high -c approval_policy=never -" \
  < "$PROMPT_PATH"
```

### 🛡️ Reviewer Lớp 2: OpenCode DeepSeek v4.1 Flash (Fallback khẩn cấp khi Sol cạn)
```bash
OPENCODE_BIN="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}" node "$AI_CLI" generate \
  --provider opencode --model opencode-go/deepseek-v4.1-flash --effort high \
  --prompt-file "$PROMPT_PATH" --workspace "$PWD" --agent-mode plan \
  --events --timeout-ms 2300000 --json > out.json 2> stderr.log
```

---

## 6. Biên nhận hoàn thành (Receipt Template)

Mọi lần dispatch review/writer phải lưu receipt kèm thông tin lineage trung thực:

```markdown
### Dispatch Receipt
- **Timestamp**: <YYYY-MM-DD HH:mm:ss>
- **Role**: <orchestrator | writer | reviewer_l1 | reviewer_l2 | auditor>
- **Dispatched Route**: <codex | agy | opencode | claude-cli>
- **Exact Model ID**: <vd: opencode-go/deepseek-v4.1-flash | gpt-5.6-sol>
- **Fallback Triggered**: <None | Quota ATLAS 5h=0% | Lineage swap | Network timeout>
- **Node**: <ATLAS | ORBIT>
- **Input Prompt SHA-256**: <hash>
- **Output Artifact SHA-256**: <hash>
- **Status**: <PASS | FAIL | BLOCKED_PROVIDER_ROUTE>
```
