import { createHash } from 'node:crypto';

const REQUIRED_PART_COLUMNS = ['id', 'time_created', 'data', 'session_id'];
const REQUIRED_TABLES = ['session', 'message', 'part', 'todo'];

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Machine-local operator mapping for external-observer diagnostics only.
 * It is never a global default, never read from Task JSON, and never used
 * for runtime-created sessions (those take the exact proven binding DB).
 */
export function resolveOperatorDiagnosticDb(env = {}) {
  const value = env.WEBMCP_AI_OPENCODE_DB_PATH;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Optional, version-gated, strictly read-only SQLite forensic fallback for the
 * OpenCode session store. Never auto-selected while documented surfaces work;
 * never a canonical runtime journal; never infers acceptance.
 */
export function createOpenCodeDiagnosticAdapter(options = {}) {
  const explicitNone = 'DatabaseSync' in options && options.DatabaseSync === undefined;
  let cachedImpl = options.DatabaseSync;

  function resolveImpl() {
    if (explicitNone) return null;
    if (cachedImpl !== undefined) return cachedImpl;
    try {
      // Dynamic import keeps Node 18 installs honest instead of crashing.
      const mod = new Function('return import("node:sqlite")')();
      cachedImpl = mod.DatabaseSync ?? null;
    } catch {
      cachedImpl = null;
    }
    return cachedImpl;
  }

  const adapter = {
    id: 'opencode-diagnostic',
    maturity: 'fixture-only',
    capabilities: {
      liveEvents: false,
      explicitResume: false,
      externalAttach: false,
      questionChannel: false,
      permissionControl: false,
      sameTurnSteer: false,
      gracefulInterrupt: false,
      preToolGate: false,
      processOwnership: false,
      fileEvents: false,
      testEvents: false,
    },
    async probe() { return { ...this.probeSync() }; },
    probeSync() {
      const impl = resolveImpl();
      if (!impl) {
        return {
          adapterId: this.id,
          available: false,
          reason: 'node:sqlite unavailable on this Node runtime; diagnostic stays disabled',
        };
      }
      return { adapterId: this.id, available: true, maturity: this.maturity };
    },
    digestDatabasePath(dbPath) {
      return sha256(`opencode-diagnostic:${dbPath}`);
    },
    sendReply() {
      throw new Error('diagnostic adapter exposes no control surface');
    },

    /**
     * Read sanitized parts after a monotonic cursor. Refuses database or
     * session identity mismatches; opens read-only or not at all.
     */
    readPartsAfter({ dbPath, expectedDatabaseDigest, sessionId, afterCursor }) {
      if (!dbPath || !expectedDatabaseDigest || !sessionId) {
        return { ok: false, error: { code: 'ORCHESTRATION_INVALID_INPUT', message: 'diagnostic requires db path, expected digest and session id' } };
      }
      if (this.digestDatabasePath(dbPath) !== expectedDatabaseDigest) {
        return {
          ok: false,
          error: { code: 'POLICY_DENIED', message: 'database identity does not match the proven binding; refusing diagnostic' },
        };
      }
      const impl = resolveImpl();
      if (!impl) {
        return { ok: false, error: { code: 'ORCHESTRATION_UNSUPPORTED_VERSION', message: 'node:sqlite unavailable' } };
      }
      if (impl.supportsSchema === false) {
        return {
          ok: false,
          error: { code: 'ORCHESTRATION_UNSUPPORTED_VERSION', message: 'session store schema unsupported for this version' },
        };
      }

      let db;
      try {
        db = new impl(dbPath, { readOnly: true });
      } catch (error) {
        return { ok: false, error: { code: 'PROVIDER_PROTOCOL_ERROR', message: `cannot open session store read-only: ${error.code ?? ''}` } };
      }

      try {
        // Version/schema gate before any content query.
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
        const missingTables = REQUIRED_TABLES.filter((table) => !tables.includes(table));
        if (missingTables.length > 0) {
          return { ok: false, error: { code: 'ORCHESTRATION_UNSUPPORTED_VERSION', message: `session store missing tables: ${missingTables.join(', ')}` } };
        }
        const columns = db.prepare('PRAGMA table_info(part)').all().map((row) => row.name);
        if (!REQUIRED_PART_COLUMNS.every((column) => columns.includes(column))) {
          return { ok: false, error: { code: 'ORCHESTRATION_UNSUPPORTED_VERSION', message: 'part table schema unrecognized' } };
        }

        const rows = db.prepare(
          'SELECT id, time_created AS time_created, data, session_id FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC',
        ).all(sessionId);

        const afterTime = afterCursor?.timeCreated ?? 0;
        const afterId = afterCursor?.id ?? '';
        const events = [];
        let cursor = { timeCreated: afterTime, id: afterId };
        for (const row of rows) {
          if (row.session_id !== sessionId) {
            return { ok: false, error: { code: 'POLICY_DENIED', message: 'diagnostic observed a foreign session row; refusing' } };
          }
          if (row.time_created < afterTime || (row.time_created === afterTime && row.id <= afterId)) continue;
          let parsed = {};
          try {
            parsed = JSON.parse(row.data);
          } catch {
            parsed = { type: 'unparseable' };
          }
          delete parsed.reasoning;
          events.push({
            kind: `part_${parsed.type ?? 'unknown'}`,
            summary: String(parsed.text ?? parsed.type ?? '').slice(0, 2000),
            cursor: { timeCreated: row.time_created, id: row.id },
            payload: { partId: row.id },
          });
          cursor = { timeCreated: row.time_created, id: row.id };
        }
        return { ok: true, events, cursor };
      } finally {
        try {
          db.close();
        } catch {
          // Close is best-effort on an already-failed handle.
        }
      }
    },
  };

  Object.freeze(adapter.capabilities);
  return adapter;
}
