# Changelog

All notable changes to `@gyga-browser/webmcp-ai` are documented here.

## Unreleased

## 0.3.0-alpha.0 - 2026-08-23

- Add the opt-in portable CLI-agent orchestration runtime (alpha): explicit
  Coordination lifecycle, single-writer supervisor with fenced epochs, an
  append-only machine-local journal, worker callbacks, and independent
  acceptance through `dispatch.verify`.
- Ship four validated adapters — `owned-process`, `opencode-server` (pinned
  OpenCode 1.18.21 with a per-binding isolated SQLite database),
  `claude-stream`, and `codex-exec`. Every adapter reports honest
  evidence-derived maturity; alpha maturity is always `fixture-only`, which is
  not supported.
- Add `webmcp-ai orchestration capabilities|guide|create|call|prune` plus a
  kill switch: `WEBMCP_AI_ORCHESTRATION_DISABLED=1` blocks all mutations while
  read-only verbs and every one-shot command stay stable.
- Harden runtime teardown: bootstrap failures never orphan a server process,
  stops sweep the whole detached process group, and worker close escalates
  SIGTERM to SIGKILL at group level.
- Publish the version-matched orchestration runtime guide alongside the CLI
  subagent brief, with explicit brief-fallback vs. runtime-routing guidance.
- Add `npm run test:package-closure`: a hermetic package-closure verifier that
  audits the packed tarball surface, version consistency, and kill-switch
  stability without ambient npm configuration.
- Add the authorized live canary lane (`npm run canary -- <adapter-id>`):
  dual-opt-in bounded scenarios that record machine-local mode-`0600` receipts
  binding adapter digest, executable path digest and runtime version, letting
  `orchestration capabilities` report evidence-derived `canary-proven` for a
  single adapter on one machine. The runner never logs in and fails closed
  without explicit authorization.

## 0.2.1 - 2026-07-24

- Add an enum-safe AGY custom-agent selector through JSON input and
  `--agent`, while other providers reject the AGY-only option.
- Add normalized AGY custom-agent discovery through `agents list`.

## 0.2.0 - 2026-07-24

- Add an explicit, enum-constrained AGY `agentMode` with safe `plan` default
  and supervised `accept-edits` opt-in; Claude and Codex reject the option.
- Keep failed `tool-call` responses protocol-shaped, echoing `protocol` and
  `requestId` alongside `ok: false`.
- Rename the stray `agents/openai.yaml` skill descriptor to `agents/codex.yaml`
  and correct its provider list; there is no OpenAI provider.
- Document the package/bin name (`webmcp-ai`) vs. the `-cli` directory/skill
  convention, and the provider list vs. agent-host list.

## 0.1.0 - 2026-07-13

- Add the provider-neutral `webmcp-ai` CLI.
- Add safe AGY, Claude Code, and Codex adapters.
- Add the versioned `webmcp-tool-v1` JSON-over-stdio protocol.
- Add provider diagnostics, normalized errors, timeouts, and output limits.
- Add the `webmcp-ai-cli` companion skill and multi-agent installer.
