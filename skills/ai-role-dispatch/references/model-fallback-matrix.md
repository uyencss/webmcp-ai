# Chi tiết Cây Quyết Định Fallback Model (Decision Flow Matrix)

Tài liệu tham chiếu chi tiết về luồng rẽ nhánh và kích hoạt Fallback khi gặp sự cố cạn quota, nghẽn mạng hoặc lỗi provider.

---

## 1. Sơ đồ luồng rẽ nhánh Reviewer Lớp 2 (Reviewer chính / Final Acceptance Gate)

```
[Bắt đầu Review Lớp 2 - Reviewer chính]
         |
         v
+-------------------------------+
| Kiểm tra Quota ATLAS Sol 5h    |
+-------------------------------+
         |
    (5h > 0% & Quota OK) ----> [Dispatch Native Codex Sol (gpt-6-sol) trên ATLAS]
         |
         v (5h = 0% hoặc Route Blocked)
+-------------------------------+
| Probe node ORBIT (Mac M1)     |
+-------------------------------+
         |
    (ORBIT Sol OK) ------------> [Dispatch gpt-6-sol qua Tailscale SSH mac-m1]
         |
         v (ORBIT không khả dụng hoặc hết quota)
+-------------------------------+
| Kiểm tra Quota Claude Code CLI|
+-------------------------------+
         |
    (Weekly >= 20%) -----------> [Dispatch Claude Code CLI Opus 5.5 (claude-opus-5-5 / opus)]
         |
         v (Weekly < 20% hoặc cạn)
+-------------------------------+
| KÍCH HOẠT DỰ PHÒNG KHẨN CẤP  |
| OpenCode DeepSeek v4.1 Flash  |
+-------------------------------+
         |
         +--> [BẮT BUỘC: opencode-go/deepseek-v4.1-flash]
              (TUYỆT ĐỐI CẤM deepseek-v4-flash)
```

---

## 2. Sơ đồ luồng Writer & Đổi Lineage Reviewer Lớp 1 (Swap Rule)

```
[Lựa chọn Writer Chính]
         |
         +--> [Primary: OpenCode Muse Contributor (xhigh)]
         |
    (Nếu lỗi/hết quota) ---------> [Fallback: AGY Gemini 3.8 Flash High]
         |
         v
+-------------------------------------------------------------------------+
| BẮT BUỘC ĐỔI LINEAGE CHO REVIEWER LỚP 1 (PRE-ACCEPTANCE / REVIEW PHỤ)   |
+-------------------------------------------------------------------------+
         |
         +--> Nếu Writer là Muse Contributor:
         |    Reviewer L1 (Review nhanh) = Claude Code Sonnet 5.5 High
         |    Fallback = AGY Gemini Flash High / Claude Sonnet 4.6
         |    (Sonnet chỉ làm L1, không làm final gate)
         |
         +--> Nếu Writer là AGY hoặc Claude Code Sonnet 5.5:
              Reviewer L1 = OpenCode Muse Contributor (hoặc Gemini khi Writer là Claude)
              (TUYỆT ĐỐI CẤM tự review)
```

Review L1 Sonnet 5.5 High chỉ đọc diff/scope rõ, kiểm tra test completeness, regression và API contract; không spawn agent hay tự sửa code. Logic phức tạp, architecture conflict, worker disagreement, root cause chưa rõ hoặc `retryCount >= 2` chuyển sang Sol High làm final arbiter L2.

> ⛔ **CẤM TUYỆT ĐỐI**:
> 1. KHÔNG bao giờ dùng DeepSeek (kể cả `deepseek-v4.1-flash`) cho vai trò **Writer** dưới bất kỳ hình thức nào. DeepSeek CHỈ ĐƯỢC PHÉP dùng làm fallback khẩn cấp cho Orchestrator và Reviewer Lớp 2 khi các model chính cạn quota.
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
         |      -> Writer thường; tối đa 1 lần retry có giả thuyết sửa mới
         |
         +--> Logic nghiệp vụ khó / integration nhiều thành phần /
         |    dependency khó, hoặc task không đơn giản với confidence < 0.65 có bằng chứng
         |      -> Claude Code CLI Sonnet 5.5 ngay
         |
         +--> Cùng nguyên nhân thất bại 2 lần (retryCount >= 2)
                -> Claude Code CLI Sonnet 5.5 làm final fixer
                   -> Reviewer L1 khác lineage -> Reviewer L2 final gate
```

Direct fit là tiêu chí chọn worker trước khi thử, không cần worker thường thất bại. Với kiến trúc còn mở, coordinator chốt plan và gate trước khi giao phần implementation đã scope. Nếu nhiều worker thất bại hoặc đưa ra diff mâu thuẫn, chuyển plan/diff/log/test cho Sonnet 5.5 để chẩn đoán và hợp nhất. Chỉ giao Sonnet 5.5 làm reviewer phụ L1 khi nó không viết diff đó. Lỗi mạng/quota/model ID là lỗi route: kiểm tra log và fallback theo provider, không tính như thất bại logic. Sau một lượt Sonnet không đạt acceptance criteria, dừng retry tự động và trả bằng chứng cho coordinator.

---

## 4. Bảng tổng hợp mã lỗi & hành động ứng phó

| Mã lỗi / Trạng thái | Nguyên nhân | Hành động ứng phó (Fallback Action) |
|---|---|---|
| `CODEX_QUOTA_EXHAUSTED` | Hết quota 5h trên máy local ATLAS | Chuyển sang ORBIT qua SSH `ssh mac-m1`. Nếu ORBIT cũng hết, chuyển sang Claude CLI hoặc DeepSeek v4.1 Flash. |
| `CLAUDE_RATE_LIMITED` | Vượt rate limit hoặc weekly < 20% | Khóa direct Claude CLI, chuyển sang AGY Claude (quota độc lập) hoặc DeepSeek v4.1 Flash. |
| `PROVIDER_EXIT_ERROR` | Lỗi crash process hoặc model selection không hợp lệ | Đọc `stderr.log`. Nếu do cờ `--effort` (ví dụ AGY Claude không hỗ trợ `--effort`), bỏ cờ và retry; nếu sập route, nhảy sang fallback tiếp theo trong `roles.manifest.json`. |
| `TASK_RETRY_ESCALATION` | `retryCount >= 2` với cùng nguyên nhân, hoặc nhiều worker sửa thất bại | Giao Sonnet 5.5 làm final fixer, kèm acceptance criteria, write-set, log/test và diff; giữ review độc lập. |
| `TASK_DIRECT_SONNET55` | Task đã scope rõ, có acceptance criteria và một direct fit nêu ở trên | Coordinator giao thẳng Sonnet 5.5 ở `retryCount = 0`, ghi lý do chọn và giữ review độc lập. |
| `HARD_LOGIC_ESCALATION` | Lỗi logic/integration/dependency khó hoặc task không đơn giản có confidence < 0.65 kèm bằng chứng | Giao Sonnet 5.5 sớm, kể cả `retryCount = 0`; không dùng cho task đơn giản. |
| `REVIEW_BLOCKED_PROVIDER_ROUTE` | Không còn route nào khả dụng | Báo cáo typed blocker lên Coordinator/Owner, ghi rõ log, KHÔNG tự bịa nội dung review. |
