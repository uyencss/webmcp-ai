---
title: WebMCP AI CLI — Native CLI parity and remote Claude plan
type: plan
status: implemented-code-live-remote-canary-pending
created: 2026-09-29
updated: 2026-09-29
---

# Kế hoạch cập nhật `webmcp-ai` theo CLI thực tế

**Ngày kiểm tra:** 29/09/2026

**Phạm vi:** `packages/webmcp-ai-cli` trong `webmcp-automation-kit`

**Trạng thái:** kế hoạch; chưa sửa mã nguồn, chưa gọi model, chưa cập nhật hoặc cài CLI.

## 1. Kết luận kiểm tra

| Provider / máy | Phiên bản kiểm tra | Pin hiện tại | Tình trạng wrapper |
|---|---:|---:|---|
| Codex / máy hiện tại | 0.157.1 | 0.155.0-alpha.16 | `exec` và review portable hoạt động theo cờ cũ; chưa có lựa chọn Git diff review native, fork, JSONL native. |
| AGY / máy hiện tại | 1.2.13 | 1.2.9 | Bỏ lỡ JSON Schema, stream-json và cờ tắt slash commands; giới hạn prompt 128 KiB là giới hạn của adapter. |
| OpenCode / máy hiện tại | v2.0.18 | 2.0.15 | Profile v2, review và JSONL đã được hỗ trợ; cần chứng minh đường đưa prompt qua stdin và đồng bộ tài liệu/manifest. |
| Claude Code / `mac-pro14` (100.105.109.56) | 2.1.283 | 2.1.280 trong manifest **local** | CLI chỉ có trên máy M1; wrapper chạy ở máy hiện tại báo `installed: false` và chưa có transport SSH. |

`npm test` tại HEAD hiện tại: **492/492 pass**. `providers inspect ... --task-intent review` báo `taskReady: true` cho Codex và OpenCode trên máy hiện tại; đó là xác nhận cờ và mapping, **chưa** chứng minh đăng nhập, kết quả model hoặc ranh giới ghi file. Hai checkout local/M1 cùng commit `071b3b4` nhưng có thay đổi chưa commit khác nhau.

### Sửa các kết luận trong báo cáo ban đầu trước khi triển khai

1. **Claude qua SSH là việc nền tảng, không phải chỉ chỉnh `CLAUDE_BIN`.** `src/process-runner.mjs` spawn binary với `cwd` và môi trường **local**; đặt `CLAUDE_BIN=ssh` không giải quyết argv, thư mục, file, tín hiệu hủy và kết quả từ xa.
2. **Không mở `taskIntent: plan` của AGY chỉ vì có `--mode plan`.** Contract `webmcp-ai-plan-result/1` chưa tồn tại. `taskIntent` mô tả kết quả portable, còn `agentMode` là chế độ native/legacy. Giữ `plan` unsupported đến khi có contract và kiểm chứng riêng.
3. **Không mở AGY review/compose chỉ vì có `--json-schema` hoặc sandbox.** Review cần ngăn ghi file được chứng minh trước khi chạy; schema chỉ ràng buộc đầu ra. Giữ trạng thái unsupported cho tới khi có bằng chứng enforcement và kiểm thử chống ghi.
4. **Không ánh xạ `allowedReadRoots` sang `--add-dir`.** Codex mô tả `--add-dir` là thư mục được **ghi thêm**; AGY/Claude cũng mở rộng quyền truy cập. Cờ này không chứng minh giới hạn chỉ đọc. `allowedWriteRoots` cũng không được quảng cáo là giới hạn ghi của Codex `workspace-write` khi toàn workspace vẫn ghi được.
5. **`--bare` của Claude không phù hợp làm mặc định trên máy M1.** Help của 2.1.283 ghi rõ chế độ này không đọc OAuth/keychain, chỉ dùng API key hoặc helper được chỉ định. Có thể làm tùy chọn sau khi chứng minh đường auth tương ứng; không ghép vào review hiện hành.
6. **Không thêm `--continue`/`--last` mặc định.** Wrapper và skill hiện yêu cầu `sessionId` tường minh, gắn với task. Tính tiện dụng của CLI native không đủ để đổi ranh giới phiên.
7. **Không hiểu `--format json` của OpenCode là structured output.** Đó là JSONL sự kiện; giữ `structuredOutput: false` khi chưa có cờ schema native.
8. **Pin là phiên bản mục tiêu, không phải ảnh chụp tự động của máy hiện tại.** Chỉ đổi pin sau khi adapter và kiểm thử tương ứng được xác nhận. Claude phải được ghi nhận theo host M1; trạng thái `missing` trên local hiện là đúng theo cách manifest hiện được đọc, nhưng gây hiểu lầm nếu dùng nó để mô tả toàn cụm.

## 2. Thứ tự triển khai đề xuất

### P0 — Làm đúng tuyến máy, discovery và ranh giới an toàn

**A. Claude remote transport (bắt buộc theo yêu cầu vận hành).** Tạo cấu hình host tin cậy cho riêng provider Claude: SSH alias `mac-pro14`, binary `/Users/ttcenter/.local/bin/claude`, đường package/worker trên M1 và ánh xạ workspace được khai báo bởi operator, không nhận command/host tùy ý từ prompt hay JSON task. Chạy preflight qua SSH `BatchMode`, host-key checking, timeout; đối chiếu version/help/auth axis với máy M1. Dùng một remote worker có giao thức JSON stdin/stdout hoặc cơ chế tương đương với argv cố định; truyền prompt qua stdin và schema bằng dữ liệu đã kiểm soát, không nối shell string từ input. Worker trên M1 áp dụng cùng validation, env lọc, giới hạn output, timeout, cleanup và reviewer probe; outer wrapper trả envelope hiện có cùng `host`/transport metadata không lộ path/secret. Hủy/timeout phải kết thúc tiến trình Claude trên M1 và dọn artifact. Không tự fallback sang Claude local hoặc provider khác.

Với review/implement trên repo, yêu cầu ánh xạ workspace local → M1 và **xác minh nội dung đích**: commit, dirty diff/untracked set hoặc snapshot hash; nếu khác thì fail closed hoặc stage một snapshot đã kiểm soát. Cùng commit không đủ vì hai checkout đang có thay đổi khác nhau. Với compose-only, dùng workspace rỗng trên M1. Trước khi mở `full` qua SSH, kiểm tra rõ phạm vi file, môi trường và cleanup từ xa.

**B. Sửa discovery/manifest theo host.** Tách “provider khả dụng trên host X” khỏi “binary nằm trên PATH local”. Đưa Claude M1 vào host đúng, không báo `missing` chung cho cả cụm; giữ host `orbit` và quyền của nó nguyên trạng. Sau khi các cổng tương thích pass, pin đề xuất là Codex local `0.157.1`, AGY local `1.2.13`, OpenCode local `2.0.18` và Claude **remote M1** `2.1.283`; không chuyển phiên bản M1 vào ô Claude local. Cập nhật `install.mjs`, `updated`, `pinDigest` bằng `computePinDigest`; chạy `providers install --plan`/`--read-back` cho local và remote read-back riêng. Không kích hoạt self-update chỉ để xóa nhãn drift.

**C. Cờ bảo vệ print mode.** Thêm `--disable-slash-commands` cho AGY ở đường headless bị giới hạn và Claude remote ở compose/review; probe cờ theo version trước khi bật. Help Claude 2.1.283 diễn giải cờ là “Disable all skills”, nên kiểm tra tác động lên các luồng cố ý dùng skill; không ép vào `full` native passthrough nếu chức năng đó cần skill. Trong Claude review, bổ sung `--permission-prompts none` sau khi probe; giữ `dontAsk`, tools allowlist, denylist, `--safe-mode`, `--no-chrome` và `--no-session-persistence` cho phiên mới.

### P1 — Khả năng đầu ra và dữ liệu vào đã được CLI hỗ trợ

**D. AGY structured output.** Trong `agy.mjs`, nhận `request.schema`, serialize trước khi tạo temp artifact, truyền `--output-format json --json-schema <schema-file-or-json>` với quyền file hạn chế; parse đúng envelope thực tế của 1.2.13 và trả `response.structured`. Cập nhật `structuredOutput: true` **chỉ sau** canary schema hợp lệ, schema không hợp lệ và kiểm thử không rò file. Làm rõ cách JSON Schema native báo lỗi và cách wrapper phân loại `error.code`. Đồng bộ `README.md`, skill, `models inspect`, preflight và test.

**E. AGY prompt dài / stream-json.** `--input-format stream-json` yêu cầu `--output-format stream-json`; nó nhận từng message NDJSON và có thể chạy nhiều turn. Chỉ gửi **một** message cho mỗi `generate`, đóng stdin, parse final result và session từ event, giữ cap output/timeout. Giữ ngưỡng 128 KiB ở chế độ `-p` và thử ngưỡng mới trước khi công bố `maxPromptBytes: null`. Đừng giả định `--input-format stream-json` là thay thế tương đương cho text print cho tới khi test prompt có newline, ký tự đặc biệt, prompt lớn, schema và resume.

**F. Effort theo hai lớp.** Metadata provider phản ánh danh sách cờ CLI: AGY `low|medium|high|max`, Claude `low|medium|high|xhigh|max`. `model-capabilities.mjs` tiếp tục là bảng bằng chứng **theo model**: ví dụ model AGY đã bị phát hiện từ chối effort vẫn bị từ chối; không thêm `max` cho Gemini hay mọi model Claude chỉ dựa trên help. Mỗi override mới cần một canary hoặc nguồn model-specific, có ngày/host/version.

**G. OpenCode v2.** Giữ `--standalone`, profile v2, DB readiness, ordered permissions và JSONL parser hiện có. Xác minh `stdinPrompt: true` bằng canary của 2.0.18: tài liệu CLI chính thức chỉ mô tả message dạng positional; nếu stdin không phải hợp đồng được hỗ trợ, đổi sang đường nhập được xác nhận với giới hạn kích thước rõ ràng. Thêm fixture JSONL thật cho text/tool/error/session và kiểm tra `provider.no-route`/DB lock; không tạo parser telemetry thứ hai. Đồng bộ skill hiện còn mô tả `opencode-cli.db` và hỗ trợ v1, trong khi code hiện yêu cầu v2 và dùng `opencode.db`.

### P2 — Lệnh native có target rõ ràng

**H. Codex Git diff review.** Thêm một nhánh request riêng (`reviewTarget` hoặc contract tương đương) với **đúng một** trong `uncommitted`, `base`, `commit`; trường trống tiếp tục dùng portable review hiện hành. Khi có target, probe `codex exec review --help`, dựng `exec review` với `-c sandbox_mode="read-only"`, `-c approval_policy="never"`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--output-schema`, `--output-last-message`; không chuyển nguyên bộ flag từ `exec` sang subcommand vì `exec review --help` không liệt kê `--sandbox`/`--color`. Đánh giá lại prompt hiện cấm shell command, scope diff, output parser và result contract `webmcp-ai-review-result/1`. Chặn target trên provider khác, trên resume không rõ scope, và khi workspace không phải Git repo phù hợp. Canary staged/unstaged/untracked, base, commit, file hash trước/sau.

**I. Native JSONL telemetry.** Chọn `codex exec --json`/`exec review --json` khi có `--events` hoặc `--stream`, rồi parse `thread.started`, item lifecycle, command/test, final message và errors theo schema sự kiện thực tế; fallback text classification chỉ cho event không nhận diện. AGY stream-json dùng parser riêng. Giữ telemetry là thông tin tham khảo; kết quả cuối cùng vẫn lấy output contract và mã thoát. Nếu review CLI còn cấm `--events`, mở theo một thay đổi contract riêng có test stdout/stderr; không ngầm đổi luồng JSON cuối.

**J. Fork session tường minh.** Dùng một trường `sessionAction: resume|fork` chỉ khi có `sessionId`, với default `resume`; Codex ánh xạ `exec fork`, Claude `--resume <id> --fork-session`, OpenCode `--session <id> --fork`. Probe cờ của từng provider, phân biệt ID phiên nguồn/ID phiên mới trong envelope, giải quyết tương tác với `--ephemeral`/`--no-session-persistence`. Chỉ quảng cáo `explicitFork` khi ID mới được xác minh là có thể dùng tiếp. Không triển khai `--continue`/`--last` trong wrapper generic.

**K. Claude nâng cao, tách khỏi mặc định.** `--max-budget-usd` có thể là tùy chọn giới hạn chi phí cho lệnh `-p` sau khi chuẩn hóa số tiền và kiểm thử lỗi; không tự áp một mức cho tất cả request. `--bare` cần tuyến API key/helper được chứng minh và chỉ là tùy chọn riêng. `claude ultrareview` là review cloud nhiều agent, có chi phí, quyền và kết quả khác `ai.review`; chỉ thiết kế adapter riêng nếu có nhu cầu thực tế, không gộp vào review portable hiện tại.

## 3. Tệp và contract cần thay đổi khi thực hiện

| Tầng | Tệp chính | Công việc |
|---|---|---|
| Request/API | `src/cli.mjs`, `src/protocol.mjs`, `src/client.mjs`, `src/review.mjs`, `src/task-intent.mjs` | Trường host/transport được kiểm soát, review target, session action; xác thực tổ hợp trước spawn; dry-run được redacted. |
| Provider | `src/providers/agy.mjs`, `claude.mjs`, `codex.mjs`, `opencode.mjs` | Mapping cờ, parser đầu ra, probe theo subcommand/version; không nới quyền ngầm. |
| Vận hành | `src/process-runner.mjs`, module transport remote mới, `src/providers/install.mjs`, `src/providers/index.mjs` | SSH worker, timeout/cancel/cleanup, host-aware discovery, manifest và digest. |
| Metadata/telemetry | `src/model-capabilities.mjs`, `src/events.mjs`, `src/capabilities.mjs` | Phân biệt CLI effort/model effort; native event parser; receipt ghi nhận host và quyền hiệu dụng. |
| Kiểm thử/tài liệu | `tests/*`, `README.md`, `skills/webmcp-ai-cli/SKILL.md`, `docs/references/native-cli-matrix.md`, `CHANGELOG.md` | Fixture help/JSONL, remote fake SSH, canary có giới hạn, cập nhật ví dụ/pin/DB. Nếu sửa tài liệu repo, tuân thủ `docs/reference/documentation-convention.md`. |

## 4. Cổng nghiệm thu theo từng PR

1. **PR 1 — Remote Claude + discovery:** SSH preflight đúng host, binary tuyệt đối, version/help probe, auth axis riêng, remote workspace đồng nhất hoặc lỗi typed; kiểm thử injection (prompt/schema/path), mất SSH, timeout/hủy, cleanup, không lộ host path/secret. Review từ xa không sửa file; `installed` phản ánh host thực tế.
2. **PR 2 — AGY schema/input + hardening:** schema hợp lệ tạo structured result; schema lỗi có mã lỗi typed; một prompt stream-json chỉ tạo một turn; prompt dài không chạm argv; compose guard và review unsupported vẫn nguyên; slash command bị tắt trong lane đã chọn.
3. **PR 3 — Codex diff review + JSONL:** ba target Git được phân biệt; default portable review không đổi; help probe đúng `exec review`, mọi run review giữ sandbox read-only; output đạt `webmcp-ai-review-result/1`; telemetry không quyết định acceptance.
4. **PR 4 — OpenCode/effort/session + tài liệu:** xác minh stdin, fixture JSONL v2, fork explicit nếu đã chứng minh ID mới, metadata effort theo model; docs khớp DB/v2/host. `npm test`, package closure, dry-run và read-back pass; canary model/remote chỉ thực hiện bằng credential đang có và giới hạn chi phí đã thống nhất.

**Điều kiện đóng kế hoạch:** capability list, `providers inspect`, `preflight`, `doctor`, dry-run, lệnh thực và tài liệu cùng mô tả một sự thật cho từng provider/host; các capability chưa chứng minh vẫn báo unsupported hoặc unproven thay vì tự động suy diễn từ `--help`.

## 5. Nguồn đối chiếu

- Mã nguồn tại HEAD `071b3b4` và help/version/read-back local ngày 29/09/2026; Claude version/help lấy qua SSH `mac-pro14` cùng ngày. Không có model call.
- Tài liệu chính thức [OpenCode CLI commands](https://opencode.ai/v2/docs/cli/commands/): `run` nhận message dạng ví dụ positional; `--format json` xuất JSONL cho script.
- Các lệnh kiểm tra đã dùng: `codex exec --help`, `codex exec review --help`, `codex exec fork --help`, `agy --help`, `opencode run --help`, `node bin/webmcp-ai.mjs preflight --json`, `providers inspect ... --task-intent review`, `providers install --read-back --json`, `npm test`.

## 6. Implementation ledger (appended 2026-09-29, R6 closure — original text above untouched)

`npm test` = 658 pass / 0 fail at closure; `npm run test:package-closure` ok
(`rangeDiffCheck.ok: true`); coverage lines 90.03% OK / functions 93.12% OK /
branches 78.29% FAIL vs 80% (baseline at `f509063`: 90.94% / 93.25% / 78.03%
FAIL — branches slightly improved, no round made it worse; R6 edits are
comment-only). Local machine truth at commit: codex 0.157.1 `match`, agy
1.2.13 `match`, claude 2.1.283 `match` (review inspect `taskReady: true`;
an earlier same-session reading saw 2.1.279 with
`PROVIDER_CAPABILITY_DRIFT` and `taskReady: false`, resolved when the
machine updated to the pin before commit), opencode local 2.0.19 vs pin
2.0.18 `drift` (review inspect still `taskReady: true`,
`mapping.profile: v2`), host `m1` `state: unreachable`, host `orbit`
unauthorized. The remaining drift (opencode) is honest machine state, not a
doc error: pins (Claude 2.1.283, OpenCode 2.0.18, Codex 0.157.1, AGY 1.2.13)
match the manifest.

| Item | Status | Commit | Verification evidence |
|---|---|---|---|
| P0-A Claude remote transport | done+verified (tests); live canary unproven | `f30c4c1` (R2) | `node --test tests/remote-worker.test.mjs` 11/11 (selftest, fingerprint, run, flag allowlist exit 64, compose cwd:null cleanup, env strip, output cap, timeout SIGTERM/SIGKILL); dry-run `WEBMCP_AI_CLAUDE_HOST=m1 generate` shows `transport: { type: 'ssh', host: 'm1' }`; `providers install --plan --host m1` reports `state: unreachable` fail-closed (m1 unreachable at closure) |
| P0-B host-aware discovery/manifest | done+verified | `55b3b98` (R1) | `providers install --plan/--read-back --host local` (claude/codex/agy `match` vs pins; opencode `drift`, 2.0.19 vs pin 2.0.18), `--host orbit` (`authorized: false`), `--host m1` (`unreachable`, never throws); no local fallback |
| P0-C print-mode guards | done+verified | `55b3b98` (R1) | `printModeGuards: ['--disable-slash-commands']` on agy+claude in `providers list/inspect/preflight/doctor`; claude fork dry-run argv contains `--disable-slash-commands`; `--full` adds no flags |
| P1-D AGY structured output | done+verified | `8472a5d` (R3) | `capabilities.structuredOutput: true` + `structuredOutputProbe: { verifiedOn: 2026-09-29, cli: 1.2.13, method: canary }`; typed `PROVIDER_STRUCTURED_OUTPUT_MISSING` / `PROVIDER_SCHEMA_INVALID` |
| P1-E AGY long prompt / stream-json | done+verified | `8472a5d` (R3) | preflight `maxPromptBytes: 4194304` (4 MiB), artifacts `brain-fallback`; `PROMPT_TOO_LARGE` above cap; `stdinPrompt: false` (NDJSON envelope lane, never raw text) |
| P1-F two-layer effort | done+verified | `8472a5d` (R3) | `PROVIDER_EFFORT` agy `low\|medium\|high\|max`, claude `low\|medium\|high\|xhigh\|max` (codex/opencode omitted — no closed set); `models inspect --provider agy/claude` echo provider sets; `UNSUPPORTED_EFFORT` before spawn |
| P1-G OpenCode v2 | done+verified (pin drift noted) | `55b3b98` (R1) + `b5bdad6` (R4) | `providers inspect opencode --task-intent review`: `taskReady: true`, `mapping.profile: v2` on installed 2.0.19; v1 refused `PROVIDER_CAPABILITY_DRIFT`; real v2 JSONL fixtures under `tests/fixtures/opencode-v2-jsonl/`; `stdinPrompt: true` (2.0.19 canary); `structuredOutput: false` kept (`--format json` is event JSONL, not a schema contract) |
| P2-H codex Git diff review | done+verified | `b5bdad6` (R4) | `review --provider codex --review-target uncommitted --dry-run` argv = `exec review -c sandbox_mode="read-only" -c approval_policy="never" --ephemeral --ignore-user-config --ignore-rules --output-schema <tmp> --output-last-message <tmp> -` (no `--uncommitted`, scope named in prompt); non-codex → `UNSUPPORTED_CAPABILITY`; +sessionId → `TASK_INTENT_ACCESS_CONFLICT`; non-git → `REVIEW_TARGET_NOT_GIT` |
| P2-I native JSONL telemetry | done+verified (tests); live stream unproven here | `06f0c9e` (R5) | `classifyCodexEvent` (`thread.started`→researching, `turn.completed`→verifying, `turn.failed`→blocked); generate-lane `--json` only when `eventsRequested`, review lane never; final answer always from `--output-last-message` |
| P2-J explicit session fork | done+verified | `06f0c9e` (R5) | claude fork dry-run argv `--resume <session> --fork-session`; codex fork dry-run argv `exec fork -c sandbox_mode="read-only" … <session> -` while real runs fail closed `UNSUPPORTED_CAPABILITY` (`explicitFork: false`, reason in `src/client.mjs:654`); opencode `--session <id> --fork` (`explicitFork: true`); agy → `UNSUPPORTED_CAPABILITY`; review envelope frozen `{ id: null, resumable: false }` |
| P2-K Claude extras (`--max-budget-usd`, `--bare`, `ultrareview`) | deferred | — | No adapter; per §1 items 5–6 (`--bare` needs a proven API-key lane, no `--continue`/`--last`). Unproven, still reported unsupported — no wrapper claim exists. |

Residual unproven at closure: live remote-Claude run over SSH (host `m1`:
declared alias `mac-pro14` unresolvable from the coordinator machine; the
operator alias `mac-m1` is reachable but the host has no `claude` binary and
no worker deployment at closure → `state: unreachable` fail-closed); live
AGY/Codex/OpenCode model canaries beyond the recorded 2026-09-29 receipts;
operator-local `mac-m1` SSH alias in manual-fallback examples (no `Host mac*`
entry in local `~/.ssh/config`; wrapper's declared alias remains `mac-pro14`,
operator-overridable via `WEBMCP_AI_CLAUDE_SSH_ALIAS`).

### 6.1 Post-closure live remote check (2026-09-29, coordinator; after R6 commit `03c8ec1`)

SSH to the operator's M1 (`uyenuyen@mac-m1`, used via `WEBMCP_AI_CLAUDE_SSH_ALIAS`)
is reachable and the remote worker was deployed
(`/Users/uyenuyen/.webmcp-ai/claude-remote-worker.mjs`, sha256 identical to
`scripts/claude-remote-worker.mjs`). The host has **no `claude` binary**, so an
end-to-end remote Claude model call remains unproven. Live evidence collected:

- live worker selftest over ssh:
  `{"ok":true,"node":"v24.19.0","claudeBin":"/Users/uyenuyen/.local/bin/claude","claudeVersion":null}`;
- `providers inspect claude --task-intent review` with host `m1`:
  `transport: ssh`, `remote.state: unreachable`, `CLAUDE_REMOTE_UNREACHABLE`,
  `taskReady: false` — typed fail-closed over a real ssh connection;
- `providers install --read-back --host m1`: claude `state: unreachable`,
  `transport: ssh` (no local fallback);
- a real remote `generate` fails closed with `CLAUDE_REMOTE_UNREACHABLE`
  (never falls back to a local run).

Raw transcript: `temp/webmcp-ai-native-parity/receipts/R6-live-remote-canary.md`.
