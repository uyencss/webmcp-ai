# Codex JSONL Fixtures

- `generate.jsonl`: Byte-identical raw capture from Codex 0.157.1 canary (`temp/webmcp-ai-native-parity/canaries/r5-codex-telemetry/events.jsonl`). Contains the 4 real observed event shapes: `thread.started`, `turn.started`, `item.completed(agent_message)`, and `turn.completed`.
- `generate.provenance.md`: Provenance details for `generate.jsonl` (CLI version, date, canary command, captured output, and observed events).
- `generate.synthetic.jsonl`: Synthetic defensive fixture for documented-but-unobserved Codex event shapes (`item.started(reasoning)`, `command_execution`, `file_change`, `todo_list`). These shapes are DEFENSIVE and were not observed on 0.157.1.
