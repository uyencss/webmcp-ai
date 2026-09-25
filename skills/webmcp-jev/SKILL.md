---
name: webmcp-jev
description: Operate and integrate the WebMCP Jev fast-path decision runtime. Use when querying fast-path micro-decisions for browser automation or CAPTCHA routing, validating request envelopes offline, inspecting runtime readiness via doctor, or verifying fallback and redaction policies.
---

# WebMCP Jev Decision Runtime

`webmcp-jev` provides fast-path advisory micro-decisions for browser automation and CAPTCHA routing. Jev is strictly an advisory engine: it never executes browser actions, never holds execution permits, and emits non-binding recommendations that require independent verification.

## CLI Subcommands

Defined in `packages/webmcp-ai-cli/src/jev/cli.mjs`:

- `doctor [--json]`: Reports runtime readiness, version, resolved bin path, and provider probes (pinned to `not-probed`). Never calls provider models.
- `query --request <path> [--key-file <path> --base-url <url> --model <model> --skill-digest <digest>]`: Validates request JSON offline against `webmcp-jev-request/1`, then dispatches via TypeSafe HTTP transport. Default model is frozen pin `jev-1.13.0`.
- `canary [--live --attest-gate0 --key-file <path> --base-url <url>]`: Bounded live TypeSafe probe. Opt-in only; exits 1 (`BLOCKED_BY_GATE0`) if Gate 0 is unattested.
- `--version` / `-v` / `version`: Prints package version from doctor payload.

Exit codes: `0` (success), `1` (typed Jev failure on stderr), `2` (unknown subcommand or invalid options; never falls back to another route).

**Important CLI boundaries**:
- `browser-step` is a request `kind` inside a request file, NOT a CLI subcommand.
- `captcha classify` and `captcha next-step` do NOT exist as `webmcp-jev` CLI subcommands.

## Frozen Contracts

All envelopes adhere to frozen schemas in `docs/initiatives/2026-09-jev-fast-browser-runtime/contracts/`:

- Request: `webmcp-jev-request/1` (`$id: urn:webmcp:jev:request/1`) with request kinds `browser-step`, `captcha-classify`, `captcha-next-step`, `query`.
- Result: `webmcp-jev-result/1` (`$id: urn:webmcp:jev:result/1`) with answers for choice, score, or noul.
- Fallback: `webmcp-jev-fallback/1` (`$id: urn:webmcp:jev:fallback/1`) with 14 typed fallback reasons.
- Decision receipt: `webmcp-jev-decision-receipt/1` (`$id: urn:webmcp:jev:receipt/1`) with `executed: false` invariant.
- Vocabularies: `urn:webmcp:jev:browser-operation-vocabulary/1` (operations: `CLICK`, `TYPE_TEXT`, `HOVER`, `SELECT`, `WAIT`, `DONE`, `BLOCKED`), `urn:webmcp:jev:captcha-vocabulary/1`, and error taxonomy `urn:webmcp:jev:error-taxonomy/1`.

## Policy, Fallback, and Execution Boundaries

Enforced via `src/jev/policy/policy.mjs` and `src/jev/policy/rollout.mjs`:

- **Advisory Only**: Recommendations require an external runner to re-observe with a fresh snapshot and obtain an execution permit. `permitId` is correlation-only; Jev never grants execution authority.
- **Completion Invariant**: `DONE` is always advisory. Postconditions must be verified independently; Jev emits `completionClaim: false`.
- **Decision Engines**: Routes to `jev`, `normal-agent`, `deterministic`, `human`, or `blocked`.
- **Human Escalation**: Interactive Turnstile and irreversible operations route to `human` with reason `POLICY_CAPTCHA_HUMAN_REQUIRED` or `POLICY_IRREVERSIBLE_ACTION`.
- **Deterministic Fallback**: Tripped circuits (`JEV_CIRCUIT_OPEN`) fall back to deterministic handling; reCAPTCHA v3 never invokes solvers (`POLICY_CAPTCHA_V3_NO_SOLVE`).
- **Feature Flags and Kill Switch**: Global kill switch `JEV_FAST_PATH_DISABLED` immediately diverts to baseline. Per-capability flags (`browser-step`, `captcha-classify`, `captcha-next-step`, `query`) and origin allowlists (`flags.origins`) control rollout scope.

## Redaction Boundaries

Enforced by `src/jev/redact.mjs`: state and credentials must be redacted before hashing or wire transmission:
- Tokens, session cookies, passwords, and API keys are strictly excluded.
- Numerical profile IDs and local database paths are never packaged into requests or receipts.
- URL values are restricted to origins (`https?://host[:port]`); query strings, paths, fragments, and credentials are eliminated.
