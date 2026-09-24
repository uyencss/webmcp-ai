import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let cached = null;
export function v2DbPath() {
  if (!cached) {
    const dir = mkdtempSync(join(tmpdir(), 'webmcp-opencode-v2-db-'));
    const db = join(dir, 'opencode.db');
    writeFileSync(db, Buffer.concat([Buffer.from('SQLite format 3\0', 'utf8'), Buffer.alloc(512)]));
    cached = db;
  }
  return cached;
}
export function withV2Db(env) { return { ...env, OPENCODE_DB: v2DbPath() }; }
