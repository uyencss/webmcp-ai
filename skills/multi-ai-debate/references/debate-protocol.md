# Debate protocol — moderation rules

## Roles

Roles are data, not code. `roles.default.json` defines the default cast; the
per-program `debate.config.json` is the effective cast after merging
`roles.default.json` → `--roles <file>` → inline flags (`--moderator`,
`--debaters`, `--strategy`). Route is one of `coordinator` (the running agent is
moderator, default), `agy`, `opencode`, `claude-cli`, `codex`.

- **Coordinator/moderator (chủ trì)**: owns context brief, role map, strategy
  choice, prompt assembly, agenda, tally, final report. Default moderator is the
  running agent; it can be reassigned to an AI route (then it needs a
  `parts/r<N>-moderator.md` prompt). It does not write debater opinions, does not
  review a lane as authority, never fabricates a failed lane's output.
- **Debaters (phản biện)**: independent lanes, each with a `stance` (neutral or an
  adversarial/assigned stance from the strategy). Anonymized D1..Dn during
  R2/R3; identities revealed in the final report with honest lineage.
- **Owner**: sets the questions, reviews the report, authorizes any downstream
  file changes. A debate is advisory; it never authorizes implementation by itself.

## Strategy

The strategy selects the round plan (count/kinds/per-debater), stance assignment
and resolver. See `references/strategies.md` and `strategies.json`. Record the
chosen strategy in the ledger; do not mix strategies silently within a program.

## Planning & User Draft Sign-off Gate (Bắt buộc trước khi dispatch)

Trước khi khởi tạo (`init`) hoặc dispatch bất kỳ vòng tranh luận nào tốn quota/token,
Coordinator PHẢI lập kế hoạch và soạn thảo bản **Dự thảo Kế hoạch Cuộc họp Tranh biện (`debate-plan.draft.md`)**:

1. **Soạn dự thảo**: Sử dụng `scripts/debate-plan.mjs` hoặc điền `templates/debate-plan.template.md`.
2. **5 thành phần bắt buộc của bản dự thảo**:
   - **Chủ đề & Phạm vi**: Topic cốt lõi, câu hỏi trọng tâm, tài liệu tham chiếu, ranh giới cấm đụng chạm (không sửa file nguồn khi chưa có lệnh).
   - **Danh sách thành phần tham dự**: Moderator (Host), Debaters (ID, route, model, effort, stance/lens), và Owner (người dùng).
   - **Kịch bản các vòng**: Số vòng, mục tiêu từng vòng (R1 độc lập, R2 phản biện chéo, R3 biểu quyết/hội tụ), cơ chế phân giải (resolver).
   - **Ước tính Quota & Chi phí**: Peek quota thực tế (`8421`), bảo đảm dùng đúng `opencode-go/deepseek-v4.1-flash`, cấm model v4 cũ tốn kém.
   - **Checklist kiểm tra cho User**: Danh mục rõ ràng để User dễ dàng rà soát và yêu cầu chỉnh sửa.
3. **Trình bày và Chờ duyệt (User Sign-off Gate)**:
   - Trình bày tóm tắt dự thảo cho User ngay trong phiên trao đổi.
   - DỪNG LẠI và lắng nghe phản hồi chỉnh sửa (đổi model, thêm/bớt debater, chỉnh câu hỏi, đổi số vòng).
   - Chỉ khi User xác nhận chấp thuận ("Duyệt plan", "Tiến hành debate"), Coordinator mới gọi `debate-init.mjs <slug> --plan <draft-plan>` để chuyển sang giai đoạn thực thi.

## Context brief quality bar

- Real facts only: file paths, hashes, accepted baselines, contracts in force.
- State what must NOT be done (no repo writes, no dependency, no scope).
- Include the owner's own hypothesis verbatim when they have one — make it an
  explicit debate object (the 2026-09 case: "mỗi action = 1 runbook" was tested
  and corrected by a machine-checkable rule).
- End with per-question output requirements and a word cap.

## Anonymization

- Stable per-program map: D1..Dn in `debate.config.json` debater order (default
  D1=agy-claude, D2=claude-cli, D3=codex, D4=agy-flash, D5=muse, but configurable).
- R2/R3 prompts reference only "Debater N"; per-debater R3 prompts differ only in
  the `{{DEBATER_LINE}}` / injected debater line and `{{STANCE}}`. Reveal the map in
  the final report. Never claim a model reviewed its own lane.

## Agenda construction (R2)

- Read all R1 outputs; include ONLY real disagreements (10–15 points max).
- Each point: positions per debater + the exact question to settle.
- Keep converged points out except to confirm; list invariants "not re-voted".
- Add a point on scope/ordering/acceptance — debates otherwise hide the budget
  question.

## Ballot construction (R3)

- Convert surviving disagreements into explicit decisions with lettered options
  (name exact paths/schemas), plus "MỚI" for a new option.
- Show current supporters per option where it helps lanes defect knowingly.
- Require: chosen option, confidence, dissent + change-condition, final veto.
- Include a deferred-list confirmation item.

## Tally rules

- Majority per decision; record the ratio. 5/5 and 4/5 are strong; 3/5 needs a
  revisit condition in the report.
- Record minority notes and vetoes verbatim-ish; check the final package does not
  trigger any veto.
- Where votes tie on naming/minor shape, moderator may synthesize a canonical
  choice — mark it clearly as moderator synthesis, not a vote result.
- Never average contradictions into mush: if the split is real, report it with a
  revisit trigger.

## Final report requirements

1. Executive summary readable standalone.
2. Vote table with ratios + minority notes.
3. One section per owner question with the converged answer.
4. Remaining disagreements + explicit revisit conditions.
5. Coordinator recommendations clearly separated from vote results.
6. Process proposal if owner authorizes downstream changes (gates, order,
   acceptance, independent reviewers).
7. Risks table; evidence appendix with artifact hashes.
8. Statement that the target file/source was untouched unless separately
   authorized.
9. If an opt-in independent review ran: version bump note (which version
   absorbed which review gates — never rewrite vote results) + review
   artifact hashes.

## Independent review (opt-in, post-report)

- Reviewer model MUST differ from all debaters (fresh lineage). The only
  exception is adjudication: review #1's author (or a third model) resolves a
  material disagreement between review #1 and review #2.
- Workspace is read-only and MUST include the real repo, not just the debate
  dir. The brief (`templates/reviewer-brief.template.md`) requires verifying
  report claims against real code and marking unverifiable claims as such.
- Output contract: tally-check → per-decision challenge → risk re-rating →
  verdict (APPROVE / APPROVE-WITH-CONDITIONS / REJECT).
- Caps: one review round by default; at most one adjudication round and only
  when review #2 materially disagrees with review #1. Stop once the verdict
  is APPROVE/APPROVE-WITH-CONDITIONS and its conditions are folded in.
- Fold-in: accepted gates go into a new FINAL-REPORT version + ledger hashes;
  rejected gates get a one-line reason and are dropped. Vote results are
  never edited by review.

## Evidence discipline

- Hash every prompt and output; keep `debate-ledger.md` current.
- Snapshot the target file before any authorized amendment (baseline copy + hash).
- Failed lanes stay recorded as typed blockers with their raw stderr/log.
- Do not delete debate artifacts until owner review completes; then archive per
  workspace convention.
