# Debate strategies — catalog & selection guide

Nghiên cứu nền: khảo sát hệ thống multi-agent debate (MAD) 2026 mô tả MAD theo
**3 trục**: (1) *participants* — số agent, vai/vị thế, đồng nhất hay dị thể;
(2) *interaction* — topology, bộ nhớ, visibility giữa các vòng; (3) *agreement
protocol* — cách chốt (vote, judge, consensus, confidence-weighted). Mọi strategy
dưới đây chỉ là một tổ hợp có tên của 3 trục đó; chọn strategy = chọn tổ hợp.

Nguồn chính:

- *Multi-Agent Debate Strategies: Survey, Taxonomy, and Challenges* (arXiv
  2607.26212, 2026) — taxonomy 141 nghiên cứu; kết luận ngành đang mặc định một
  kiểu hẹp (static, fully-connected, verbatim, short-term memory, voting) và các
  biến thể còn ít được so sánh.
- *RedDebate* (arXiv 2506.11083, 2025/2026) — peer refinement, devil–angel,
  Socratic refinement; red-teaming + memory giảm unsafe behavior.
- *Demystifying Multi-Agent Debate: The Role of Confidence and Diversity*
  (ACL Findings 2026) — vanilla MAD là martingale; diversity-aware init + calibrated
  confidence biến nó thành submartingale (hội tụ về đáp án đúng).
- *Protocol matters* (arXiv 2603.28813) — Within-Round vs Cross-Round vs
  Rank-Adaptive Cross-Round: đánh đổi interaction (peer-reference) vs convergence.
- MAD 2026 layered analysis (arXiv 2609.08016) — bất đồng và chất lượng đáp án.
- Phương pháp phi-LLM cổ điển: Delphi (RAND), Six Thinking Hats (de Bono),
  Devil's advocate (Janis, groupthink), Pre-mortem (Klein), Steelman (Rapoport),
  NIH Consensus Conference, bracket/tournament.

## Bảng chọn nhanh

| id | Strategy | Dùng khi | Vòng | Chốt bằng |
|---|---|---|---|---|
| `cross-exam` | Chất vấn chéo | **Mặc định**. Thiết kế/plan/trade-off | 3 | majority vote |
| `delphi` | Delphi ẩn danh lặp | Cần đồng thuận, giảm nịnh/theo đám | 4 | consensus threshold |
| `red-team` | Red vs Blue | Security-critical, phá giả định | 4 | majority vote |
| `devil-advocate` | 1 lane phản biện chuyên trách | Gần đồng thuận, sợ groupthink | 4 | majority vote |
| `socratic` | 1 lane chỉ đặt câu hỏi | Cần moi giả định ngầm, lỗ hổng luận cứ | 4 | majority vote |
| `steelman` | Steelman + Pre-mortem | Nhiều phương án đều hợp lý | 4 | majority vote |
| `six-hats` | Sáu chiếc mũ | Cần quét 6 lăng kính | 3 | majority vote |
| `jury` | Bồi thẩm đoàn | Có bên ủng hộ/phản đối rõ | 3 | judge panel |
| `consensus-conference` | Hội nghị đồng thuận | Quyết định lớn, có veto | 3 | supermajority + no-veto |
| `confidence-weighted` | Cross-exam + confidence | Câu hỏi reasoning đúng/sai | 3 | confidence-weighted |
| `tournament` | Đấu loại bracket | >4 phương án, sàng lọc dần | 3+ | majority vote |
| `map-reduce` | Chia nhỏ rồi tổng hợp | Bài toán cắt được thành phần | 3 | moderator summary |

`kind: generic` chạy được ngay với engine 3–4 vòng (roles + stance + round plan).
`kind: manual` cần trọng tài tự ghép prompt/đối cặp — script vẫn dispatch, nhưng
agenda/cặp đấu do người điều phối điền tay.

## Vị thế (stance) có thể gán

`neutral`, `for`, `against` (pro/con), `attacker`/`defender` (red/blue),
`devil`, `socratic`, `steelman`, `premortem`, `prosecution`/`defence`/`juror`,
`hat-white`/`hat-red`/`hat-yellow`/`hat-black`/`hat-green`/`hat-blue`.

Gán theo strategy (`stanceMode`):

- `uniform` — mọi lane trung lập (cross-exam, delphi, steelman, ...).
- `pair` — chia lane thành hai phe đối lập (red-team, jury).
- `assigned` — gán tay theo `defaultStances` (devil-advocate, socratic, six-hats).

Ghi đè cá nhân: đặt `stance` trong từng debater ở `roles.default.json` / file
`--roles`; giá trị khác `neutral` luôn được tôn trọng.

## Chi tiết

### cross-exam (mặc định)
R1 độc lập (không ai thấy ai) → R2 trọng tài chắt lọc 10–15 điểm bất đồng thật,
mọi lane đọc toàn bộ R1 đã ẩn danh → R3 biểu quyết từng quyết định, có confidence,
MINORITY NOTE, veto. Chốt đa số; 3/5 cần điều kiện revisit. Đây là protocol
Cross-Round kinh điển, cân bằng interaction và convergence.

### delphi
Không ai thấy lập luận đầy đủ của ai; mỗi vòng chỉ đọc một bản **tổng hợp ẩn danh**
(moderator ghi `parts/r<N>-input.md`). Vòng lặp đến khi vị trí ổn định hoặc đạt
ngưỡng đồng thuận. Dùng khi vấn đề chính trị/nhạy cảm, hoặc khi nghi ngờ hiệu ứng
nịnh và áp lực theo số đông.

### red-team
Chia lane thành attacker/defender. R2 attacker tấn công (lỗ hổng, giả định sai,
failure mode); R3 defender vá và sửa; R4 vote. Nghiên cứu RedDebate cho thấy
đối kháng có chủ đích giúp phát hiện failure mode tốt hơn peer đồng nhất. Dùng cho
security, migration rủi ro, kill-switch/rollback.

### devil-advocate
Một lane (mặc định D1) là devil: phản biện mạnh nhất *kể cả khi nó đồng ý*. Chống
groupthink (Janis). Dùng khi hội đã gần đồng thuận và bạn muốn một bài test độc lập
trước khi chốt.

### socratic
Một lane chỉ đặt câu hỏi sắc bén (không đưa đáp án): moi giả định ngầm, đòi bằng
chứng, chỉ ra lỗ hổng lập luận. Dùng khi các đề xuất nghe hợp lý nhưng chưa chắc có
nền tảng.

### steelman + pre-mortem
R2 mỗi lane dựng phiên bản mạnh nhất của phương án *người khác* (steelman); R3
pre-mortem "giả sử đã thất bại, vì sao". Giảm thiên lệch tranh cãi và lộ rủi ro ẩn.

### six-hats
Gán mỗi lane một chiếc mũ: trắng (dữ kiện), đỏ (cảm xúc), vàng (lợi ích), đen (rủi
ro), xanh lá (sáng tạo). Dùng cho quyết định mới cần quét đủ lăng kính.

### jury
Chia prosecution/defence + một juror; R3 juror/hội đồng ra phán quyết có lý do
(`resolver: judge-panel`). Dùng khi câu hỏi dạng "có nên làm X hay không" với hai
phe rõ ràng.

### consensus-conference
Mô phỏng hội nghị đồng thuận kiểu NIH: trình bày bằng chứng → chất vấn → tuyên bố
đồng thuận, mỗi lane có **veto**. Chỉ chốt khi supermajority và không veto
(`supermajority-veto`). Dùng cho quyết định khó đảo ngược.

### confidence-weighted
R1 chọn pool đáp án đa dạng (diversity-aware) và mỗi lane nêu confidence hiệu
chỉnh; R2/R3 cập nhật có trọng số confidence. Dựa trên kết quả 2026: confidence có
thể phá thế martingale của majority vote. Dùng cho câu hỏi reasoning có đáp án
tương đối đúng/sai.

### tournament
Khi >4 phương án: R1 mỗi lane một phương án, trọng tài ghép cặp đấu loại dần
(`manual`). Chốt bằng vote ở vòng cuối.

### map-reduce
Chia bài toán thành các phần ít phụ thuộc, mỗi lane làm một phần, rồi một vòng tổng
hợp (`map-reduce`). Ưu tiên độ phủ hơn đối chất; trọng tài tổng hợp cuối cùng.

## Strategy tùy biến (manual)

`strategies.json` là nguồn dữ liệu duy nhất cho round plan + stance. Muốn thêm
strategy mới:

1. Sao chép một entry, đổi `id`, `name`, `rounds` (mỗi vòng `n`, `kind`, `label`,
   `perDebater`), `stanceMode`, `defaultStances`, `resolver`, `visibility`, `when`.
2. Nếu cần prompt riêng: thêm `templates/r1..rN-*` hoặc để trọng tài điền
   `parts/r<N>-header.md`, `parts/r<N>-agenda.md`, `parts/r<N>-footer.md` sau khi
   `debate-init` scaffold.
3. `kind` không đổi hành vi engine; nó chỉ là nhãn cho trọng tài. Engine quyết
   định theo `rounds[].perDebater` + stance.

## Điều không nên làm

- Đừng để một model tự "tổng hợp phiếu" thay trọng tài.
- Đừng tăng số lane/vòng để che một agenda kém; nghiên cứu cho thấy thêm agent
  không tự chống lại adversarial persuasion.
- Đừng trộn nhiều strategy trong một chương trình mà không ghi vào ledger.
- Đừng coi debate PASS là authorization triển khai.
