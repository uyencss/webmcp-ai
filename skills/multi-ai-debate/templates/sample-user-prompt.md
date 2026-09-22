# Mẫu Prompt Người Dùng Yêu Cầu Tranh Luận Đa AI (Sample User Offer Prompt)

Mẫu prompt chuẩn dùng để Coordinator/Agent cung cấp ("offer") cho người dùng khi họ cần tổ chức một cuộc tranh biện kỹ thuật đa AI (Multi-AI Debate) có phản biện chuyên sâu, kết hợp tư duy tối giản (`ponytail`) và quy chuẩn đặc tả kỹ thuật (`spec-kit`).

---

```text
tôi muốn bạn host 1 cuộc tranh luận phản biện mang tính chất kỹ thuật, trong đó bạn nói AI debator kết hợp thêm 2 skill ponytail và speckit được cung cấp để tranh luận về khả năng phát triển tiếp theo cho project kit của tôi, tham khảo:

I. THAM KHẢO
- /Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-project-kit
- /Users/ttcenter/Desktop/VIBE_CODE/webmcp-project-library
- /Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/docs/initiatives/2026-09-project-kit-and-library

xoay quanh nội dung sau:

II. CHỦ ĐỀ TRANH LUẬN
[Mô tả chủ đề cụ thể: ví dụ kiến trúc mở rộng, modularity, schema contracts, YAGNI vs extensibility, khả năng tái sử dụng giữa project kit và library...]

III. PHÂN VAI
phân vai chính (dùng khi còn quota):
- host/trọng tài: bạn — coordinator đang chủ trì phiên
- debator 1: codex sol (gpt-6-sol)
- debator 2: claude opus 5.5 (claude -p --model claude-opus-5-5)

dự bị — CHỈ dùng khi đã hết quota cả codex lẫn claude:
1. agy claude 4.6 thinking high
2. agy flash 3.8 gemini
3. muse 1.3 contributor gọi qua opencode go
4. host dự bị: deepseek v4.1 flash gọi qua opencode-go (đúng bản v4.1-flash; cấm bản v4 cũ vì chi phí đắt)

IV. SỐ VÒNG: 2

V. HÀNH ĐỘNG
hãy triển khai thảo luận 2 vòng và báo cáo kết quả cuối cùng cho tôi
```

---

## Hướng dẫn Host / Coordinator khi nhận prompt này

### 1. Khởi tạo chương trình tranh biện (Scaffold)

Dịch phân vai thành CLI flags hoặc ghi file cấu hình `roles.json`:

```bash
node scripts/debate-init.mjs <program-slug> \
  --strategy cross-exam \
  --moderator coordinator \
  --debaters "agy:claude-opus-4-6-thinking:-:agy-claude;agy:gemini-3.8-flash-high:high:agy-flash;opencode:opencode-go/deepseek-chat-v4.1-flash:-:opencode-deepseek;opencode:opencode-go/muse-spark-1.3-contributor:xhigh:muse"
```

_(Ghi chú: Nếu Host chạy độc lập qua OpenCode thì `--moderator opencode:opencode-go/deepseek-chat-v4.1-flash:-:moderator`; nếu Host là agent IDE/CLI đang điều phối trực tiếp thì `--moderator coordinator`)._

### 2. Bơm tri thức 2 skill vào `context-brief.md`

Trong phần **Ràng buộc chung (Constraints)** và **Lăng kính đánh giá (Evaluation Lens)** của `context-brief.md`, Host chèn rõ 2 bộ nguyên lý:

- **Skill Ponytail (`.agents/skills/ponytail/SKILL.md`)**:
  - YAGNI triệt để: Giải pháp lười nhất nhưng hoạt động tin cậy (simplest working solution).
  - Ưu tiên Standard Library / Native platform trước khi thêm dependency hay abstraction mới.
  - Cắt giảm boilerplate, cảnh giác với speculative abstractions và over-engineering.
- **Skill Spec-Kit (`.agents/skills/spec-kit/SKILL.md`)**:
  - Spec-Driven Development (SDD): Mọi ý tưởng phải có spec, contract, invariant rõ ràng.
  - Phân rã công việc thành các task độc lập, có thể kiểm chứng và hội tụ (convergence).
  - Đòi hỏi tính khả thi cao, schema interface chặt chẽ giữa các kit/library.

### 3. Quy trình 2 vòng thảo luận

- **Vòng 1 (Đề xuất & Lập trường)**: Từng debater nghiên cứu các đường dẫn trong phần **I. THAM KHẢO**, độc lập đề xuất định hướng phát triển trả lời **II. CHỦ ĐỀ TRANH LUẬN**, tự đối chiếu với 2 lăng kính Ponytail & Spec-Kit.
- **Vòng 2 (Phản biện chéo & Hội tụ)**: Host tổng hợp các điểm bất đồng thật sự vào `parts/r2-agenda.md`. Các debater trực tiếp phản biện phương án của nhau (chỉ ra chỗ thừa thãi hoặc thiếu đặc tả).
- **Báo cáo tổng kết (`FINAL-REPORT.md`)**: Host lập bảng ma trận đồng thuận/bất đồng, đánh giá trade-off và đưa ra khuyến nghị thực thi cuối cùng cho Owner.
