# Changelog

All notable changes to `@gyga-browser/webmcp-ai` are documented here.

## Unreleased

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
