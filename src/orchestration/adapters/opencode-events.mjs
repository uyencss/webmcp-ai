import { sanitizeValue } from '../redaction.mjs';

/**
 * Map one provider SSE/NDJSON event onto the closed Delivery registry.
 * Foreign sessions yield null; reasoning content is dropped entirely; raw
 * completed tool output never persists verbatim.
 */
export function normalizeOpenCodeEvent(event, binding, deduper = createEventDeduper()) {
  if (typeof event !== 'object' || event === null) return null;
  const sessionId = typeof event.sessionID === 'string' ? event.sessionID : null;
  if (binding?.sessionId && sessionId && sessionId !== binding.sessionId) {
    return null;
  }

  const part = event.part ?? event.properties?.part ?? null;
  const properties = event.properties ?? {};
  const permission = properties.permission ?? null;

  let kind = null;
  let deliveryType = null;
  let summary = '';
  let payload = {};

  switch (event.type) {
    case 'server.connected': {
      kind = 'server_connected';
      deliveryType = 'progress';
      summary = 'opencode server connected';
      break;
    }
    case 'session.status': {
      const status = properties.status?.type ?? event.status?.type ?? 'unknown';
      if (status === 'idle') {
        kind = 'session_status_idle';
        deliveryType = 'progress';
        summary = 'provider session idle (terminal evidence only)';
        payload = { terminalEvidence: true };
      } else if (status === 'retry') {
        kind = 'retry';
        deliveryType = 'progress';
        summary = 'provider session retrying';
        payload = { activity: 'retrying' };
      } else {
        kind = `session_status_${status}`;
        deliveryType = 'progress';
        summary = `provider session ${status}`;
        payload = { activity: status === 'busy' ? 'working' : status };
      }
      break;
    }
    case 'message.part.updated': {
      if (!part || (binding?.sessionId && part.sessionID !== binding.sessionId)) return null;
      const partType = part.type;
      if (partType === 'reasoning') return null; // dropped, not masked
      if (partType === 'text') {
        kind = 'assistant_text';
        deliveryType = 'progress';
        summary = String(part.text ?? '').slice(0, 2000);
        payload = { messageId: part.messageID };
      } else if (partType === 'tool') {
        kind = 'tool_activity';
        deliveryType = 'progress';
        summary = `tool ${part.tool ?? 'unknown'} ${part.state?.status ?? ''}`.trim();
        payload = {
          tool: part.tool ?? null,
          status: part.state?.status ?? null,
          // Completed tool output is summarized away, never persisted verbatim.
          outputOmitted: Boolean(part.state?.output),
        };
      } else if (partType === 'step-finish') {
        kind = 'step_finished';
        deliveryType = 'progress';
        summary = `step finished (${part.tokens?.total ?? 0} tokens)`;
        payload = { tokensTotal: part.tokens?.total ?? 0 };
      } else if (partType === 'retry') {
        kind = 'retry';
        deliveryType = 'progress';
        summary = `attempt retry #${part.attempt ?? '?'}`;
        payload = { attempt: part.attempt ?? null };
      } else {
        kind = `part_${partType}`;
        deliveryType = 'progress';
        summary = `${partType} part updated`;
      }
      break;
    }
    case 'file.edited': {
      kind = 'file_edited';
      deliveryType = 'progress';
      summary = String(properties.file ?? event.file ?? '');
      payload = { file: summary };
      break;
    }
    case 'todo.updated': {
      kind = 'todo_updated';
      deliveryType = 'progress';
      const todos = properties.todos ?? [];
      summary = `todos updated (${todos.filter((todo) => todo.status === 'completed').length}/${todos.length} completed)`;
      payload = { todos: todos.map((todo) => ({ id: todo.id, status: todo.status })) };
      break;
    }
    case 'permission.updated': {
      kind = 'permission_requested';
      deliveryType = 'permission_requested';
      summary = `permission requested: ${permission?.title ?? permission?.type ?? 'unknown'}`;
      payload = { permissionId: permission?.id ?? null, type: permission?.type ?? null };
      break;
    }
    case 'permission.replied': {
      kind = 'permission_resolved';
      deliveryType = 'permission_resolved';
      summary = `permission replied: ${properties.response ?? ''}`;
      payload = { permissionId: properties.permissionID ?? null, response: properties.response ?? null };
      break;
    }
    case 'session.diff': {
      kind = 'diff_summary';
      deliveryType = 'progress';
      const files = properties.diff?.files ?? [];
      const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0);
      const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0);
      summary = `diff: ${files.length} files (+${additions}/-${deletions})`;
      payload = {
        files: files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions })),
        materializedDiffOmitted: true,
      };
      break;
    }
    case 'session.error': {
      kind = 'session_error';
      deliveryType = 'escalation';
      summary = `provider error: ${properties.error?.name ?? 'unknown'}`;
      payload = { name: properties.error?.name ?? null, message: String(properties.error?.message ?? '').slice(0, 500) };
      break;
    }
    default:
      return null;
  }

  const dedupeKey = buildDedupeKey(event, part, permission, kind);
  if (!deduper.seen(dedupeKey)) return null;

  return sanitizeValue({
    kind,
    deliveryType,
    summary,
    dedupeKey,
    payload,
    sessionId,
  });
}

function buildDedupeKey(event, part, permission, kind) {
  const identityParts = [
    event.sessionID ?? '',
    part?.id ?? permission?.id ?? event.properties?.permissionID ?? '',
    part?.type ?? event.type,
    kind,
  ];
  return identityParts.join(':');
}

/** Stable-identity dedupe helper shared by adapters and reconciliation. */
export function createEventDeduper() {
  const seen = new Set();
  return {
    seen(key) {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    reset() {
      seen.clear();
    },
    size: () => seen.size,
  };
}
