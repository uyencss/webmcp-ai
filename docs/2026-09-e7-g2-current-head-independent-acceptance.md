---
title: "WebMCP AI CLI E7-G2 current-head independent acceptance"
type: receipt
status: accepted-component
created: 2026-09-05
---

# WebMCP AI CLI E7-G2 current-head independent acceptance

## Decision

`ACCEPT_E7_G2_CURRENT_HEAD_COMPONENT`

This receipt accepts the current-head managed-host E7-G2 component only. It is
not E7-G2 full program closure and does not open E8, E9, Z6/Z7, provider E2E,
or production.

Native Sol was not used on this machine. The primary independent reviewer was
Claude Code through the WebMCP AI CLI wrapper (`provider=claude`,
`model=claude-opus-4-6`). AGY Claude Opus through the same wrapper independently
returned the same acceptance marker and corroborated the evidence.

## Exact identity and promotion boundary

- Candidate/current-head path:
  `/Users/ttcenter/.codex/worktrees/69e5/candidates/e7-g2-current-head-closure-luna-max-20260905`
- HEAD: `bb5dccea03b3a4da37ff965753d7a86ba9518aec`
- Tree: `21650ac177338e9985ea417a16626a50bf8ca0d4`
- E7-G2 source promotion commit: `2c7ac00b724ccee8015db26611085f5fb0a05036`
- Canonical owner:
  `/Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-ai-cli`
- Canonical owner was independently confirmed clean at the same HEAD/tree.
- The source write-set is already canonical; this acceptance commit adds only
  this receipt path.

## Independent evidence

- Full package suite: `655/655` pass, `0` fail, exit `0`.
- Managed-host suite: `71/71` pass, `0` fail, exit `0`.
- Package closure: `ok:true`, `25/25` checks, `0` violations.
- Hermetic package closure: `userConfigScoped=true`, `cacheScoped=true`,
  `prefixScoped=true`, `homeRepurposed=false`, range diff check clean.
- Packed artifact: `195` files with the bundled `@opencode-ai/sdk` and clean
  installed public entrypoint/lifecycle checks.
- Darwin primitive: `/usr/bin/sandbox-exec` available; both host-isolation
  probe and assertion returned `available:true`.
- Disposable Seatbelt launch: exit `0`, mode `darwin-seatbelt-broker`, broker
  FD `3`, launch boundary `seatbelt-file-literal-snapshot-v1`.
- Packaged supervisor FD3 `webmcp.echo` roundtrip passed through
  `webmcp-managed-broker/1`.
- Negative boundaries passed: unlisted broker tools, secret-bearing context,
  pre-existing hardlink, final-geometry TOCTOU swap, post-scan hardlink,
  allow-listed filename hardlink swap, authority mutation, and frozen env.
- No real provider was invoked; all checks are local fixture/provider-free
  managed-host evidence.

## Reconciliation note

The earlier bounded receipt recorded `653/655` because its isolated candidate
had no installed `@opencode-ai/sdk`. Installing the pinned lockfile dependency
with `npm ci --ignore-scripts` in the candidate changed no tracked files and
made the package closure and full suite pass. The current acceptance therefore
uses the post-install evidence and does not conceal the earlier environment
condition.

## Non-claims and next gate

- E7-G2 full program closure: `NOT_CLAIMED`.
- Provider runtime/live canary: `NOT_RUN`.
- E8-full, E9-full, Z6/Z7, production: `NOT_CLAIMED` / `NO-GO`.
- No provider credentials, machine identity, generic shell, unrestricted
  network, alternate browser, or unlisted MCP authority crossed the tested
  managed-host boundary.

After this receipt is promoted, retain the receipt-referenced candidate as
lineage rather than treating it as orphaned. Recompute E9 only after the
remaining terminal gates have independent receipts.

The receipt intentionally does not self-embed its post-commit hash.
