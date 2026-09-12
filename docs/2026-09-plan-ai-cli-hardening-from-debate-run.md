---
title: WebMCP AI CLI — Hardening from the 2026-09-12 multi-AI debate run
type: plan
status: implemented
created: 2026-09-12
updated: 2026-09-12
---

# WebMCP AI CLI — Hardening from the 2026-09-12 multi-AI debate run

> Owner: `@gyga-browser/webmcp-ai-cli` (`packages/webmcp-ai-cli`).
> Status: **implemented, reviewed (2-layer PASS), NOT promoted** — candidate is
> uncommitted; promotion/commit pending explicit authorization.
> Nguồn: phiên tranh biện 4 lane × 3 vòng ngày 2026-09-12, artifact tại
> `VIBE_CODE/temp/projectkit-next-template-debate-20260912/`
> (`FINAL-REPORT.md`, `debate-ledger.md`, `r1..r3/out/`, `*.stderr.log`).

## 0. Progress tick (evidence gate)

- [x] Step 1 — per-model surface (`models inspect`)
- [x] Step 2 — typed `UNSUPPORTED_EFFORT`
- [x] Step 3 — AGY artifact recovery (`--resolve-artifacts`)
- [x] Step 4 — opencode `PROVIDER_DB_LOCKED` retry (`--retry-lock`)
- [x] Step 5 — `preflight --json` + quota pointer
- [x] Step 6 — README/docs
- Evidence: candidate `temp/ai-cli-hardening-20260912/M2-implementation/ai-cli-hardening-v1`
  (base HEAD `6dd0d4a`, uncommitted), manifest digest
  `eba9313eb200f0926bc0bdd6794d2141b4e16d250c20d8787d97a1dd25b652f0`, 209 tests pass,
  coverage lines 91.26 / funcs 95.85 / branches 80.81, both review layers PASS
  (`receipts/lop1-muse-round4.md`, `receipts/lop2-deepseek-round4.md`).

## 1. Goal

Đóng các lỗ hổng vận hành của `webmcp-ai` (one-shot/review wrapper) đã lộ ra khi
dùng nó làm backend cho một cuộc tranh biện đa AI 12 call, để lần dispatch đa lane
sau không phải hardcode quirk, không mất nội dung âm thầm, và fail sớm/typed:

- Đủ thông tin machine-readable để chọn đúng provider + model + effort trước khi gọi.
- Không silent-loss khi AGY chỉ trả summary và ghi artifact ra brain dir.
- Không tự-mất-lane vì lỗi khoá SQLite của opencode khi chạy song song.
- Có đường lấy quota được chỉ rõ (không nằm trong wrapper, nhưng phải được trỏ tới).

## 2. Context — bằng chứng từ phiên chạy

- 4 lane: `agy:claude-opus-4-6-thinking`, `agy:gemini-3.8-flash-high`,
  `opencode:opencode-go/deepseek-v4.1-flash`,
  `opencode:opencode-go/muse-spark-1.3-contributor`; 3 vòng.
- Kết quả: R1 4/4, R2 4/4, R3 3/4 first-try → **12/12 sau 1 retry**.
- `doctor --json`: cả 4 provider `available:true` (agy 1.2.2, claude 2.1.258,
  codex 0.154.0-alpha.6.2, opencode).
- Lỗi duy nhất: D4 R3 `PROVIDER_EXIT_ERROR` với stderr `"database is locked"`,
  khi `opencode:deepseek` và `opencode:muse` chạy **đồng thời**; chạy lại riêng → OK.
- AGY `structuredOutput:false`, `stdinPrompt:false`: D1 mọi vòng và D2 R3 trả
  summary ngắn, nội dung đầy đủ nằm ở
  `~/.gemini/antigravity-cli/brain/<uuid>/<name>.md`; extractor của caller phải
  tự resolve (nếu không → mất nội dung).
- Cap cần biết: AGY prompt truyền qua argument, giới hạn
  `MAX_PROMPT_ARG_BYTES = 128 * 1024` (`src/providers/agy.mjs:6`), vượt →
  `PROMPT_TOO_LARGE` (`src/providers/agy.mjs:79-83`). R2 prompt thật 71 KB → vừa.
- `providers inspect agy|opencode` chỉ trả provider capability, **không** trả
  per-model `effort` support (agy claude từ chối `--effort`).

## 3. Findings

| # | Finding | Mức | Bằng chứng |
|---|---|---|---|
| F1 | AGY silent-loss: full artifact ở brain dir, wrapper envelope chỉ có summary | Cao | `r1/out/agy-claude.json` 2.9 KB vs brain `.md`; extractor phải fallback |
| F2 | Không có ma trận per-model (effort/agentMode/maxPromptBytes/StructuredOutput) machine-readable | Cao | `providers inspect` output; quirk agy-claude phải hardcode |
| F3 | opencode chạy song song → SQLite `database is locked`, lane fail | Cao | `r3/out/muse.stderr.log` `PROVIDER_EXIT_ERROR` |
| F4 | Quota không nằm trong wrapper; caller phải tự biết service/app riêng | Trung bình | `doctor` không trả quota; caller curl `:8421` |
| F5 | Không có preflight tổng hợp cho multi-lane (providers + models + cap + quota pointer) | Trung bình | caller tự ghép `doctor` + `models list` + curl |
| F6 | AGY cap 128 KB chỉ lộ khi đã gọi; không xuất hiện trong `models list`/`doctor` | Trung bình | `src/providers/agy.mjs:6,79` |
| F7 | `--effort` sai model không bị wrapper chặn; provider exit 1 thay vì typed error | Thấp–TB | agy claude + `--effort` → provider error |

## 4. Scope / non-goals

**In scope:** `packages/webmcp-ai-cli` — `src/`, `docs/`, README; tests trong
`tests/`. Không đổi protocol `webmcp-tool-v1` theo cách phá vỡ tương thích
(chỉ thêm field additive).

**Non-goals (out of this write-set):**

- Sửa skill debate (`.agents/skills/multi-ai-debate`) — xem §11.
- Sửa `webmcp-ai-orchestration` (supervisor/journal/adapters/refs-quota) — §11.
- Không thêm dependency vào `webmcp-ai`; giữ luật "orchestration → ai-cli, không
  ngược lại" và "one-shot/review không load supervisor code" (README).
- Không ép quota vào wrapper như một hard dependency (xem F4).

## 5. Fix steps

Mỗi bước một PR-size, có verify + exit criteria riêng.

### Step 1 — Per-model capability surface (F2, F6, F7)
- **Change:** thêm lệnh additive `webmcp-ai models inspect --provider <p> --model <m> --json`
  trả: `{ ok, model, provider, supportsEffort, defaultEffort, effortValues[],
  agentModes[], maxPromptBytes, structuredOutput, stdinPrompt, modelDiscovery,
  artifacts: 'inline'|'brain-fallback', note }`.
  Nguồn dữ liệu: bảng tĩnh trong `src/capabilities.mjs` (provider-level) + per-model
  override; đọc chung với `src/providers/*.mjs` để không lệch.
  Ghi các fact đã biết: agy `claude-opus-4-6-thinking` `supportsEffort:false`,
  `maxPromptBytes:131072`, `artifacts:'brain-fallback'`; agy gemini `effort high`;
  opencode muse `xhigh`, deepseek-v4.1-flash `high`; `modelDiscovery:false` cho claude/codex.
- **Verify:** `node bin/webmcp-ai.mjs models inspect --provider agy --model claude-opus-4-6-thinking --json` trả `supportsEffort:false`, `maxPromptBytes:131072`.
- **Exit:** caller không cần hardcode quirk; `tests/capabilities.test.mjs` phủ bảng.
- **Dep:** none.

### Step 2 — Chặn `--effort` sai bằng typed error (F7)
- **Change:** `generate` validate effort với `Step 1` surface; sai → `AiCliError('UNSUPPORTED_EFFORT', ..., {exitCode:2, details:{model,allowedEfforts}})`. Giữ provider làm lớp cuối.
- **Verify:** `generate --provider agy --model claude-opus-4-6-thinking --effort high ...` → exit 2, code `UNSUPPORTED_EFFORT`, **không** gọi provider.
- **Exit:** không còn provider exit 1 chỉ vì effort.
- **Dep:** Step 1.

### Step 3 — Artifact resolution cho AGY (F1)
- **Change:** thêm tùy chọn `--resolve-artifacts` (hoặc mặc định bật cho AGY khi
  `structuredOutput:false`): sau khi nhận `response.text`, nếu text ngắn/không full
  và có brain `.md` mới hơn thời điểm gọi (so `mtime` trong cửa sổ giới hạn,
  ví dụ ±15 phút) thì trả thêm `response.artifacts:[{kind:'brain-md', path, bytes, digest}]`
  + `response.text` = nội dung artifact. Không đổi shape cũ (additive).
- **Verify:** fixture brain dir + prompt giả lập → envelope có `artifacts[0].digest`;
  khi không có brain → giữ nguyên text, `artifacts:[]`, không lỗi.
- **Exit:** caller không phải scrape `~/.gemini/.../brain`; hết silent-loss.
- **Dep:** Step 1.

### Step 4 — opencode concurrency guard (F3)
- **Change:** hai phần additive:
  (a) docs + `doctor`/`models inspect` note rằng chạy ≥2 `generate --provider opencode`
      đồng thời có thể gặp `database is locked`;
  (b) tùy chọn `--serialize-provider opencode` (hoặc auto-retry `retryable` provider
      exit với backoff ngắn, mặc định vài lần) trong `src/client.mjs`/`process-runner.mjs`.
  Fail vẫn typed `PROVIDER_EXIT_ERROR` (`retryable:true`) sau khi hết retry.
- **Verify:** test 2 call opencode song song (fixture bin sleep) → 1 lần retry, cả 2 `ok:true`;
  quá số retry → error `retryable:true` giữ nguyên.
- **Exit:** multi-lane opencode không tự mất lane.
- **Dep:** none (độc lập Step 1).

### Step 5 — Preflight tổng hợp (F5, F4)
- **Change:** thêm `webmcp-ai preflight --json` (read-only, không gọi provider):
  trả providers available+version, `maxPromptBytes`/`structuredOutput` per provider,
  và **pointer** quota: `{ quota: { owner: 'companion', service: 'http://127.0.0.1:8421/api/quotas',
  app: 'apps/ai-cli-usage-tray', skill: 'ai-cli-usage', note: 'query separately; not owned by webmcp-ai' } }`.
  Không import/gọi app — chỉ trỏ.
- **Verify:** `preflight --json` trả đủ 4 provider + quota pointer; không side effect.
- **Exit:** caller có một call để biết "gọi được gì, cap bao nhiêu, quota ở đâu".
- **Dep:** Step 1.

### Step 6 — Docs + pointer (F4)
- **Change:** README thêm mục "Provider quota (external)" trỏ `apps/ai-cli-usage-tray`
  + service `:8421` + skill `ai-cli-usage`; ghi rõ wrapper **không** sở hữu quota.
  Ghi prompt-size cap AGY và semantics `structuredOutput:false`/`stdinPrompt:false`.
- **Verify:** `grep -n "ai-cli-usage-tray" README.md`.
- **Exit:** người dùng mới biết quota lấy ở đâu mà không đọc source.
- **Dep:** none.

## 6. Dependency graph & parallel

```text
Step 6 (docs)        ─┐
Step 1 (surface)     ─┼─> Step 2 (effort guard)
                     ├─> Step 3 (artifact resolve)
                     └─> Step 5 (preflight)
Step 4 (opencode)    ── độc lập
```

- **Parallel-safe:** Step 4 và Step 6 chạy song song với nhánh Step 1.
- **Serial:** Step 2, 3, 5 phải sau Step 1.
- **Không dùng chung file** giữa Step 4 và nhánh Step 1 (Step 4: `process-runner.mjs`/`client.mjs`; Step 1-2-3-5: `capabilities.mjs`/`cli.mjs`/`providers/*`).

## 7. Invariants

- Giữ `webmcp-tool-v1`; mọi thay đổi envelope là **additive**, không phá caller cũ.
- `webmcp-ai` không import `webmcp-ai-orchestration`; không load supervisor ở one-shot/review.
- Không thêm dependency npm cho các fix này.
- Typed error cho mọi fail mới (`PROMPT_TOO_LARGE` đã có; thêm `UNSUPPORTED_EFFORT`).
- Không tự lấy/ghi quota; chỉ trỏ pointer.
- Không đổi default behavior an toàn (`provider-default`/`compose-only`/...) trừ khi opt-in rõ.

## 8. Acceptance / verification (chạy được)

```bash
cd packages/webmcp-ai-cli
npm test                                   # toàn bộ suite hiện có phải xanh
node bin/webmcp-ai.mjs models inspect --provider agy --model claude-opus-4-6-thinking --json
node bin/webmcp-ai.mjs preflight --json
node bin/webmcp-ai.mjs generate --provider agy --model claude-opus-4-6-thinking --effort high \
  --prompt-file ./prompt.md --json         # phải là UNSUPPORTED_EFFORT exit 2
```

Exit gate: suite xanh + 3 lệnh trên trả đúng + coverage không giảm so với baseline
package.

## 9. Risks

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Bảng per-model lệch thực tế provider khi model đổi | Trung bình | `models inspect` đọc chung nguồn; ghi ngày verify; test snapshot |
| Auto-retry che lỗi thật của opencode | Trung bình | chỉ retry khi `retryable:true` + backoff giới hạn; log số lần retry |
| Artifact resolution sai file brain (nhiều phiên cùng lúc) | Trung bình | cửa sổ thời gian + ưu tiên link trong text + so digest; không ghi đè text nếu artifact cũ hơn |
| Thêm field phá caller cũ | Thấp | additive-only; test envelope schema |

## 10. Open questions

1. `--resolve-artifacts` bật mặc định cho AGY hay opt-in? (đề xuất: mặc định bật cho AGY, vì silent-loss là bug).
2. `--serialize-provider` vs auto-retry mặc định? (đề xuất: auto-retry mặc định + opt-in serialize).
3. `preflight` có nên ping `:8421` (read-only, bounded) hay chỉ trỏ URL? (đề xuất: chỉ trỏ; ping là việc của caller/skill).
4. Có cần `models inspect` cho claude/codex (`modelDiscovery:false`) trả `null` model list + note "dùng default/alias"? (đề xuất: có).

## 11. Out-of-scope follow-ups (linked, không thuộc plan này)

**Skill `multi-ai-debate`** (`.agents/skills/multi-ai-debate/`):
- Bỏ hardcode path `/Users/ttcenter/...` + timeouts Perl; parameterize qua env/config.
- Serialize/backoff lane opencode (dùng Step 4 khi có).
- Byte-count guard cho prompt AGY trước khi dispatch.
- Bắt buộc chạy + lưu `preflight`/`doctor` vào `debate-ledger.md`.
- Node-ify dispatch (đã làm) và hướng tới dùng orchestration adapters.

**`webmcp-ai-orchestration`** (phase riêng, cần authorization + gate riêng):
- Route lane dispatch qua supervisor/journal/adapters để có durability + lineage.
- Đưa quota gating vào `refs-quota` sẵn có thay vì mỗi skill tự curl `:8421`.
- Chỉ chuyển khi cần debate bền vững/nhiều phiên; không copy prompt template vào `src/`.

## 12. Anti-patterns cần tránh

- Nhồi logic quota/policy engine vào wrapper (vi phạm ranh giới "one-shot/review").
- Tạo `webmcp-ai` → `webmcp-ai-orchestration` import.
- Bảng capability hardcode rải rác trong từng provider thay vì một surface chung.
- Retry vô hạn hoặc retry cả lỗi non-retryable.
- Đổi shape envelope theo hướng phá vỡ (breaking) để "cho gọn".

## 13. As-built

Implemented as a candidate git worktree
`temp/ai-cli-hardening-20260912/M2-implementation/ai-cli-hardening-v1`
(branch `candidate/ai-cli-hardening-v1`, base HEAD `6dd0d4a`), uncommitted.

- Files: `README.md`, `src/cli.mjs`, `src/client.mjs`, `src/process-runner.mjs`,
  `src/providers/agy.mjs` (modified); `src/artifacts.mjs`,
  `src/model-capabilities.mjs`, `tests/hardening.test.mjs` (new).
- Tests: 209 pass (baseline 196); coverage lines 91.26 / funcs 95.85 / branches 80.81.
- Reviews: Lớp 1 Muse PASS + Lớp 2 DeepSeek v4.1 flash PASS on the same manifest
  `eba9313e…`. Review rounds and accepted lows: see the candidate ledger at
  `temp/ai-cli-hardening-20260912/candidate-ledger.md`.
- Deliberate deviations from §5: opencode concurrency handled by bounded retry
  rather than a `--serialize-provider` cross-process lock; artifact recovery is
  opt-in (`--resolve-artifacts`) rather than AGY default-on. Both are documented
  in README.
- Follow-up (not in this plan): dry-run `retryLock` parity; optional Windows
  `PATHEXT` in the preflight probe.
- Promotion: NOT done. Awaiting explicit authorization to commit the candidate
  branch and fast-forward `main`, then re-run tests and update the receipt.
