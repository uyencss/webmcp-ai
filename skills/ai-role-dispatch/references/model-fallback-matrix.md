# Chi tiết Cây Quyết Định Fallback Model (Decision Flow Matrix)

Tài liệu tham chiếu chi tiết về luồng rẽ nhánh và kích hoạt Fallback khi gặp sự cố cạn quota, nghẽn mạng hoặc lỗi provider.

---

## 1. Sơ đồ luồng rẽ nhánh Reviewer Lớp 2 (Task/Milestone/Phase Preview & Final Plan Review)

```
[Bắt đầu Review Lớp 2]
         |
         +-------------------------------------------------------+
         |                                                       |
         v (Task / Milestone / Phase Preview)                    v (Final Review Toàn Plan)
+------------------------------------+                 +------------------------------------+
| Kiểm tra Quota AGY Gemini 4 Argon  |                 | Kiểm tra Quota Claude Code CLI     |
+------------------------------------+                 +------------------------------------+
         |                                                       |
    (Quota OK) --> [Dispatch AGY Gemini 4 Argon High]       (Weekly >= 20%) --> [Dispatch Claude Code CLI Opus 5.5]
         |                                                       |
         v (Hết Quota / Route Blocked hoặc Operator chọn)         v (Weekly < 20% hoặc cạn)
+------------------------------------+                 +------------------------------------+
| Lựa chọn Song Song / Dự Phòng:     |                 | Fallback 1: AGY Claude Opus 5.5    |
| OpenCode DeepSeek v4.1 Flash       |                 | (dùng quota Antigravity độc lập)   |
+------------------------------------+                 +------------------------------------+
         |                                                       |
         +--> [BẮT BUỘC: opencode-go/deepseek-v4.1-flash]        v (Toàn bộ Claude cạn)
              (TUYỆT ĐỐI CẤM deepseek-v4-flash)        +------------------------------------+
                                                       | Emergency Fallback:                |
                                                       | AGY Gemini 4 Argon Medium          |
                                                       +------------------------------------+
```

---

## 2. Sơ đồ luồng Writer & Đổi Lineage Reviewer Lớp 1 (Swap Rule)

```
[Lựa chọn Writer Chính]
         |
         +--> [Primary: AGY Gemini 3.8 Flash High (effort high)]
         |
    (Nếu cạn quota / escalation) ---> [Fallback 1: Claude Sonnet 5.5 / 4.6 (direct/escalation)]
         |
    (Nếu AGY unavailable) ----------> [Fallback 2: OpenCode Muse 1.3 Contributor (xhigh)]
         |
         v
+-------------------------------------------------------------------------+
| BẮT BUỘC ĐỔI LINEAGE CHO REVIEWER LỚP 1 (PREVIEW PRE-ACCEPTANCE / TESTS)|
+-------------------------------------------------------------------------+
         |
         +--> Nếu Writer là AGY Gemini Flash 3.8:
         |    Reviewer L1 Preview Preaccept = OpenCode Muse 1.3 Contributor (xhigh)
         |    Fallback L1 = Claude Code Sonnet 5.5 High
         |    (Đảm bảo ranh giới lineage độc lập tuyệt đối giữa AGY và OpenCode)
         |
         +--> Nếu Writer là Claude Sonnet 5.5 / 4.6:
         |    Reviewer L1 Preview Preaccept = OpenCode Muse 1.3 hoặc AGY Gemini Flash 3.8
         |
         +--> Nếu Writer là OpenCode Muse 1.3 (fallback lane):
              Reviewer L1 = Claude Code Sonnet 5.5 High hoặc AGY Gemini Flash 3.8
              (TUYỆT ĐỐI CẤM tự review cùng lineage)
```

Review L1 Sonnet 5.5 High chỉ đọc diff/scope rõ, kiểm tra test completeness, regression và API contract; không spawn agent hay tự sửa code. Đánh giá preview task/milestone/phase thuộc về Gemini 4 Argon (hoặc DeepSeek v4.1 Flash); logic phức tạp, architecture conflict, worker disagreement, root cause chưa rõ hoặc `retryCount >= 2` và duyệt toàn bộ plan thuộc về Claude Opus 5.5 / Gemini 4 Argon làm final arbiter L2.

> ⛔ **CẤM TUYỆT ĐỐI**:
> 1. KHÔNG bao giờ dùng DeepSeek (kể cả `deepseek-v4.1-flash`) cho vai trò **Writer** dưới bất kỳ hình thức nào. DeepSeek CHỈ ĐƯỢC PHÉP dùng làm preview task/milestone/phase (hoặc song song cùng Gemini 4 Argon) và fallback cho Orchestrator / Reviewer Lớp 2 khi các model chính cạn quota.
> 2. TUYỆT ĐỐI KHÔNG dùng GLM (kể cả `9router/glm-5.3-flash`) làm fallback cho Writer hoặc các vai trò khác trong ma trận điều phối.

---

## 3. Nhánh direct dispatch và escalation Sonnet 5.5

```text
[Task mới: retryCount = 0]
         |
         +--> Scope + write-set + acceptance criteria rõ;
         |    bug khó / implementation nhiều module / integration /
         |    CLI dài nhiều bước / UI cần chất lượng cao
         |      -> Giao trực tiếp Sonnet 5.5, ghi lý do chọn
         |
         +--> Đơn giản/deterministic hoặc không đạt direct fit
         |      -> Writer Gemini Flash 3.8; tối đa 1 lần retry có giả thuyết sửa mới
         |
         +--> Logic nghiệp vụ khó / integration nhiều thành phần /
         |    dependency khó, hoặc task không đơn giản với confidence < 0.65 có bằng chứng
         |      -> Claude Code CLI Sonnet 5.5 ngay
         |
         +--> Cùng nguyên nhân thất bại 2 lần (retryCount >= 2)
                -> Claude Code CLI Sonnet 5.5 làm final fixer
                   -> Reviewer L1 khác lineage -> Reviewer L2 (Gemini 4 Argon / Claude Opus 5.5) acceptance
```

Direct fit là tiêu chí chọn worker trước khi thử, không cần worker thường thất bại. Với kiến trúc còn mở, coordinator chốt plan và gate trước khi giao phần implementation đã scope. Nếu nhiều worker thất bại hoặc đưa ra diff mâu thuẫn, chuyển plan/diff/log/test cho Sonnet 5.5 để chẩn đoán và hợp nhất. Chỉ giao Sonnet 5.5 làm reviewer phụ L1 khi nó không viết diff đó. Lỗi mạng/quota/model ID là lỗi route: kiểm tra log và fallback theo provider, không tính như thất bại logic. Sau một lượt Sonnet không đạt acceptance criteria, dừng retry tự động và trả bằng chứng cho coordinator.

---

## 4. Bảng tổng hợp mã lỗi & hành động ứng phó

| Mã lỗi / Trạng thái | Nguyên nhân | Hành động ứng phó (Fallback Action) |
|---|---|---|
| `ARGON_QUOTA_EXHAUSTED` | Hết quota Gemini 4 Argon trên AGY | Chuyển sang OpenCode DeepSeek v4.1 Flash (`opencode-go/deepseek-v4.1-flash`, effort `high`) để preview task/milestone/phase. |
| `GEMINI_FLASH_QUOTA_EXHAUSTED` | Hết quota Gemini 3.8 Flash làm Writer | Chuyển sang Claude Sonnet 5.5 / 4.6 hoặc OpenCode Muse 1.3 Contributor (`opencode-go/muse-spark-1.3-contributor`). |
| `CODEX_QUOTA_EXHAUSTED` | Hết quota 5h Codex trên ATLAS | Chuyển Orchestrator sang OpenCode DeepSeek v4.1 Flash hoặc Interactive Coordinator mode. |
| `CLAUDE_RATE_LIMITED` | Vượt rate limit hoặc weekly < 20% khi Final Plan Review | Chuyển sang AGY Claude Opus 5.5 (`claude-opus-5-5-high`) hoặc dùng Gemini 4 Argon làm arbiter. |
| `PROVIDER_EXIT_ERROR` | Lỗi crash process hoặc model selection không hợp lệ | Đọc `stderr.log`. Nếu do cờ `--effort` (ví dụ AGY Claude không hỗ trợ `--effort`), bỏ cờ và retry; nếu sập route, nhảy sang fallback tiếp theo trong `roles.manifest.json`. |
| `TASK_RETRY_ESCALATION` | `retryCount >= 2` với cùng nguyên nhân, hoặc nhiều worker sửa thất bại | Giao Sonnet 5.5 làm final fixer, kèm acceptance criteria, write-set, log/test và diff; giữ review độc lập. |
| `TASK_DIRECT_SONNET55` | Task đã scope rõ, có acceptance criteria và một direct fit nêu ở trên | Coordinator giao thẳng Sonnet 5.5 ở `retryCount = 0`, ghi lý do chọn và giữ review độc lập. |
| `HARD_LOGIC_ESCALATION` | Lỗi logic/integration/dependency khó hoặc task không đơn giản có confidence < 0.65 kèm bằng chứng | Giao Sonnet 5.5 sớm, kể cả `retryCount = 0`; không dùng cho task đơn giản. |
| `REVIEW_BLOCKED_PROVIDER_ROUTE` | Không còn route nào khả dụng | Báo cáo typed blocker lên Coordinator/Owner, ghi rõ log, KHÔNG tự bịa nội dung review. |
