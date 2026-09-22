# DỰ THẢO KẾ HOẠCH CUỘC HỌP TRANH BIỆN ĐA AI
## Multi-AI Debate Plan Draft

- **Mã chương trình (Program Slug):** `{{PROGRAM_SLUG}}`
- **Thời gian lập dự thảo:** {{DATE}}
- **Trạng thái:** `DRAFT — CHỜ NGƯỜI DÙNG KIỂM TRA & CHỈNH SỬA`
- **Chiến lược đề xuất:** `{{STRATEGY_NAME}}` (`{{STRATEGY_ID}}`)
- **Số vòng dự kiến:** {{ROUNDS_COUNT}} vòng

---

## I. BỐI CẢNH & CHỦ ĐỀ TRANH LUẬN (TOPIC & SCOPE)

### 1. Chủ đề cốt lõi
{{TOPIC}}

### 2. Mục tiêu cuộc họp tranh biện
{{OBJECTIVE}}

### 3. Tài liệu & Codebase tham chiếu
{{REFERENCES}}

### 4. Ranh giới & Điều cấm kỵ (Constraints & Invariants)
- **Tuyệt đối không sửa repo/code:** Cuộc tranh biện mang tính chất tư vấn kiến trúc (advisory); không tự ý ghi/sửa file nguồn khi chưa có chỉ đạo bằng văn bản từ Owner.
- **Nguyên tắc Ponytail (YAGNI):** Cắt tỉa triệt để abstraction suy đoán, ưu tiên thư viện chuẩn (stdlib) và tính năng native platform trước khi đề xuất thêm dependency hoặc boilerplate.
- **Nguyên tắc Spec-Kit (SDD):** Đảm bảo tính khả thi cao, giao ước/contract rõ ràng, các nhiệm vụ có thể phân rã và kiểm tra tính hội tụ (convergence).
- **Phạm vi output:** Mọi bằng chứng, lập luận và nhật ký chỉ được ghi trong thư mục tạm `{{TEMP_DIR}}/`.

---

## II. THÀNH PHẦN THAM DỰ & PHÂN VAI (PARTICIPANTS & ROLES)

### 1. Chủ trì / Điều phối (Moderator)
- **Đại diện:** {{MODERATOR_INFO}}
- **Nhiệm vụ:** Quản lý bối cảnh (`context-brief.md`), xây dựng agenda vòng 2 từ các bất đồng thật sự, lập phiếu biểu quyết vòng 3, tổng hợp báo cáo `FINAL-REPORT.md`, và duy trì tính khách quan (không tự bịa kết quả của debater).

### 2. Danh sách Phản biện (Debaters)
| ID | Tên hiển thị (Lane) | Provider / Route | Model & Effort | Lăng kính / Stance được giao | Trạng thái / Ghi chú |
|:---|:---|:---|:---|:---|:---|
{{DEBATERS_TABLE}}

### 3. Thẩm định & Quyết định (Owner / Observer)
- **Đại diện:** Người dùng (Workspace Owner)
- **Nhiệm vụ:** Kiểm tra và phê duyệt bản kế hoạch này; theo dõi diễn biến các vòng; đưa ra phán quyết cuối cùng về việc áp dụng kiến trúc nào vào dự án.

---

## III. KỊCH BẢN & TIẾN TRÌNH CÁC VÒNG (ROUNDS AGENDA)

- **Chiến lược tổng thể:** `{{STRATEGY_ID}}` — {{STRATEGY_SUMMARY}}
- **Cơ chế phân giải (Resolver):** `{{RESOLVER}}`
- **Quy tắc tương tác:** Trong các vòng phản biện, danh tính debater được ẩn danh dưới dạng D1..Dn nhằm tránh thiên vị provider.

### Kế hoạch chi tiết từng vòng:
{{ROUNDS_DETAIL}}

### Sản phẩm bàn giao sau cuộc tranh biện:
1. `debate-ledger.md`: Nhật ký băm SHA-256 toàn bộ prompt và phản hồi từ các model (bảo đảm tính toàn vẹn lineage).
2. `FINAL-REPORT.md`: Báo cáo tổng kết hoàn chỉnh gồm:
   - Tóm tắt điều hành (Executive Summary).
   - Ma trận đồng thuận & bất đồng.
   - Bảng phân tích trade-off và điểm gãy rủi ro.
   - Khuyến nghị thực thi tối ưu nhất từ Chủ trì.

---

## IV. ƯỚC TÍNH QUOTA & TÀI NGUYÊN (QUOTA & RESOURCE ESTIMATION)

- **Kiểm tra hạn ngạch thời gian thực (Cluster Quota 8421):**
{{QUOTA_ESTIMATION}}
- **Lưu ý an toàn & Chi phí:**
  - BẮT BUỘC dùng đúng `opencode-go/deepseek-v4.1-flash` nếu dùng DeepSeek (TUYỆT ĐỐI CẤM model `deepseek-v4-flash` cũ vì tốn tiền).
  - Giới hạn độ dài phản hồi (word cap ~800-1200 từ/debater) nhằm tránh cạn kiệt context window và tiết kiệm quota.

---

## V. DANH MỤC CHỜ NGƯỜI DÙNG KIỂM TRA & CHỈNH SỬA (REVIEW CHECKLIST)

Xin vui lòng kiểm tra các điểm dưới đây trước khi cuộc tranh biện được bấm máy:

- [ ] **Chủ đề & Câu hỏi trọng tâm:** Nội dung phần I đã bao quát đúng trăn trở kiến trúc của bạn chưa?
- [ ] **Thành phần tham gia:** Bạn có muốn thêm/bớt AI debater nào hoặc điều chỉnh model/reasoning effort không?
- [ ] **Số vòng & Chiến lược:** Kế hoạch {{ROUNDS_COUNT}} vòng theo chiến lược `{{STRATEGY_ID}}` có phù hợp với thời gian và mức độ kỹ lưỡng bạn mong muốn không?
- [ ] **Tài liệu tham chiếu:** Đã đầy đủ đường dẫn tới mã nguồn / tài liệu liên quan chưa?

---

> 💡 **HƯỚNG DẪN HÀNH ĐỘNG TIẾP THEO:**
> - Nếu cần thay đổi bất kỳ mục nào, bạn chỉ cần gõ yêu cầu chỉnh sửa (ví dụ: *"Đổi D3 sang Claude"*, *"Thêm câu hỏi về caching"*, *"Đổi sang 2 vòng"*).
> - Nếu bạn đã hài lòng với bản dự thảo này, hãy gõ **"Duyệt plan"** hoặc **"Tiến hành tranh biện"**. Coordinator sẽ tự động khởi tạo chương trình và dispatch Vòng 1 ngay lập tức!
