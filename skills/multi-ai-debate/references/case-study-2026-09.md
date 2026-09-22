# Case study — 2026-09-10 Phase 2 Project Kit debate (reference run)

Program root: `$VIBE_CODE/temp/phase2-debate-20260910/`
(kept as the worked example: prompts, 15 outputs, ledger, final report, receipt).

## Shape

- Topic: 4 design questions on `plan.phase2.md` before owner authorized edits.
- 5 lanes x 3 rounds = 15 calls; all lanes succeeded after 3 fixes.
- Coordinator prep (brief + prompts): ~30 min. Wall time per round: R1 ~4 min,
  R2 ~9 min (11.7K-word prompt), R3 ~4 min. Total ~1.5h including moderation.
- Outcome: 12/12 decisions resolved; 5/5 consensus on 3; owner then authorized a
  single-file plan amendment; docs-lint and docs-index gates passed.

## What worked

- Real repo state in the brief (paths, schemas, contracts) produced concrete,
  testable proposals instead of generic advice.
- Anonymized R2 + an agenda of real disagreements forced position changes
  (e.g., 2→3 runbooks, Kit→Library vocabulary ownership, order swap).
- Machine-checkable granularity rule (`splitKey`) turned a values debate into a
  verifiable partition; the owner's hypothesis was corrected with a rule, not an
  opinion.
- Ballot with confidence + veto + minority notes gave a clean decision surface
  and explicit revisit conditions.
- Small scripts: init/assemble/dispatch/extract removed most mechanical work.

## Pitfalls learned

- AGY rejects `--access-profile` and `--effort` on Claude; run plan-mode only.
- AGY Claude can return a summary and write the artifact to its brain dir —
  extraction must resolve it (otherwise the debate silently loses content).
- Claude Code weekly quota can sit below 20%; check before each round.
- Long R2 prompts make large stderr event logs (20MB+); keep them out of context.
- `sed`-assembled per-debater prompts must keep the debater number mapping stable.
- Tally by hand from R3 ballots; do not let any model "summarize votes" as the
  authority.

## Reuse checklist

1. `debate-init.mjs <slug> [--strategy id] [--roles file | --debaters ...]`
   → fill `context-brief.md` → `assemble-round.mjs <root> 1`.
2. `dispatch-round.mjs <root> 1` → `extract-responses.mjs <root>/r1` → moderate R1.
3. Fill `parts/r2-agenda.md` → assemble 2 → dispatch → extract.
4. Fill the vote-round header table + vote part → assemble/dispatch/extract for the
   vote round (round number depends on strategy; see `debate.config.json`).
5. Tally, write `FINAL-REPORT.md`, update `debate-ledger.md` hashes.
6. Ask owner before touching any target file; snapshot baseline first if authorized.

> Historical note: the 2026-09 run used `run-r1.sh`/`run-r2.sh`/`run-r3.sh` with a
> fixed 5-lane map. Those were succeeded by the config/strategy-driven
> `assemble-round.mjs` + `dispatch-round.mjs`; the old run scripts remain only as
> artifacts inside `temp/phase2-debate-20260910/`.
