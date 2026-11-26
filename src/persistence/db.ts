import { DatabaseSync } from 'node:sqlite';
import { existsSync, renameSync } from 'node:fs';
import { KilamuError } from '../core/errors.ts';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations.ts';

/**
 * SQLite access via Node's built-in `node:sqlite` (zero native dependencies,
 * FTS5 compiled in). See docs/TECHNICAL_DECISIONS.md ADR-002.
 */
export type Db = DatabaseSync;

export interface OpenResult {
  db: Db;
  /** Set when a corrupt database was quarantined and a fresh one created. */
  recoveredFrom: string | null;
  migratedFrom: number;
}

function configure(db: Db): void {
  // busy_timeout first: concurrent first opens race on the WAL switch.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
}

export function currentVersion(db: Db): number {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!row) return 0;
  const v = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
  return v ? Number(v.value) : 0;
}

export function migrate(db: Db): number {
  const from = currentVersion(db);
  if (from > SCHEMA_VERSION) {
    throw new KilamuError('SCHEMA_TOO_NEW', `Database schema v${from} is newer than this Kilamu Code build (v${SCHEMA_VERSION}). Upgrade the plugin.`);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read under the write lock: another process may have migrated meanwhile.
      if (currentVersion(db) >= m.version) {
        db.exec('COMMIT');
        continue;
      }
      db.exec(m.sql);
      db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(m.version));
      db.exec('COMMIT');
    } catch (e) {
      safeRollback(db);
      throw new KilamuError('MIGRATION_FAILED', `Migration ${m.version} (${m.name}) failed: ${(e as Error).message}`);
    }
  }
  return from;
}

function isCorruption(e: unknown): boolean {
  const msg = (e as Error)?.message ?? '';
  return /malformed|not a database|SQLITE_CORRUPT|SQLITE_NOTADB|file is encrypted/i.test(msg);
}

/**
 * Open (or create) a database. On corruption the file is quarantined as
 * `<file>.corrupt-<timestamp>` (never deleted) and a fresh database created.
 */
export function openDb(file: string): OpenResult {
  let recoveredFrom: string | null = null;
  const tryOpen = (): Db => {
    const db = new DatabaseSync(file);
    try {
      configure(db);
      // Cheap probe on every open (hooks/statusline are hot paths); the full
      // integrity check runs in `kilamu doctor` (integrityCheck below).
      db.prepare('SELECT count(*) FROM sqlite_master').get();
      return db;
    } catch (e) {
      db.close();
      throw e;
    }
  };
  let db: Db;
  try {
    db = tryOpen();
  } catch (e) {
    if (!isCorruption(e) || file === ':memory:' || !existsSync(file)) throw e;
    recoveredFrom = `${file}.corrupt-${Date.now()}`;
    renameSync(file, recoveredFrom);
    for (const ext of ['-wal', '-shm']) if (existsSync(file + ext)) renameSync(file + ext, recoveredFrom + ext);
    db = tryOpen();
  }
  let migratedFrom: number;
  try {
    migratedFrom = migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return { db, recoveredFrom, migratedFrom };
}

/** Run `fn` inside a transaction; rolls back on throw. Not re-entrant. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    safeRollback(db);
    throw e;
  }
}

/** ROLLBACK that never masks the original error. */
function safeRollback(db: Db): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // transaction already gone (e.g. SQLite auto-rolled back); keep the original error
  }
}

/** Full integrity check (O(database size)); used by `kilamu doctor`. */
export function integrityCheck(db: Db): string {
  const r = db.prepare('PRAGMA quick_check').get() as Record<string, string> | undefined;
  return r ? String(Object.values(r)[0]) : 'ok';
}

export function getMeta(db: Db, key: string): string | null {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Consistent online backup to a new file (used by `kilamu export`). */
export function backupTo(db: Db, target: string): void {
  if (existsSync(target)) throw new KilamuError('EXISTS', `Backup target exists: ${target}`);
  db.prepare('VACUUM INTO ?').run(target);
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
