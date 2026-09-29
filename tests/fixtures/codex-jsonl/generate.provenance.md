# Provenance: Codex JSONL Telemetry Canary

- **Date**: 2026-09-29
- **CLI Version**: `codex 0.157.1`
- **Canary Directory**: `temp/webmcp-ai-native-parity/canaries/r5-codex-telemetry`
- **Output Captured**: `HELLO` (stored in `out.txt` and `events.jsonl` agent message; prompt requested `HELLO` / `TELEMETRY_OK`)

## Exact Canary Command

```bash
codex exec --json --sandbox read-only --ephemeral --skip-git-repo-check \
  -c approval_policy="never" -c model_reasoning_effort="low" -m gpt-6-sol \
  -o out.txt -
```

*(Prompt supplied on stdin)*

## Observed Event Types (4 lines)

1. `thread.started` (`thread_id: "01a0ebfe-ed37-7780-a546-d6e7fa9a95b1"`)
2. `turn.started`
3. `item.completed` (`item.type: "agent_message"`, text: `"HELLO"`)
4. `turn.completed` (`usage: { input_tokens: 24529, cached_input_tokens: 8064, output_tokens: 6, ... }`)

This fixture (`generate.jsonl`) is byte-identical to the raw `events.jsonl` produced by this canary run.
