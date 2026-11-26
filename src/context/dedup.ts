import { KilamuError } from '../core/errors.ts';
import { nowIso } from '../core/ids.ts';
import type { Db } from '../persistence/db.ts';

/**
 * Per-session file-read tracking (directive §9): lets hooks tell the agent a
 * file was already read and is unchanged, instead of paying for it twice.
 */

export interface ReadCheck {
  seen: boolean;
  /** True only when both the recorded and current hashes are known and equal. */
  sameContent: boolean;
  count: number;
}

export interface ReadStats {
  files: number;
  totalReads: number;
  duplicateReads: number;
}

function requireKey(sessionId: string, relPath: string): void {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new KilamuError('READ_INVALID', 'sessionId is required');
  if (typeof relPath !== 'string' || relPath.trim() === '') throw new KilamuError('READ_INVALID', 'path is required');
}

export class ReadTracker {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  recordRead(sessionId: string, relPath: string, sha256: string | null): void {
    requireKey(sessionId, relPath);
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO file_reads (session_id, path, sha256, count, first_at, last_at) VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(session_id, path) DO UPDATE SET count = count + 1, sha256 = excluded.sha256, last_at = excluded.last_at`,
      )
      .run(sessionId, relPath, sha256, now, now);
  }

  check(sessionId: string, relPath: string, currentSha: string | null): ReadCheck {
    requireKey(sessionId, relPath);
    const row = this.db
      .prepare('SELECT sha256, count FROM file_reads WHERE session_id = ? AND path = ?')
      .get(sessionId, relPath) as { sha256: string | null; count: number } | undefined;
    if (!row) return { seen: false, sameContent: false, count: 0 };
    const sameContent = row.sha256 !== null && currentSha !== null && row.sha256 === currentSha;
    return { seen: true, sameContent, count: row.count };
  }

  stats(sessionId: string): ReadStats {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new KilamuError('READ_INVALID', 'sessionId is required');
    const row = this.db
      .prepare('SELECT COUNT(*) AS files, COALESCE(SUM(count), 0) AS total FROM file_reads WHERE session_id = ?')
      .get(sessionId) as { files: number; total: number };
    return { files: row.files, totalReads: row.total, duplicateReads: row.total - row.files };
  }
}
