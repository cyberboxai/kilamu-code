import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { KilamuError } from '../core/errors.ts';
import { nowIso, sha256 } from '../core/ids.ts';
import { redact } from '../core/redact.ts';
import type { ArtifactRef, ArtifactSink, CompressedSummary } from '../core/types.ts';
import { parseJson, type Db } from '../persistence/db.ts';
import type { Runtime } from '../runtime.ts';

/**
 * Content-addressed artifact store (directive §9). Large outputs live on disk
 * under `.kilamu/artifacts/<xx>/<id>.txt`; the agent receives a compact
 * summary plus a ref it can expand by line range on demand.
 *
 * Content is always redacted before hashing, so the id names exactly what is
 * stored and secrets never reach disk.
 */

const ID_PATTERN = /^a_[0-9a-f]{16}$/;
const KINDS: ReadonlySet<ArtifactRef['kind']> = new Set([
  'command-output', 'log', 'file-snapshot', 'report', 'handoff', 'context-pack', 'other',
]);
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 1000;

export interface ArtifactMeta {
  kind: ArtifactRef['kind'];
  source: string;
  executionId?: string;
  taskId?: string;
}

export interface ArtifactRecord extends ArtifactRef {
  sha256: string;
  executionId: string | null;
  taskId: string | null;
  summary: CompressedSummary | null;
}

export interface ArtifactSlice {
  ref: ArtifactRecord;
  content: string;
  lineStart: number;
  lineEnd: number;
  totalLines: number;
}

export interface ArtifactListFilter {
  kind?: ArtifactRef['kind'];
  executionId?: string;
  taskId?: string;
  limit?: number;
}

interface ArtifactRow {
  id: string;
  kind: string;
  source: string;
  rel_path: string;
  bytes: number;
  lines: number;
  sha256: string;
  summary_json: string | null;
  execution_id: string | null;
  task_id: string | null;
  created_at: string;
}

/** Split into lines; a trailing newline does not start an extra (empty) line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

export function assertArtifactId(id: string): void {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new KilamuError('ARTIFACT_ID_INVALID', `Invalid artifact id: ${JSON.stringify(String(id).slice(0, 40))}`);
  }
}

function toRecord(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    kind: row.kind as ArtifactRef['kind'],
    bytes: row.bytes,
    lines: row.lines,
    source: row.source,
    createdAt: row.created_at,
    sha256: row.sha256,
    executionId: row.execution_id,
    taskId: row.task_id,
    summary: parseJson<CompressedSummary | null>(row.summary_json, null),
  };
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export class ArtifactStore implements ArtifactSink {
  private readonly db: Db;
  private readonly dir: string;

  constructor(rt: Runtime) {
    this.db = rt.db;
    this.dir = rt.paths.artifactsDir;
  }

  /** Relative location derived only from a validated id (never from DB data). */
  private relPathFor(id: string): string {
    assertArtifactId(id);
    return `${id.slice(2, 4)}/${id}.txt`;
  }

  /** Artifact file path; refuses shard dirs or files that are symlinks (no redirected reads/writes). */
  private fileFor(id: string): string {
    const shard = join(this.dir, id.slice(2, 4));
    const file = join(this.dir, this.relPathFor(id));
    for (const p of [this.dir, shard, file]) {
      if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new KilamuError('UNSAFE_PATH', `Refusing symlinked artifact path: ${p}`);
    }
    return file;
  }

  private row(id: string): ArtifactRow | undefined {
    return this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
  }

  private requireRow(id: string): ArtifactRow {
    assertArtifactId(id);
    const row = this.row(id);
    if (!row) throw new KilamuError('ARTIFACT_NOT_FOUND', `Artifact not found: ${id}`);
    return row;
  }

  private writeContent(id: string, content: string): void {
    mkdirSync(join(this.dir, id.slice(2, 4)), { recursive: true, mode: 0o700 });
    atomicWrite(this.fileFor(id), content);
  }

  put(content: string, meta: ArtifactMeta): ArtifactRef {
    if (typeof content !== 'string') throw new KilamuError('ARTIFACT_INVALID', 'Artifact content must be a string');
    if (!KINDS.has(meta.kind)) throw new KilamuError('ARTIFACT_INVALID', `Unknown artifact kind: ${String(meta.kind)}`);
    if (typeof meta.source !== 'string' || meta.source === '') {
      throw new KilamuError('ARTIFACT_INVALID', 'Artifact source is required');
    }
    const clean = redact(content).text;
    const hash = sha256(clean);
    const id = `a_${hash.slice(0, 16)}`;
    const existing = this.db.prepare('SELECT * FROM artifacts WHERE sha256 = ? LIMIT 1').get(hash) as ArtifactRow | undefined;
    if (existing) {
      // Self-heal a lost file: we hold the exact content it addressed.
      if (!existsSync(this.fileFor(existing.id))) this.writeContent(existing.id, clean);
      return toRecord(existing);
    }
    const idClash = this.row(id);
    if (idClash) throw new KilamuError('ARTIFACT_COLLISION', `Artifact id ${id} already maps to different content`);
    this.writeContent(id, clean);
    const createdAt = nowIso();
    const bytes = Buffer.byteLength(clean, 'utf8');
    const lines = splitLines(clean).length;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO artifacts (id, kind, source, rel_path, bytes, lines, sha256, summary_json, execution_id, task_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(id, meta.kind, redact(meta.source).text, this.relPathFor(id), bytes, lines, hash, meta.executionId ?? null, meta.taskId ?? null, createdAt);
    return toRecord(this.requireRow(id));
  }

  private readContent(id: string): string {
    const file = this.fileFor(id);
    if (!existsSync(file)) throw new KilamuError('ARTIFACT_MISSING', `Artifact ${id} is recorded but its file is missing`);
    return readFileSync(file, 'utf8');
  }

  get(id: string): { ref: ArtifactRecord; content: string } {
    const row = this.requireRow(id);
    return { ref: toRecord(row), content: this.readContent(id) };
  }

  /** Read a 1-based inclusive line range. Out-of-range ends are clamped. */
  read(id: string, lineStart?: number, lineEnd?: number): ArtifactSlice {
    const { ref, content } = this.get(id);
    const lines = splitLines(content);
    const total = lines.length;
    const start = lineStart ?? 1;
    const end = Math.min(lineEnd ?? total, total);
    if (!Number.isInteger(start) || start < 1) throw new KilamuError('RANGE_INVALID', `lineStart must be an integer >= 1`);
    if (lineEnd !== undefined && (!Number.isInteger(lineEnd) || lineEnd < start)) {
      throw new KilamuError('RANGE_INVALID', `lineEnd must be an integer >= lineStart`);
    }
    if (start > total) return { ref, content: '', lineStart: start, lineEnd: start - 1, totalLines: total };
    return { ref, content: lines.slice(start - 1, end).join('\n'), lineStart: start, lineEnd: end, totalLines: total };
  }

  list(filter: ArtifactListFilter = {}): ArtifactRecord[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.kind) { where.push('kind = ?'); params.push(filter.kind); }
    if (filter.executionId) { where.push('execution_id = ?'); params.push(filter.executionId); }
    if (filter.taskId) { where.push('task_id = ?'); params.push(filter.taskId); }
    const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? DEFAULT_LIST_LIMIT)), MAX_LIST_LIMIT);
    const sql = `SELECT * FROM artifacts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...params) as unknown as ArtifactRow[]).map(toRecord);
  }

  setSummary(id: string, summary: CompressedSummary): void {
    this.requireRow(id);
    this.db.prepare('UPDATE artifacts SET summary_json = ? WHERE id = ?').run(JSON.stringify(summary), id);
  }

  /** Delete file and row. Returns false when the id is unknown. */
  remove(id: string): boolean {
    assertArtifactId(id);
    if (!this.row(id)) return false;
    rmSync(this.fileFor(id), { force: true });
    this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
    return true;
  }

  prune(opts: { olderThanDays: number }): number {
    const days = opts.olderThanDays;
    if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
      throw new KilamuError('ARTIFACT_INVALID', 'olderThanDays must be a non-negative number');
    }
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = this.db.prepare('SELECT id FROM artifacts WHERE created_at < ?').all(cutoff) as unknown as Array<{ id: string }>;
    let removed = 0;
    for (const { id } of rows) if (ID_PATTERN.test(id) && this.remove(id)) removed++;
    return removed;
  }
}
