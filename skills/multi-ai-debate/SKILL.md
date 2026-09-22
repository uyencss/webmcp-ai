---
name: multi-ai-debate
description: >-
  Chủ trì tranh biện thiết kế có trọng tài giữa nhiều AI (AGY Gemini/Claude, Claude
  Code CLI, native Codex Sol, Muse/DeepSeek v4.1 Flash qua OpenCode) với PHÂN VAI (chủ trì +
  phản biện) và STRATEGY cấu hình được — nhận từ prompt người dùng hoặc file default
  (cross-exam, delphi, red-team, devil-advocate, socratic, steelman, six-hats, jury,
  consensus-conference, confidence-weighted, tournament, map-reduce). Artifact
  tranh luận + kết luận lưu trong temp/<program-slug>/. Trigger khi user nói: tranh
  biện, tranh luận đa AI, phản biện đa model, hội đồng AI, lấy ý kiến nhiều AI,
  debate, multi-AI debate, multi-model review, cross-exam, chọn chiến lược tranh
  biện, "các AI phản biện nhau", "chốt thiết kế bằng biểu quyết", lên plan debate,
  lên kế hoạch tranh biện, chuẩn bị cuộc họp debate, draft plan debate. Dùng khi cần ≥2 ý
  kiến độc lập cho một design/plan/trade-off không tầm thường. KHÔNG dùng cho review
  một model (code-review, verification-loop), câu hỏi đơn giản, hoặc khi chỉ có một
  provider route khả dụng.
---

# Multi-AI Debate Orchestration

Capability chạy tranh biện lặp lại được giữa các AI route của workspace, kèm phân
vai cấu hình được, strategy chọn được và bằng chứng. Đúc kết từ phiên 2026-09-10
(`references/case-study-2026-09.md`; artifact gốc `temp/phase2-debate-20260910/`).

## Khi nào dùng

- Dùng khi: một design/plan/trade-off cần nhiều quan điểm độc lập, cần biểu quyết
  chốt phương án, hoặc cần adversarial review trước khi owner ra quyết định.
- Không dùng khi: chỉ cần review một model (dùng `code-review`/`verification-loop`),
  câu hỏi sự kiện đơn giản, hoặc quota/route không cho phép ≥2 lane.

## Preflight (bắt buộc trước khi dispatch)

1. **Workspace policy**: đọc `.agents/policies/webmcp-coordination.md`, xác minh
   hash khớp pin, công bố `POLICY_READY` + host/plan/write-set. Artifact tranh biện
   chỉ ghi trong `temp/<program-slug>/` (hoặc `.temp/` nếu owner yêu cầu); **không
   sửa repo/plan** nếu chưa có authorization riêng.
2. **Quota**: `curl -s "http://127.0.0.1:8421/api/quotas?all=1"` (hoặc skill
   `ai-cli-usage`). Codex 5h=0 → route mac-m1/AGY; Claude weekly <20% → ưu tiên AGY
   Claude, cảnh báo owner trước khi đốt Claude Code CLI.
3. **Provider probe**: `node "$AI_CLI" doctor --json` + `models list --provider
   agy|opencode --json`. Route/model có thể đổi — không giả định.
   `dispatch-round.mjs` cũng tự peek quota trước khi chạy.

## Phân vai (roles) — cấu hình từ prompt hoặc file default

Nguồn mặc định: `roles.default.json` (chủ trì = `coordinator`; 5 phản biện:
`agy-claude`, `claude-cli`, `codex`, `agy-flash`, `muse`). Thứ tự merge:
`roles.default.json` → `--roles <file.json>` → flag inline (`--moderator`,
`--debaters`, `--strategy`). Giá trị sau ghi đè giá trị trước.

Lấy phân vai **từ prompt người dùng**: agent đọc yêu cầu, rồi hoặc (a) truyền
flag inline, hoặc (b) ghi một `roles.json` từng phần và truyền `--roles`:

```bash
# (a) inline: mỗi spec là route:model:effort:lane (bỏ qua trường bằng '-'/để trống)
node scripts/debate-init.mjs <slug> --strategy red-team \
  --moderator coordinator \
  --debaters "codex:gpt-6-sol:high;agy:claude-opus-4-6-thinking:-;claude-cli:claude-opus-5-5:high;agy:gemini-3.8-flash-high:high"

# (b) file override (partial merge): { "moderator": {...}, "debaters": [...], "strategy": "..." }
node scripts/debate-init.mjs <slug> --roles /path/roles.json
```

`route` hợp lệ: `coordinator` (agent đang chạy làm trọng tài), `agy`, `opencode`,
`claude-cli`, `codex`. Mọi thay đổi phân vai/model/effort được ghi vào
`debate.config.json` để ledger/tái lập trung thực.

## Strategy — chọn cách tranh biện

`strategies.json` là catalog (12 strategy). Đọc đầy đủ ở
`references/strategies.md` (taxonomy participants/interaction/agreement + khi nào
dùng). Chọn bằng `--strategy <id>`; mặc định `cross-exam`.

| Nhóm | Strategy |
|---|---|
| Cân bằng (mặc định) | `cross-exam` |
| Đồng thuận / ẩn danh | `delphi`, `consensus-conference`, `confidence-weighted` |
| Đối kháng | `red-team`, `devil-advocate`, `jury` |
| Khai phá / chống thiên lệch | `socratic`, `steelman`, `six-hats` |
| Sàng lọc / quy mô | `tournament`, `map-reduce` |

Strategy quyết định: số vòng, loại vòng (`independent`/`cross-exam`/`delphi`/
`attack`/`vote`/...), có per-debater hay không, cách gán stance, và resolver
(vote / judge / consensus / confidence-weighted). Engine chỉ cần
`rounds[].perDebater` + stance; phần còn lại là prompt/agenda do trọng tài điền.

## Prompt mẫu cho người dùng (Sample User Offer Prompt)

Khi người dùng cần tổ chức một cuộc tranh biện kỹ thuật đa AI (ví dụ: đánh giá kiến trúc, phản biện hướng phát triển, kết hợp tư duy tối giản `ponytail` và đặc tả `spec-kit`), Coordinator có thể offer mẫu prompt chuẩn sau (`templates/sample-user-prompt.md`):

```text
tôi muốn bạn host 1 cuộc tranh luận phản biện mang tính chất kỹ thuật, trong đó bạn nói AI debator kết hợp thêm 2 skill ponytail và speckit được cung cấp để tranh luận về khả năng phát triển tiếp theo cho project kit của tôi, tham khảo:

I. THAM KHẢO
- /Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-project-kit
- /Users/ttcenter/Desktop/VIBE_CODE/webmcp-project-library
- /Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/docs/initiatives/2026-09-project-kit-and-library

xoay quanh nội dung sau:

II. CHỦ ĐỀ TRANH LUẬN
[Mô tả chủ đề cụ thể: ví dụ kiến trúc mở rộng, modularity, schema contracts, YAGNI vs extensibility...]

III. PHÂN VAI
phân vai của tôi như sau: host là bạn (deepseek v4.1 flash), các debator bao gồm:
1. agy claude 4.6 thinking high
2. agy flash 3.8 gemini
3. codex sol (gpt-6-sol)
4. muse 1.3 contributor gọi qua opencode go

IV. SỐ VÒNG: 2

V. HÀNH ĐỘNG
hãy triển khai thảo luận 2 vòng và báo cáo kết quả cuối cùng cho tôi
```

### Cách Coordinator ánh xạ vào lệnh thực thi:
1. **Scaffold**:
   ```bash
   node "$SKILL/scripts/debate-init.mjs" <program-slug> --strategy cross-exam \
     --moderator "opencode:opencode-go/deepseek-v4.1-flash:-:moderator" \
     --debaters "agy:claude-opus-4-6-thinking:-:agy-claude;agy:gemini-3.8-flash-high:high:agy-flash;codex:gpt-6-sol:high:codex;opencode:opencode-go/muse-spark-1.3-contributor:xhigh:muse"
   ```
   *(Lưu ý: BẮT BUỘC dùng đúng model `opencode-go/deepseek-v4.1-flash` làm Host. TUYỆT ĐỐI CẤM dùng `deepseek-v4-flash` vì chi phí đắt đỏ - v4 tốn tiền. Script sẽ tự động reject nếu phát hiện model v4 cũ).*
2. **Bơm nguyên lý Skill vào `context-brief.md`**:
   - **Ponytail (`.agents/skills/ponytail/SKILL.md`)**: YAGNI, giải pháp lười nhất chạy tốt (simplest working solution), ưu tiên stdlib/native platform, loại bỏ abstraction suy đoán và bloat.
   - **Spec-Kit (`.agents/skills/spec-kit/SKILL.md`)**: Spec-Driven Development, giao ước/contract rõ ràng, chia nhỏ task có thể đo lường và hội tụ (convergence).
3. **Quy trình 2 vòng**: Vòng 1 lập luận độc lập theo 2 skill lens; Vòng 2 phản biện chéo các điểm bất đồng cốt lõi; sau đó Host tổng hợp `FINAL-REPORT.md`.

## Giai đoạn Lập Kế Hoạch & Soạn Dự Thảo (Debate Planning & User Sign-off Gate)

**QUY TẮC BẮT BUỘC**: Trước khi khởi tạo và chạy các vòng tranh luận, Coordinator PHẢI lập kế hoạch và soạn thảo bản **Dự Thảo Kế Hoạch Cuộc Họp Tranh Biện (`debate-plan.draft.md`)** gửi cho Người dùng kiểm tra và chỉnh sửa.

### Quy trình điều phối khi nhận yêu cầu lên plan debate:
1. **Trích xuất thông tin**: Xác định chủ đề, mục tiêu, tài liệu tham khảo, các AI tham gia (hoặc dùng dàn mặc định).
2. **Soạn dự thảo tự động**:
   ```bash
   node "$SKILL/scripts/debate-plan.mjs" <program-slug> \
     --topic "<Chủ đề tranh luận chi tiết>" \
     --strategy cross-exam \
     --moderator "coordinator" \
     --debaters "agy:claude-opus-4-6-thinking:-:agy-claude;agy:gemini-3.8-flash-high:high:agy-flash;codex:gpt-6-sol:high:codex;opencode:opencode-go/muse-spark-1.3-contributor:xhigh:muse" \
     --lenses "ponytail,speckit" \
     --refs "<đường_dẫn_tham_khảo_1>,<đường_dẫn_2>"
   ```
   *(File dự thảo được lưu tại `temp/<program-slug>/debate-plan.draft.md`)*.

3. **Trình bày dự thảo cho Người dùng**:
   Coordinator xuất bản dự thảo hoặc trích xuất tóm tắt rõ ràng 5 phần:
   - **I. Chủ đề & Phạm vi**: Topic cốt lõi, mục tiêu cần giải quyết, tài liệu tham chiếu, ranh giới cấm kỵ (không sửa file nguồn khi chưa có lệnh).
   - **II. Thành phần tham dự**: Bảng chi tiết Moderator (Chủ trì), Debaters (Model, Route, Stance/Lens), và Owner.
   - **III. Kịch bản các vòng**: Số vòng, mục tiêu từng vòng (R1 độc lập, R2 phản biện chéo, R3 biểu quyết/hội tụ).
   - **IV. Ước tính Quota & Chi phí**: Trạng thái hạn ngạch, cam kết an toàn model (`opencode-go/deepseek-v4.1-flash`, cấm model v4 cũ).
   - **V. Checklist kiểm tra cho User**: Hỏi ý kiến người dùng về các điểm cần tinh chỉnh.

4. **DỪNG LẠI CHỜ PHẢN HỒI (GATE)**:
   - Nếu Người dùng yêu cầu sửa: cập nhật lại bản plan (chạy lại script với `--force` hoặc chỉnh sửa file trực tiếp).
   - Khi Người dùng gõ: *"Duyệt plan"*, *"Tiến hành debate"*, hoặc xác nhận chấp thuận: lúc này mới gọi `debate-init.mjs <program-slug> --plan "$TEMP/<program-slug>/debate-plan.draft.md"` và tiến hành Vòng 1.

## Fast path (tái sử dụng)

```bash
SKILL=/Users/ttcenter/Desktop/VIBE_CODE/.agents/skills/multi-ai-debate
TEMP=/Users/ttcenter/Desktop/VIBE_CODE/temp   # hoặc .temp nếu owner muốn

# 0) (tùy chọn) chạy self-check không gọi provider:
node "$SKILL/scripts/selfcheck.mjs"

# 1) Lập plan & Soạn dự thảo cho Người dùng kiểm tra và duyệt:
node "$SKILL/scripts/debate-plan.mjs" <program-slug> --topic "..." --strategy cross-exam
#    -> Xuất $TEMP/<program-slug>/debate-plan.draft.md; trình bày tóm tắt cho User và DỪNG LẠI chờ duyệt.

# 2) Scaffold chương trình sau khi Người dùng duyệt plan:
node "$SKILL/scripts/debate-init.mjs" <program-slug> --plan "$TEMP/<program-slug>/debate-plan.draft.md"
#    -> $TEMP/<program-slug>/{context-brief.md,debate-plan.approved.md,parts/,lanes/,r<N>/out,debate.config.json}

# 3) Điền context-brief.md, rồi:
node "$SKILL/scripts/assemble-round.mjs" "$TEMP/<program-slug>" 1
node "$SKILL/scripts/dispatch-round.mjs" "$TEMP/<program-slug>" 1
node "$SKILL/scripts/extract-responses.mjs" "$TEMP/<program-slug>/r1"

# 4) Đọc R1, điền parts/r2-agenda.md (chỉ bất đồng thật), rồi:
node "$SKILL/scripts/assemble-round.mjs" "$TEMP/<program-slug>" 2
node "$SKILL/scripts/dispatch-round.mjs" "$TEMP/<program-slug>" 2
node "$SKILL/scripts/extract-responses.mjs" "$TEMP/<program-slug>/r2"

# 5) Điền parts/r3-header.md (bảng vị trí) + parts/r3-vote.md, rồi lặp assemble/
#    dispatch/extract cho vòng vote (số vòng tùy strategy — xem debate.config.json).

# 6) Tally thủ công + viết FINAL-REPORT.md (mẫu parts/final-report.template.md)
#    + cập nhật debate-ledger.md với hash của prompt/output.

# 7) (Opt-in) Independent review sau FINAL-REPORT draft — xem
#    "Independent review (opt-in)" dưới đây. Mặc định TẮT; chỉ chạy khi owner
#    duyệt. Không có script riêng: 1 call generate trực tiếp là đủ.
```

Biến môi trường: `LANES=lane1,lane2` (subset), `WEBMCP_AI_CLI`, `AGY_BIN`,
`CLAUDE_BIN`, `CODEX_BIN`, `OPENCODE_BIN`. Lane chạy song song, timeout mềm ~40
phút/lane. Trọng tài AI (nếu cấu hình) chạy khi có `parts/r<N>-moderator.md`.

## Independent review (opt-in, sau FINAL-REPORT)

Mặc định TẮT. Coordinator offer tại 2 điểm: (a) khi trình `debate-plan.draft.md`
(mục V checklist), (b) sau khi có FINAL-REPORT draft. Nên suggest khi quyết định
high-stakes (release/architecture), consensus tuyệt đối đáng ngờ, hoặc debat
thiếu model mạnh về domain. Không suggest cho debate nhỏ/quota yếu.

Luật cứng khi chạy (đúc kết phiên 2026-09-16, `temp/browser-kit-ownership-20260916/`):

1. **Model khác debaters** — giá trị đến từ lineage diversity; cấm reuse model
   đã vote (trừ adjudication, xem 5).
2. **Workspace read-only = repo + thư mục debate**, brief ép verify claim trên
   code thật (đếm import, check file tồn tại, đối chiếu route) — không chỉ đọc
   artifact debate. Tuyệt đối không sửa file.
3. **Brief theo mẫu** `templates/reviewer-brief.template.md`, output contract:
   Tally-check → Challenge từng quyết định → Risks (đánh giá lại mức + thiếu)
   → Verdict (DUYỆT / DUYỆT-CÓ-ĐIỀU-KIỆN / KHÔNG-DUYỆT).
4. **1 call `generate` trực tiếp** (không qua dispatch-round). LƯU Ý: lệnh
   `review` ép JSON schema `webmcp-ai-review-result/1` — model free-text fail
   `REVIEW_RESULT_INCOMPLETE`; `review` cũng không hỗ trợ `--events`. Dùng
   `generate ... --agent-mode plan` cho review văn bản (chi tiết
   `references/provider-routes.md`).
5. **Cap chống ping-pong**: tối đa 1 review round. Chỉ thêm 1 adjudication
   (giao cho tác giả review #1 hoặc model thứ ba) khi review #2 bất đồng实质
   với #1; dừng khi verdict DUYỆT/DUYỆT-CÓ-ĐIỀU-KIỆN và conditions đã fold.
6. **Fold-in trung thực**: gate/điều kiện được chấp nhận → bump version
   FINAL-REPORT (ghi rõ v2/v3 nhận từ review nào, không sửa kết quả vote) +
   hash artifact review vào `debate-ledger.md`. Gate bị bác → ghi lý do 1 dòng,
   không fold.

## Bằng chứng & trung thực lineage

- Hash SHA-256 mọi prompt + output vào `debate-ledger.md` (script in hash sẵn).
- Lane thất bại là **typed blocker** (`REVIEW_BLOCKED_PROVIDER_ROUTE`), ghi log
  gốc, không bịa nội dung, không thay model khác mà không ghi rõ.
- AGY Claude có thể chỉ trả summary và ghi artifact đầy đủ vào
  `~/.gemini/antigravity-cli/brain/<uuid>/*.md` — `extract-responses.mjs` tự
  resolve; luôn giữ provenance trong ledger.
- Không để model nào tự "tổng hợp phiếu" thay trọng tài; tally thủ công từ `r<N>/out/`.
- Trước khi sửa file đích (khi owner authorize): snapshot baseline + hash, ghi
  receipt, chạy lint/docs gates liên quan.

## Cấu trúc capability

```text
multi-ai-debate/
├── SKILL.md
├── roles.default.json          # phân vai mặc định (chủ trì + phản biện)
├── strategies.json             # catalog strategy (rounds/stance/resolver)
├── references/
│   ├── strategies.md           # nghiên cứu + hướng dẫn chọn strategy
│   ├── provider-routes.md      # lệnh chính xác, quirks, JSON, quota
│   ├── debate-protocol.md      # luật điều hành agenda/ballot/tally/report
│   └── case-study-2026-09.md   # phiên mẫu + bài học + reuse checklist
├── templates/
│   ├── sample-user-prompt.md   # prompt mẫu offer người dùng (kết hợp ponytail + spec-kit)
│   ├── context-brief.template.md
│   ├── r1-header.template.md / r1-footer.template.md
│   ├── r2-header.template.md / r2-agenda.template.md / r2-footer.template.md
│   ├── r3-header.template.md / r3-vote.template.md
│   ├── final-report.template.md
│   ├── reviewer-brief.template.md  # brief reviewer độc lập opt-in (post-report)
│   └── ledger.template.md
└── scripts/
    ├── lib/config.mjs          # load config/roles/strategy + build route command
    ├── debate-init.mjs         # scaffold + merge roles/strategy -> debate.config.json
    ├── assemble-round.mjs      # ghép prompt theo round plan (stance/ẩn danh)
    ├── dispatch-round.mjs      # chạy mọi participant song song + quota peek
    ├── extract-responses.mjs   # trích text theo route + resolve AGY brain + hash
    └── selfcheck.mjs           # kiểm tra scaffold/assemble, KHÔNG gọi provider
```

## An toàn

- Không đưa credential, cookie, token, profile ID vật lý vào prompt.
- Tranh biện là **advisory**: không promote/accept/implement chỉ vì debate PASS.
- Tôn trọng write-set/ownership của workspace; không tự mở Phase/plan khác.
- Prompt tiếng Việt + thuật ngữ kỹ thuật tiếng Anh cho kết quả tốt nhất.
