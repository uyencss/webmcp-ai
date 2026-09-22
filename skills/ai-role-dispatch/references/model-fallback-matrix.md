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
         |    Reviewer L1 (Review phụ) = AGY Gemini Flash High / Claude Sonnet
         |    (Lưu ý: Sonnet chỉ đóng vai trò Reviewer phụ L1, không làm Reviewer chính final gate)
         |
         +--> Nếu Writer là AGY Gemini Flash (fallback):
              Reviewer L1 = OpenCode Muse Contributor (TUYỆT ĐỐI CẤM tự review)
```

> ⛔ **CẤM TUYỆT ĐỐI**:
> 1. KHÔNG bao giờ dùng DeepSeek (kể cả `deepseek-v4.1-flash`) cho vai trò **Writer** dưới bất kỳ hình thức nào. DeepSeek CHỈ ĐƯỢC PHÉP dùng làm fallback khẩn cấp cho Orchestrator và Reviewer Lớp 2 khi các model chính cạn quota.
> 2. TUYỆT ĐỐI KHÔNG dùng GLM (kể cả `9router/glm-5.3-flash`) làm fallback cho Writer hoặc các vai trò khác trong ma trận điều phối.

---

## 3. Bảng tổng hợp mã lỗi & hành động ứng phó

| Mã lỗi / Trạng thái | Nguyên nhân | Hành động ứng phó (Fallback Action) |
|---|---|---|
| `CODEX_QUOTA_EXHAUSTED` | Hết quota 5h trên máy local ATLAS | Chuyển sang ORBIT qua SSH `ssh mac-m1`. Nếu ORBIT cũng hết, chuyển sang Claude CLI hoặc DeepSeek v4.1 Flash. |
| `CLAUDE_RATE_LIMITED` | Vượt rate limit hoặc weekly < 20% | Khóa direct Claude CLI, chuyển sang AGY Claude (quota độc lập) hoặc DeepSeek v4.1 Flash. |
| `PROVIDER_EXIT_ERROR` | Lỗi crash process hoặc model selection không hợp lệ | Đọc `stderr.log`. Nếu do cờ `--effort` (ví dụ AGY Claude không hỗ trợ `--effort`), bỏ cờ và retry; nếu sập route, nhảy sang fallback tiếp theo trong `roles.manifest.json`. |
| `REVIEW_BLOCKED_PROVIDER_ROUTE` | Không còn route nào khả dụng | Báo cáo typed blocker lên Coordinator/Owner, ghi rõ log, KHÔNG tự bịa nội dung review. |
