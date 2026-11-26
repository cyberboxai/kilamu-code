import { sha256 } from '../core/ids.ts';
import type { Db } from '../persistence/db.ts';
import { parseJson } from '../persistence/db.ts';

/** JSON with object keys sorted recursively, so equal args hash equally. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function keyOf(tool: string, args: unknown): string {
  return sha256(tool + canonical(args));
}

/** Result cache keyed by tool + args; entries are valid only while their fingerprint matches. */
export class ToolCache {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get<T = unknown>(tool: string, args: unknown, fingerprint: string): T | null {
    const row = this.db.prepare('SELECT fingerprint, result_json FROM tool_cache WHERE key = ?').get(keyOf(tool, args)) as
      | { fingerprint: string; result_json: string }
      | undefined;
    if (!row || row.fingerprint !== fingerprint) return null;
    return parseJson<T | null>(row.result_json, null);
  }

  set(tool: string, args: unknown, fingerprint: string, result: unknown): void {
    this.db
      .prepare(
        `INSERT INTO tool_cache(key, tool, fingerprint, result_json, created_at) VALUES(?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET fingerprint=excluded.fingerprint, result_json=excluded.result_json, created_at=excluded.created_at`,
      )
      .run(keyOf(tool, args), tool, fingerprint, JSON.stringify(result ?? null), new Date().toISOString());
  }

  clear(): void {
    this.db.exec('DELETE FROM tool_cache');
  }
}
