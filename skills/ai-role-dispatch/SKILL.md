---
name: ai-role-dispatch
description: >-
  Phân rã vai trò model AI (Orchestrator, Writer, Reviewer Lớp 1, Reviewer Lớp 2, Auditor)
  kèm ma trận model fallback đa tầng tự động dựa trên hạn ngạch (quota) thời gian thực.
  Định tuyến Sonnet 5.5 cho review code nhanh hoặc worker/fixer theo tính chất task và số lần retry, đồng thời giữ ranh giới provider OpenCode và cảnh báo chi phí DeepSeek v4.1 flash.
---

# AI Role Dispatch & Fallback Matrix

Tài liệu đặc tả và kỹ năng điều phối phân vai model AI cho WebMCP AI Orchestration. Kỹ năng này phân rã toàn bộ logic gán vai trò model ra khỏi chính sách vận hành chung của workspace, cung cấp một **ma trận vai trò độc lập** (`roles.manifest.json`) kèm **chuỗi fallback tự động** khi cạn quota hoặc sự cố provider.

---

## 1. Nguyên tắc cốt lõi: Tách biệt vai trò (Separation of Duties)

Để đảm bảo tính khách quan và ngăn chặn việc tự phê duyệt sai lệch:
1. **Orchestrator / Coordinator**: Quản lý write-set, kế hoạch, commit, gate và tổng hợp kết quả. **KHÔNG** tự review mã nguồn do mình hoặc do writer dưới quyền tạo ra.
2. **Primary Writer**: Chỉ ghi mã vào candidate workspace được chỉ định. **KHÔNG** commit, không promote và không tự review. Là **Muse Spark 1.3 Contributor** (`opencode-go/muse-spark-1.3-contributor`, `xhigh`). Fallback là AGY Gemini Flash hoặc Claude Sonnet. **TUYỆT ĐỐI CẤM dùng DeepSeek (kể cả DeepSeek v4.1 flash) làm writer dưới mọi hình thức; KHÔNG dùng GLM làm fallback**.
3. **Reviewer Lớp 1 (Pre-acceptance / Hygiene / Review phụ)**: Review diff, test completeness, regression/API contract, cú pháp và convention. **BẮT BUỘC đổi lineage (swap rule)** so với Writer:
   - Nếu Writer là Muse $\rightarrow$ ưu tiên **Claude Code Sonnet 5.5 High** cho review nhanh, scope rõ; AGY Gemini Flash (`gemini-3.8-flash-high`, `high`) hoặc AGY Claude Sonnet (`claude-sonnet-4-6`) là lựa chọn phụ. Sonnet chỉ làm reviewer L1, không làm final acceptance gate.
   - Nếu Writer là AGY (fallback) $\rightarrow$ Reviewer L1 pre-accept / review phụ PHẢI ĐỔI sang Muse 1.3 (cấm tự review).
   - Nếu Writer là Direct Claude Code Sonnet 5.5 $\rightarrow$ Reviewer L1 dùng Muse hoặc Gemini, không dùng Claude cùng lineage.
4. **Reviewer Lớp 2 (Milestone & Final Acceptance Gate - Reviewer chính)**: Độc lập đánh giá logic nghiệp vụ, tính an toàn, hồi quy. Quyết định pass/fail cuối cùng trước khi promote. Reviewer chính ưu tiên Native Codex **`gpt-6-sol`** trên ATLAS / ORBIT, hoặc **Claude Code Opus 5.5** (`claude-opus-5-5` / alias `opus`).
5. **Auditor / Red Team**: Độc lập tìm kiếm lỗ hổng, anti-pattern, over-engineering (kết hợp `ponytail-review`).

---

## 2. Ma trận phân vai & Chuỗi Model Fallback

Dữ liệu chuẩn hóa máy đọc được định nghĩa tại [`roles.manifest.json`](roles.manifest.json).

| Vai trò | Primary Model & Route | Fallback Cấp 1 | Fallback Cấp 2 / Dự phòng khẩn cấp |
|---|---|---|---|
| **🎯 Orchestrator** | **Native Codex Sol/Luna**<br>`gpt-5.6-luna` (reasoning `max`) trên ATLAS | **OpenCode DeepSeek**<br>`opencode-go/deepseek-v4.1-flash` (khi Codex 5h = 0%) | **Interactive Coordinator**<br>Agent IDE/CLI đang chủ trì phiên |
| **✍️ Primary Writer**<br>*(⛔ CẤM DeepSeek & GLM)* | **OpenCode Muse Contributor**<br>`opencode-go/muse-spark-1.3-contributor` (`xhigh`) | **AGY Gemini**<br>`gemini-3.8-flash-high` (`high`) | **AGY Claude** (`claude-sonnet-4-6`)<br>**Direct / escalation lane:** Claude Code Sonnet 5.5 (`claude-sonnet-5-5`) theo mục 2.1 |
| **🔍 Reviewer Lớp 1**<br>*(Pre-acceptance / Review phụ)* | **Claude Code Sonnet 5.5 High**<br>`claude-sonnet-5-5` (`high`)<br>*(review nhanh khi Writer là Muse)* | **OpenCode Muse Contributor**<br>`opencode-go/muse-spark-1.3-contributor`<br>*(khi Writer là AGY/Claude)* | **AGY Gemini Flash High** (`gemini-3.8-flash-high`)<br>hoặc AGY Claude Sonnet (`claude-sonnet-4-6`), tuân swap rule |
| **🛡️ Reviewer Lớp 2**<br>*(Reviewer chính / Final Gate)* | **Native Codex Sol (ATLAS)**<br>`gpt-6-sol` (reasoning `high`) | **Native Codex Sol (ORBIT / Mac M1)**<br>`ssh mac-m1 'codex exec --model gpt-6-sol ...'`<br>*(khi ATLAS hết quota 5h)* | **Claude Code CLI Opus 5.5** (`claude-opus-5-5` / `opus`) hoặc **OpenCode DeepSeek** (`opencode-go/deepseek-v4.1-flash`) |
| **⚖️ Auditor / Red Team** | **AGY Claude Thinking**<br>`claude-opus-4-6-thinking` (`plan`) | **Native Codex Sol**<br>`gpt-6-sol` (ephemeral sandbox `read-only`) | **AGY Gemini Flash**<br>`gemini-3.8-flash-high` (`high`) |

---

## 2.1. Chọn Sonnet 5.5 cho review nhanh hoặc worker/fixer

Coordinator đánh giá **tính chất task trước khi spawn**. Giữ nguyên coordinator và Reviewer L2 trong ma trận. Sonnet 5.5 là reviewer phụ L1 cho diff rõ scope, hoặc implementation worker/final fixer cho write-set phù hợp; **không** dùng làm coordinator mặc định, reviewer chính final gate, hay worker cho task đơn giản có cách làm và phép kiểm tra rõ ràng.

**Review nhanh / bình thường:** Ưu tiên Sonnet 5.5 High cho code/diff review, test completeness, regression và API-contract checks khi phạm vi rõ và khác lineage Writer. Reviewer chỉ đọc, báo finding kèm bằng chứng; **không spawn agent, không sửa code**. Nếu gặp lỗi logic phức tạp, architecture conflict, worker disagreement, root cause chưa rõ hoặc `retryCount >= 2`, chuyển sang Sol High làm reviewer L2/final arbiter. Giữ Muse 1.3 là reviewer L1 khi Writer là AGY/Claude; không để Sonnet tự review diff do nó viết.

**Direct dispatch tại `retryCount = 0`** khi task đã có scope, write-set và acceptance criteria rõ, đồng thời có ít nhất một yếu tố làm worker thường dễ tốn nhiều vòng sửa: bug khó cần lần theo codebase; implementation/refactor nhiều file qua ranh giới module hoặc dependency; integration nhiều thành phần; công việc CLI dài nhiều bước; frontend/UI cần chất lượng thiết kế và kiểm tra ở mức cao. Đây là tiêu chí định tuyến của hệ thống dựa trên [mô tả năng lực Sonnet 5.5 của Anthropic](https://www.anthropic.com/claude-sonnet-5-5), không phải bảo đảm nó sẽ thắng mọi task. Nếu bài toán kiến trúc còn quá mở, coordinator làm rõ plan và gate trước khi giao phần implementation đã scope cho Sonnet.

`retryCount` = số **lần thử giải task đã thất bại** với cùng task/nguyên nhân; ban đầu là 0, sau lần thất bại đầu là 1. Đổi worker không xóa bộ đếm. Lỗi route như quota, mạng hay model ID không tính là lần thất bại logic. Ghi lệnh/test, log lỗi, diff và giả thuyết đã thử để tránh lặp cùng một cách sửa.

| Điều kiện | Route |
|---|---|
| `retryCount = 0` và đạt tiêu chí direct dispatch ở trên | Giao thẳng Claude Code CLI Sonnet 5.5; ghi lý do chọn, write-set và acceptance criteria. Không bắt worker thường thất bại trước. |
| `retryCount = 0–1`, task đơn giản hoặc lỗi cục bộ/deterministic, confidence về nguyên nhân và cách sửa `>= 0.65`, không đạt tiêu chí direct dispatch | Muse writer thường; dùng Gemini/Claude 4.6 fallback theo ma trận khi route chính không khả dụng. Sau lần fail đầu phải thay đổi giả thuyết dựa trên log. |
| `retryCount >= 2` với cùng lỗi chưa giải quyết | Escalate sang **Claude Code CLI Sonnet 5.5** (`claude-sonnet-5-5`) để chẩn đoán rồi sửa trong write-set được giao. |
| Bất kỳ retry nào, kể cả 0, có lỗi logic nghiệp vụ khó, integration nhiều thành phần, dependency/cycle khó gỡ, hoặc task không đơn giản với confidence `< 0.65` kèm bằng chứng cụ thể | Escalate sớm sang Sonnet 5.5. Confidence chỉ hỗ trợ định tuyến, không thay thế bằng chứng. |
| Nhiều worker sửa thất bại hoặc đưa ra diff mâu thuẫn | Sonnet 5.5 đọc plan, diff, log và test để làm final fixer; có thể review phụ L1 nếu **không** viết chính diff đó. Reviewer L2 độc lập vẫn quyết định final acceptance. |

Trước khi dispatch Sonnet, xác nhận CLI/model khả dụng và quota theo mục 4. Handoff gồm acceptance criteria, write-set, `retryCount`, lý do direct/escalation, failure type và bằng chứng nếu đã có retry, cùng diff hiện tại nếu có. Nếu Sonnet không khả dụng, ghi blocker và dùng fallback đã cho phép; không âm thầm giả là đã chạy Sonnet. Sau một lượt Sonnet vẫn không đạt acceptance criteria, dừng retry tự động và trả bằng chứng cho coordinator để re-plan.

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
     - Thử route sang node **ORBIT** (Mac M1 qua Tailscale): `ssh mac-m1 'codex exec --model gpt-6-sol ...'`.
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

### 🛡️ Reviewer Lớp 2: Native Codex Sol trên ATLAS (Reviewer chính / Primary Acceptance)
```bash
"${CODEX_BIN:-$HOME/.local/bin/codex}" exec \
  --model gpt-6-sol --sandbox read-only --ephemeral --json \
  --skip-git-repo-check --output-last-message "$OUT/sol.md" \
  -c model_reasoning_effort=high -c approval_policy=never - \
  < "$PROMPT_PATH" > sol.events.jsonl 2> stderr.log
```

### 🛡️ Reviewer Lớp 2: Remote Codex Sol trên ORBIT (Fallback 1 khi ATLAS hết quota)
```bash
ssh mac-m1 "codex exec \
  --model gpt-6-sol --sandbox read-only --ephemeral --json \
  --skip-git-repo-check \
  --output-last-message '$REMOTE_OUT/sol.md' \
  -c model_reasoning_effort=high -c approval_policy=never -" \
  < "$PROMPT_PATH"
```

### 🛡️ Reviewer Lớp 2: Direct Claude Code CLI trên ATLAS (Reviewer chính Final Acceptance)
```bash
"${CLAUDE_BIN:-$HOME/.local/bin/claude}" -p \
  --model claude-opus-5-5 \
  < "$PROMPT_PATH" > "$OUT/claude-opus.md" 2> stderr.log
```

### 🛡️ Reviewer Lớp 2: OpenCode DeepSeek v4.1 Flash (Fallback khẩn cấp khi Sol & Claude cạn)
```bash
OPENCODE_BIN="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}" node "$AI_CLI" generate \
  --provider opencode --model opencode-go/deepseek-v4.1-flash --effort high \
  --prompt-file "$PROMPT_PATH" --workspace "$PWD" --agent-mode plan \
  --events --timeout-ms 2300000 --json > out.json 2> stderr.log
```

### 🔍 Reviewer Lớp 1: Claude Code Sonnet 5.5 High (review nhanh)
```bash
"${CLAUDE_BIN:-$HOME/.local/bin/claude}" -p \
  --model claude-sonnet-5-5 --effort high --permission-mode plan \
  --tools "Read,Glob,Grep" --disallowedTools "mcp__*" \
  < "$PROMPT_PATH" > "$OUT/sonnet-5-5-review.md" 2> stderr.log
```

Prompt cần kèm diff, scope và tiêu chí review; reviewer chỉ đọc, không spawn agent hoặc tự sửa code. Nếu Sonnet đã viết diff, dùng Muse/Gemini cho L1.

### ✍️ Direct Writer / Escalation Final Fixer: Claude Code Sonnet 5.5
```bash
"${CLAUDE_BIN:-$HOME/.local/bin/claude}" -p \
  --model claude-sonnet-5-5 \
  < "$PROMPT_PATH" > "$OUT/sonnet-5-5.md" 2> stderr.log
```

Chỉ gọi route writer khi đạt điều kiện direct dispatch hoặc escalation ở mục 2.1. Chạy trong candidate workspace và giới hạn quyền ghi theo write-set.

---

## 6. Biên nhận hoàn thành (Receipt Template)

Mọi lần dispatch review/writer phải lưu receipt kèm thông tin lineage trung thực:

```markdown
### Dispatch Receipt
- **Timestamp**: <YYYY-MM-DD HH:mm:ss>
- **Role**: <orchestrator | writer | reviewer_l1 | reviewer_l2 | auditor>
- **Dispatched Route**: <codex | agy | opencode | claude-cli>
- **Exact Model ID**: <vd: opencode-go/deepseek-v4.1-flash | gpt-6-sol>
- **Routing Reason**: <ordinary | direct Sonnet 5.5: task characteristics | escalation: retryCount>=2 | escalation: hard logic/integration/dependency | fallback: quota/route>
- **Retry Count / Failure Type / Confidence**: <số lần thất bại / loại lỗi / mức tin cậy cùng bằng chứng>
- **Node**: <ATLAS | ORBIT>
- **Input Prompt SHA-256**: <hash>
- **Output Artifact SHA-256**: <hash>
- **Status**: <PASS | FAIL | BLOCKED_PROVIDER_ROUTE>
```
