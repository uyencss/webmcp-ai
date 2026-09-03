---
title: WebMCP AI CLI — Full Access One-Flag Plan (v1 only)
type: plan
status: implemented
created: 2026-09-03
updated: 2026-09-03
---

# WebMCP AI CLI — Full Access One-Flag Plan (v1 only)

> Chuẩn format: mượn frontmatter + cấu trúc `plan.md` từ `docs/` gốc
> (`docs/reference/documentation-convention.md`, `docs/initiatives/2026-08-portable-cli-agent-orchestration-runtime/plan.md`).
> Lưu ý: `packages/*/docs/` không thuộc phạm vi lint của `docs/` gốc — file này
> sống cùng package `@gyga-browser/webmcp-ai@0.3.0-alpha.0` để dễ chạy, dễ review.
> **Đã implement toàn bộ (xem §10 As-built + `2026-09-receipt-full-access.md`).**

## 1. Goal

Một flag duy nhất cho cả 2 lane — `scheduled` (Runner/queue) và `chat session`
(`webmcp-ai generate`) — để khi cần full thì **passthrough như chạy CLI gốc**,
không complicated ở bất cứ bước nào:

```bash
webmcp-ai generate --provider opencode --prompt-file ./prompt.md --workspace /abs/ws --full --json
# tương đương:
webmcp-ai generate --provider opencode --prompt-file ./prompt.md --workspace /abs/ws --access-profile full --json
```

Khi `--full`:

- full access toàn bộ folder `workspace` (đọc + ghi, kể cả ngoài `src/`),
- toàn bộ tools của provider (kể cả `bash`, `edit`/`write`),
- MCP + plugin + instructions giữ nguyên ambient (không cô lập về `{}`),
- web access (`webfetch`/`websearch`) giữ nguyên ambient,
- chạy được ở bất cứ môi trường nào kể cả sandbox/checkout disposable.

Không `--full` → giữ nguyên behaviour an toàn hiện tại
(`provider-default` / `compose-only` / `review-readonly` / `bounded-edit`).

## 2. Background — vì sao hiện tại "càng sửa càng hạn chế"

Tham chiếu: `docs/initiatives/2026-08-policy-enforced-agent-execution/references/webmcp-ai-cli-wrapper/`
(`findings-2026-09-02.md`, `capability-access-repair-plan-2026-09-02.md`,
`policy-blocked-bounded-edit-root-cause-2026-09-02.md`,
`runtime-config-shape-and-path-scope-evidence-2026-09-02.md`,
`writer-failure-muse-a3-bounded-edit-denied-2026-09-02.md`,
`writer-failure-muse-z3-2026-09-02.md`).

1. Wrapper là transparent launcher (`src/client.mjs:55-95`): chỉ set child `cwd`,
   không bind project/Store/revision/write-set → model tự đoán, AGY ghi nhầm
   `~/.gemini/.../scratch` thay vì candidate.
2. Sau chuỗi `FIX_REQUIRED` (Sol review), `src/capabilities.mjs:64-327` +
   `src/providers/opencode.mjs:92-157` luôn build `OPENCODE_CONFIG_CONTENT`
   restrictive: `edit`/`write` theo root tuyệt đối, `bash: deny`,
   `mcp: {}`, `plugin: []`. Nhưng OpenCode v1 matcher với `--dir <ws>` nhận
   path tương đối (`src/...`) → absolute rule không match → `* deny` thắng
   (`WRITER_PERMISSION_DENIED` dù `ok:true`).
3. `src/providers/claude.mjs:26-32` hard `--tools '' --safe-mode --no-chrome`
   → text-only, không đọc file. `src/providers/codex.mjs:47-49` hard
   `--sandbox read-only`. `src/providers/agy.mjs:74-93` hard `--sandbox` +
   `hooks.json deny all` cho compose-only.
4. `src/process-runner.mjs:44-96` buffer output + `timeoutMs 600000` +
   `kill(-pgid)` → long session bị `PROVIDER_TIMEOUT` và kill cả group.
5. `doctor --json` (`src/client.mjs:184-200`) chỉ probe version, không chứng minh
   auth/quota/tool-access (`WAI-07`).

Kết quả: default an toàn nhưng **không còn đường full** — đúng pain của owner.

## 3. Scope

### 3.1 In scope (v1 only — OpenCode `1.18.x`, package `0.3.0-alpha.0`)

- Thêm `accessProfile: 'full'` + alias CLI `--full`.
- `full` = passthrough: không build config restrictive, không hard sandbox,
  không cô lập MCP/plugin/instructions, không sanitize env quá mức.
- Áp dụng cho cả 4 providers: `opencode` (writer chính), `codex`, `claude`,
  `agy` — mỗi provider chỉ gỡ đúng cái hard-deny của nó.
- `scheduled` và `chat session` dùng chung 1 entrypoint + 1 receipt shape.
- OpenCode v1 shape: `external_directory` giữ **top-level array**
  (`src/capabilities.mjs:483-495`) — đúng v1, không đổi.

### 3.2 Out of scope (không làm trong plan này)

- OpenCode v2 (`permission.external_directory` dạng object,
  `types.gen.d.ts:622`) → backlog riêng, chỉ làm khi owner yêu cầu migrate v2.
- Runner permit / Gateway broker / Browser authority / durable scheduler /
  queue-lease-retry — vẫn thuộc E4-Durable/V2, E7-G2.
- Tuyệt đối không: global `/**`, copy `~/.config/opencode`, dangerous
  skip-permissions lén (`--dangerously-skip-permissions`,
  `--approve-for-me`) ngoài `full` tường minh.

## 4. Design — `full` là gì

### 4.1 Contract

```json
{
  "provider": "opencode",
  "prompt": "...",
  "workspace": "/absolute/ws",
  "accessProfile": "full"
}
```

- `full` chỉ yêu cầu `workspace` tồn tại + là directory. Không yêu cầu
  `allowedWriteRoots` / `protectedPaths`, không check ancestor/overlap
  (`validateCapabilityRequest` ở `src/capabilities.mjs:210-327` bypass nhánh
  này khi `full`).
- Mọi field context khác (`projectId`, `storeRevisions`, roots...) là optional,
  chỉ dùng để ghi receipt digest, không dùng để deny.
- `full` và `compose-only` xung đột → `INVALID_INPUT` (fail-closed).

### 4.2 Provider mapping (v1)

| Provider | Hiện tại (restrictive) | Khi `full` |
|---|---|---|
| `opencode` (`src/providers/opencode.mjs:92-157`) | luôn `buildOpenCodeConfig()` + `OPENCODE_CONFIG_CONTENT` restrictive, `mcp:{}`, `XDG_CONFIG_HOME` temp | **bỏ** `buildOpenCodeConfig`; không set `OPENCODE_CONFIG_CONTENT` / `OPENCODE_CONFIG` / `OPENCODE_PURE` cô lập; giữ ambient config + MCP/plugin/instructions của operator; `args` giữ `--dir <ws>` + `--agent build --auto` khi `accept-edits` |
| `codex` (`src/providers/codex.mjs:35-50`) | `exec --sandbox read-only --ephemeral --ignore-user-config/rules` | bỏ `--sandbox read-only` (dùng provider default hoặc `workspace-write` nếu CLI yêu cầu flag tường minh); giữ `--skip-git-repo-check --ephemeral` để không dirty global |
| `claude` (`src/providers/claude.mjs:26-38`) | `--tools '' --safe-mode --no-chrome` | bỏ `--tools '' --safe-mode`; giữ `--no-chrome` + `--output-format json` trừ khi caller override |
| `agy` (`src/providers/agy.mjs:46-93`) | `--sandbox`, compose-only gắn `hooks.json deny all` | bỏ `--sandbox` ép buộc khi `full`; không cài `hooks.json`; giữ `PROMPT_TOO_LARGE 128KB` fail-closed (giới hạn protocol, không phải policy) |

### 4.3 Env & process

- `buildSafeChildEnv` (`src/capabilities.mjs:350-397`): khi `full`, pass-through
  env rộng hơn (giữ `PATH/HOME/TERM` + provider auth resolution machine-local),
  vẫn không in secret vào prompt/receipt. Chi tiết allowlist mở rộng chốt ở
  implementation (mặc định: giữ denylist `WEBMCP_*` authority + private key).
- `runProcess` (`src/process-runner.mjs:54-157`): khi `full`, `timeoutMs` lấy từ
  caller (default `600000` giữ nguyên), `maxOutputBytes` nâng hoặc cho phép
  override; không đổi `kill(-pgid)` trong plan này (xử lý owner-kill ở follow-up).

### 4.4 Receipt (giữ nguyên shape, thêm flag)

`src/protocol.mjs:93-117` đã trả digest — giữ nguyên, thêm:

```json
{ "capability": { "accessProfile": "full", "workspaceDigest": "…", "fullPassthrough": true } }
```

`ok:true` + `response.text` là đủ cho `full` (không yêu cầu diff/test như
`bounded-edit`). `WRITER_PERMISSION_DENIED` typing để backlog (không bắt buộc
cho `full` vì không còn deny).

## 5. Thay đổi source dự kiến (chưa làm)

| File | Việc |
|---|---|
| `src/capabilities.mjs:8-54` | thêm `'full'` vào `VALID_ACCESS_PROFILES`; `normalizeAccessProfile` accept `full`; `validateCapabilityRequest` bypass roots-check khi `full` |
| `src/providers/opencode.mjs:79-157` | nhánh `if (accessProfile === 'full')` return invocation passthrough trước `buildOpenCodeConfig` |
| `src/providers/codex.mjs:35-50` | nhánh `full`: bỏ `--sandbox read-only` |
| `src/providers/claude.mjs:15-38` | nhánh `full`: bỏ `--tools '' --safe-mode` |
| `src/providers/agy.mjs:46-93` | nhánh `full`: bỏ `--sandbox` ép buộc + skip compose guard |
| `src/client.mjs:58-104` | `full` supported cho mọi provider (không `UNSUPPORTED_CAPABILITY`); `toolPolicy` mapping giữ backward-compat |
| `src/protocol.mjs:27-44` | schema + `ALLOWED_INPUT_FIELDS` accept `full`; metadata thêm `fullPassthrough` |
| `src/cli.mjs:38-58` | thêm `--full` (boolean) + help text; map `--full` → `accessProfile: 'full'` |
| `tests/*.test.mjs` | thêm `tests/full-access.test.mjs`: full không yêu cầu roots; opencode full không chứa `OPENCODE_CONFIG_CONTENT` restrictive; codex/claude/agy full không chứa hard-deny flags |

Write-set đóng băng đúng 8 file trên + 1 test mới. Không chạm
`src/orchestration/`, Gateway, Runner, Browser.

## 6. Cách chạy (sau khi implement)

```bash
# opencode full — writer chính
webmcp-ai generate --provider opencode --prompt-file ./prompt.md --workspace /abs/ws --full --json

# codex / claude / agy full
webmcp-ai generate --provider codex --prompt "…" --workspace /abs/ws --full --json
webmcp-ai generate --provider claude --prompt "…" --workspace /abs/ws --full --json
webmcp-ai generate --provider agy --prompt "…" --workspace /abs/ws --full --json

# tool-call protocol
printf '%s' '{"protocol":"webmcp-tool-v1","requestId":"r1","tool":"ai.generate","input":{"provider":"opencode","prompt":"hi","workspace":"/abs/ws","accessProfile":"full"}}' | webmcp-ai tool-call --json
```

`scheduled` và `chat` dùng chung lệnh trên; khác nhau chỉ ở `prompt-file` /
`workspace` cụ thể.

## 7. Test & DoD

1. `node --test tests/full-access.test.mjs` xanh (RED trước, GREEN sau).
2. `npm test` (full suite hiện `511/511`) không regression.
3. `node --check` mọi `.mjs` đổi + `git diff --check` sạch.
4. Smoke tay (không tốn quota nếu chưa muốn): `doctor --json` + dry-run inspect
   args của 4 providers ở chế độ `full` (assert không còn hard-deny).
5. Live smoke khi owner duyệt: 1 lệnh `full` tạo file trong `workspace`
   disposable, read-back + hash — `ok:true` là đủ (không yêu cầu canary matrix
   như `bounded-edit`).

## 8. Risks

- `full` là passthrough có chủ ý → chỉ dùng khi operator đã tin workspace +
  prompt. Không đặt `full` làm default; default vẫn fail-closed.
- `full` không có receipt diff/test bắt buộc → caller (scheduled Runner hoặc
  chat coordinator) tự chịu trách nhiệm verify sau run.
- AGY workspace drift (`scratch` vs `workspace`) và Claude auth context
  (`AUTH_CONTEXT_UNAVAILABLE_NONINTERACTIVE`) là vấn đề provider, wrapper
  không che giấu — receipt ghi đúng `provider/model/sessionId` để truy vết.

## 9. Next files

- `docs/2026-09-receipt-full-access.md` — receipt implement (đã tạo).
- Skill + package README đã document `--full` (xong).

## 10. As-built (implement 2026-09-03, vượt plan ở 4 điểm)

1. **Env passthrough khi `full`** — `buildFullChildEnv()` mới trong
   `src/capabilities.mjs`: ambient env đi qua hết như native CLI, trừ denylist
   authority mirror đúng cái Runner tự strip khi spawn con
   (`WEBMCP_SIGNING_KEY`, `WEBMCP_PRIVATE_KEY`, `WEBMCP_PERMIT_PRIVATE_KEY` —
   `webmcp-automation-runner/src/cli/helpers/run.mjs:172-174`,
   `src/runner/pipeline-dispatcher.mjs:166-168`) cộng `WEBMCP_GATEWAY_TOKEN`,
   `WEBMCP_RUNNER_SECRET`, `WEBMCP_VAULT_KEY[_FILE]`, `WEBMCP_VAULT_NEW_KEY[_FILE]`.
   Bounded profiles giữ nguyên allowlist cũ. Điều này sửa gap "API key env bị
   strip" — provider auth qua env giờ tới được child; secret vẫn không vào
   prompt/receipt.
2. **`--max-output-bytes`** — flag CLI mới + field protocol `ai.generate`
   (`src/cli.mjs`, `src/protocol.mjs`, validate trong `src/client.mjs`).
   Default: 32MB thường, **128MB khi `full`**. Caller tự nâng được, khỏi sợ
   `PROVIDER_OUTPUT_LIMIT` cắt giữa long generation.
3. **Sửa gốc `bounded-edit`** (root cause `policy-blocked-...md:38-42`, không chỉ
   né bằng `full`): `buildOpenCodeConfig` giờ convert absolute root trong
   workspace sang relative (`src`/`src/**`, root==workspace → `**`) qua helper
   `toOpenCodeRelativePatterns()` — vì OpenCode v1 matcher nhận relative tool
   path sau `--dir`. Protected `deny` sau `allow`. `external_directory`
   top-level array giữ nguyên (đúng shape v1).
4. **Codex `full` = `--sandbox workspace-write` tường minh** (không phải bỏ flag:
   bỏ flag rơi về config default, thường vẫn `read-only` — check thực tế
   `codex exec --help`). Không bao giờ dùng `danger-full-access`.

Không chạm `src/orchestration/`, Gateway, Runner, Browser, reference frozen.
WAI còn mở có chủ ý: WAI-01 (version print), WAI-07 (doctor canary), WAI-08
(streaming), WAI-05/06/11 (Runner permit/Gateway/fixture-only) — thuộc lane
E4-Durable/V2, không thuộc plan này.
