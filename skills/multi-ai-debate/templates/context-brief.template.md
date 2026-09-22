# Context brief — Tranh biện thiết kế: <CHỦ ĐỀ>

## 0. Mục đích phiên tranh biện

<Owner muốn gì; đây là tư vấn thiết kế, KHÔNG phải authorization triển khai.
Không ai được sửa repo. Kết quả dùng để owner quyết định.>

## 1. Hệ thống/đối tượng hiện tại (dữ kiện thật, không giả định)

<Kiến trúc hiện tại, trạng thái đã accepted, baseline commit/hash, file/folder
layout thật, contract đang có hiệu lực. Càng cụ thể càng tốt — debater sẽ đối
chiếu từng câu.>

## 2. Câu hỏi tranh biện

**Q1.** <câu hỏi 1>
**Q2.** <câu hỏi 2>
**Q3.** <câu hỏi 3>
**Q4.** <câu hỏi 4>

## 3. Ràng buộc chung cho mọi đề xuất

1. <invariant/contract không được phá>
2. <ngân sách thời gian/token; ưu tiên đơn giản>
3. <dependency không được thêm>
4. <local-first / privacy / ownership rules>
5. Mọi đề xuất phải nêu: file/schema mới, owner, migration/compatibility,
   test/acceptance tối thiểu.

## 4. Yêu cầu đầu ra vòng 1 (cho mỗi AI)

Trả lời bằng tiếng Việt (giữ thuật ngữ kỹ thuật tiếng Anh), theo thứ tự Q1 → Qn.
Với mỗi câu: đề xuất cụ thể (tên, schema, cây thư mục, ví dụ), lý do, phương án
bị bác và tại sao, assumptions. Cuối cùng thêm:

- **Rủi ro/unknown** (tối đa 5 gạch đầu dòng, có mức độ).
- **Điểm phải chốt trước khi code** (tối đa 5 gạch đầu dòng).

Không cần viết code. Trả lời trực tiếp, tối đa ~1800 từ.
