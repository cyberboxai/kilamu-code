import { readFileSync } from 'node:fs';
import { KilamuError, errorMessage } from '../core/errors.ts';
import { run } from '../core/exec.ts';
import { nowIso, sha256 } from '../core/ids.ts';
import { safeResolve, toRel } from '../core/paths.ts';
import { redact } from '../core/redact.ts';
import type { GraphEdge, SymbolRecord } from '../core/types.ts';
import { tx, type Db } from '../persistence/db.ts';
import type { Runtime } from '../runtime.ts';
import { chunkPages, chunkText, type Chunk } from './chunker.ts';
import { clip, lineAt, lineIndex } from './extractors/common.ts';
import { EXTRACTORS, NO_PARSER, PDF_PARSER, TEXT_PARSER, type ExtractContext } from './extractors/index.ts';
import { CODE_LANGUAGES, detectLanguage, type Language } from './languages.ts';
import { listProjectFiles, type WalkedFile } from './walker.ts';

/**
 * Incremental project indexer (directive §10). Owns the `files`, `symbols`,
 * `edges` and `chunks_fts` tables. A file is reprocessed only when its sha256
 * or the parser identity (name + version) changed. Every write happens inside
 * a transaction; FTS content is redacted by the chunker.
 */
export interface IndexStats {
  scanned: number;
  indexed: number;
  unchanged: number;
  removed: number;
  skipped: number;
  errors: number;
  durationMs: number;
  byLanguage: Record<string, number>;
}

export interface IndexOptions {
  /** Drop stored rows (within `paths`, if given) and reindex from scratch. */
  rebuild?: boolean;
  /** Restrict indexing (and removal) to these files or directories. */
  paths?: string[];
}

/** Confidence that marks cross-layer identifier → SQL column edges (and only those). */
export const LINK_CONFIDENCE = 0.35;
const LINK_MIN_LENGTH = 4;
const LINK_MAX_PER_FILE = 200;
/** Column names too generic to link by bare identifier match. */
const LINK_STOPWORDS = new Set([
  'name', 'type', 'data', 'value', 'text', 'date', 'time', 'user', 'role', 'status', 'state', 'code', 'kind', 'size',
  'key', 'true', 'false', 'null', 'none', 'self', 'this', 'from', 'with', 'test', 'path', 'file', 'body', 'title', 'description',
]);
const FLUSH_EVERY = 200;
const PDF_TIMEOUT_MS = 60_000;

interface StoredFile {
  sha256: string;
  parser: string;
  parser_version: number;
}

interface FileRow {
  path: string;
  sha256: string;
  size: number;
  mtimeMs: number;
  language: Language;
  parser: string;
  parserVersion: number;
  status: 'INDEXED' | 'SKIPPED' | 'ERROR';
  detail: string | null;
}

interface FileWrite {
  row: FileRow;
  symbols: SymbolRecord[];
  edges: GraphEdge[];
  chunks: Chunk[];
  /** Decoded text, kept only until cross-layer links are computed (never persisted). */
  text?: string;
}

/** Column name → `column:<table>.<col>` refs eligible for identifier linking. */
type ColumnIndex = Map<string, string[]>;

type Stmt = ReturnType<Db['prepare']>;

interface Statements {
  insertSymbol: Stmt;
  insertEdge: Stmt;
  insertChunk: Stmt;
  upsertFile: Stmt;
  deleteSymbols: Stmt;
  deleteEdges: Stmt;
  deleteChunks: Stmt;
  deleteFiles: Stmt;
  deleteLinks: Stmt;
}

const emptyStats = (): IndexStats => ({ scanned: 0, indexed: 0, unchanged: 0, removed: 0, skipped: 0, errors: 0, durationMs: 0, byLanguage: {} });

export class Indexer {
  private readonly rt: Runtime;
  private readonly db: Db;
  private readonly st: Statements;
  private running = false;
  private pdfAvailable: boolean | null = null;

  constructor(rt: Runtime) {
    this.rt = rt;
    this.db = rt.db;
    const p = (sql: string) => this.db.prepare(sql);
    const inList = 'IN (SELECT value FROM json_each(?))';
    this.st = {
      insertSymbol: p('INSERT INTO symbols(path, name, kind, line_start, line_end, signature, exported) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      insertEdge: p('INSERT INTO edges(src, rel, dst, path, line, confidence) VALUES (?, ?, ?, ?, ?, ?)'),
      insertChunk: p('INSERT INTO chunks_fts(path, line_start, line_end, content) VALUES (?, ?, ?, ?)'),
      upsertFile: p(`INSERT INTO files(path, sha256, size, mtime_ms, language, parser, parser_version, status, detail, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET sha256=excluded.sha256, size=excluded.size, mtime_ms=excluded.mtime_ms, language=excluded.language,
          parser=excluded.parser, parser_version=excluded.parser_version, status=excluded.status, detail=excluded.detail, indexed_at=excluded.indexed_at`),
      deleteSymbols: p(`DELETE FROM symbols WHERE path ${inList}`),
      deleteEdges: p(`DELETE FROM edges WHERE path ${inList}`),
      deleteChunks: p(`DELETE FROM chunks_fts WHERE path ${inList}`),
      deleteFiles: p(`DELETE FROM files WHERE path ${inList}`),
      deleteLinks: p(`DELETE FROM edges WHERE path ${inList} AND rel = 'REFERENCES' AND confidence = ? AND src LIKE 'file:%' AND dst LIKE 'column:%'`),
    };
  }

  async index(opts: IndexOptions = {}): Promise<IndexStats> {
    if (this.running) throw new KilamuError('INDEX_BUSY', 'An index run is already in progress for this runtime');
    this.running = true;
    try {
      return await this.runIndex(opts);
    } finally {
      this.running = false;
    }
  }

  private async runIndex(opts: IndexOptions): Promise<IndexStats> {
    const started = Date.now();
    const stats = emptyStats();
    const root = this.rt.paths.root;
    const prefixes = opts.paths?.map((p) => toRel(root, safeResolve(root, p)));
    const inScope = (rel: string) => !prefixes || prefixes.some((p) => p === '' || rel === p || rel.startsWith(`${p}/`));

    const walk = await listProjectFiles(root, {
      respectGitignore: this.rt.config.indexing.respectGitignore,
      maxFiles: this.rt.config.indexing.maxFiles,
      maxFileBytes: this.rt.config.context.maxFileBytes,
    });
    const files = walk.files.filter((f) => inScope(f.rel));
    stats.skipped += walk.skipped.filter((s) => inScope(s.rel)).length;

    if (opts.rebuild) this.removePaths(this.storedPaths().filter(inScope));
    const stored = this.storedFiles();
    const columnsBefore = this.columnSignature();
    const known = new Set(walk.files.map((f) => f.rel));
    const ctx: ExtractContext = { fileExists: (rel) => known.has(rel) };

    // Removals first and SQL first: the column set is final before any code file is linked.
    const current = new Set(files.map((f) => f.rel));
    const gone = [...stored.keys()].filter((rel) => inScope(rel) && !current.has(rel));
    this.removePaths(gone);
    stats.removed = gone.length;
    const ordered = [...files.filter((f) => detectLanguage(f.rel) === 'sql'), ...files.filter((f) => detectLanguage(f.rel) !== 'sql')];

    const pending: FileWrite[] = [];
    const linked = new Set<string>();
    let columns: ColumnIndex | null = null;
    for (const f of ordered) {
      const language = detectLanguage(f.rel);
      stats.scanned++;
      stats.byLanguage[language] = (stats.byLanguage[language] ?? 0) + 1;
      const write = await this.processFile(f, language, stored.get(f.rel), ctx);
      if (!write) {
        stats.unchanged++;
        continue;
      }
      if (write.row.status === 'INDEXED') stats.indexed++;
      else if (write.row.status === 'ERROR') stats.errors++;
      else stats.skipped++;
      if (write.text !== undefined && write.row.status === 'INDEXED' && CODE_LANGUAGES.has(language)) {
        if (!columns) {
          this.flush(pending.splice(0));
          columns = this.columnIndex();
        }
        write.edges.push(...linkEdges(f.rel, write.text, columns));
        linked.add(f.rel);
      }
      write.text = undefined;
      pending.push(write);
      if (pending.length >= FLUSH_EVERY) this.flush(pending.splice(0));
    }
    this.flush(pending.splice(0));
    if (this.columnSignature() !== columnsBefore) this.relinkUnchanged(linked);

    stats.durationMs = Date.now() - started;
    this.rt.log.info('knowledge.index', { ...stats, byLanguage: undefined, rebuild: Boolean(opts.rebuild), scoped: Boolean(prefixes) });
    return stats;
  }

  // -------------------------------------------------------------------------
  // Per-file processing
  // -------------------------------------------------------------------------

  /** Returns null when the stored row is current. */
  private async processFile(f: WalkedFile, language: Language, prev: StoredFile | undefined, ctx: ExtractContext): Promise<FileWrite | null> {
    const base = { path: f.rel, size: f.size, mtimeMs: f.mtimeMs, language };
    let buf: Buffer;
    try {
      buf = readFileSync(safeResolve(this.rt.paths.root, f.rel));
    } catch (e) {
      return this.errorWrite({ ...base, sha256: '' }, TEXT_PARSER, `read failed: ${errorMessage(e)}`);
    }
    const digest = sha256(buf);
    const parser = language === 'pdf' ? ((await this.hasPdftotext()) ? PDF_PARSER : NO_PARSER) : (EXTRACTORS[language] ?? TEXT_PARSER);
    if (prev && prev.sha256 === digest && prev.parser === parser.name && prev.parser_version === parser.version) return null;
    const row = { ...base, sha256: digest };
    if (language === 'pdf') return this.processPdf(row, parser.name === PDF_PARSER.name);

    const text = buf.toString('utf8');
    const chunks = chunkText(text);
    const extractor = EXTRACTORS[language];
    if (!extractor) return { row: { ...row, parser: TEXT_PARSER.name, parserVersion: TEXT_PARSER.version, status: 'INDEXED', detail: null }, symbols: [], edges: [], chunks, text };
    try {
      const out = extractor.extract(f.rel, text, ctx);
      const symbols = out.symbols.map((s) => ({ ...s, signature: redact(s.signature).text }));
      return { row: { ...row, parser: extractor.name, parserVersion: extractor.version, status: 'INDEXED', detail: null }, symbols, edges: out.edges, chunks, text };
    } catch (e) {
      const w = this.errorWrite(row, extractor, `extractor failed: ${errorMessage(e)}`);
      w.chunks = chunks;
      return w;
    }
  }

  private async processPdf(row: Omit<FileRow, 'parser' | 'parserVersion' | 'status' | 'detail'>, available: boolean): Promise<FileWrite> {
    if (!available) {
      return { row: { ...row, parser: NO_PARSER.name, parserVersion: NO_PARSER.version, status: 'SKIPPED', detail: 'pdftotext unavailable' }, symbols: [], edges: [], chunks: [] };
    }
    const abs = safeResolve(this.rt.paths.root, row.path);
    const r = await run(['pdftotext', '-layout', abs, '-'], { cwd: this.rt.paths.root, timeoutMs: PDF_TIMEOUT_MS, maxOutputBytes: 32 * 1024 * 1024 });
    if (r.exitCode !== 0) {
      const why = r.timedOut ? `timed out after ${PDF_TIMEOUT_MS}ms` : `exit ${r.exitCode}: ${clip(r.stderr, 160)}`;
      return this.errorWrite(row, PDF_PARSER, `pdftotext failed (${why})`);
    }
    return { row: { ...row, parser: PDF_PARSER.name, parserVersion: PDF_PARSER.version, status: 'INDEXED', detail: null }, symbols: [], edges: [], chunks: chunkPages(r.stdout) };
  }

  private errorWrite(row: Omit<FileRow, 'parser' | 'parserVersion' | 'status' | 'detail'>, parser: { name: string; version: number }, detail: string): FileWrite {
    return { row: { ...row, parser: parser.name, parserVersion: parser.version, status: 'ERROR', detail: redact(detail).text }, symbols: [], edges: [], chunks: [] };
  }

  private async hasPdftotext(): Promise<boolean> {
    if (this.pdfAvailable === null) {
      const r = await run(['pdftotext', '-v'], { cwd: this.rt.paths.root, timeoutMs: 5000, maxOutputBytes: 64 * 1024 });
      this.pdfAvailable = r.exitCode === 0;
    }
    return this.pdfAvailable;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private flush(writes: FileWrite[]): void {
    if (writes.length === 0) return;
    const paths = JSON.stringify(writes.map((w) => w.row.path));
    const at = nowIso();
    tx(this.db, () => {
      this.st.deleteSymbols.run(paths);
      this.st.deleteEdges.run(paths);
      this.st.deleteChunks.run(paths);
      for (const w of writes) {
        const r = w.row;
        this.st.upsertFile.run(r.path, r.sha256, r.size, r.mtimeMs, r.language, r.parser, r.parserVersion, r.status, r.detail, at);
        for (const s of w.symbols) this.st.insertSymbol.run(s.path, s.name, s.kind, s.lineStart, s.lineEnd, s.signature, s.exported ? 1 : 0);
        for (const e of w.edges) this.st.insertEdge.run(e.src, e.rel, e.dst, e.path, e.line, e.confidence);
        for (const c of w.chunks) this.st.insertChunk.run(r.path, c.lineStart, c.lineEnd, c.content);
      }
    });
  }

  private removePaths(paths: string[]): void {
    for (let i = 0; i < paths.length; i += 500) {
      const batch = JSON.stringify(paths.slice(i, i + 500));
      tx(this.db, () => {
        this.st.deleteSymbols.run(batch);
        this.st.deleteEdges.run(batch);
        this.st.deleteChunks.run(batch);
        this.st.deleteFiles.run(batch);
      });
    }
  }

  private storedPaths(): string[] {
    return (this.db.prepare('SELECT path FROM files').all() as Array<{ path: string }>).map((r) => r.path);
  }

  private storedFiles(): Map<string, StoredFile> {
    const rows = this.db.prepare('SELECT path, sha256, parser, parser_version FROM files').all() as unknown as Array<StoredFile & { path: string }>;
    return new Map(rows.map((r) => [r.path, { sha256: r.sha256, parser: r.parser, parser_version: Number(r.parser_version) }]));
  }

  // -------------------------------------------------------------------------
  // Cross-layer linking: code identifiers → SQL columns
  // -------------------------------------------------------------------------

  private columnNames(): string[] {
    return (this.db.prepare("SELECT DISTINCT name FROM symbols WHERE kind = 'column' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  }

  private columnSignature(): string {
    return sha256(this.columnNames().join('\n'));
  }

  private columnIndex(): ColumnIndex {
    const index: ColumnIndex = new Map();
    for (const full of this.columnNames()) {
      const col = full.slice(full.indexOf('.') + 1);
      if (col.length < LINK_MIN_LENGTH || LINK_STOPWORDS.has(col)) continue;
      const refs = index.get(col) ?? [];
      refs.push(`column:${full}`);
      index.set(col, refs);
    }
    return index;
  }

  /**
   * The column set changed during this run: recompute link edges for code
   * files that were not reprocessed (their text is re-read from disk).
   */
  private relinkUnchanged(alreadyLinked: Set<string>): void {
    const columns = this.columnIndex();
    const langs = [...CODE_LANGUAGES];
    const targets = (this.db.prepare(`SELECT path FROM files WHERE status = 'INDEXED' AND language IN (${langs.map(() => '?').join(',')}) ORDER BY path`)
      .all(...langs) as Array<{ path: string }>).map((r) => r.path).filter((p) => !alreadyLinked.has(p));
    for (let i = 0; i < targets.length; i += FLUSH_EVERY) {
      const batch = targets.slice(i, i + FLUSH_EVERY);
      const edges = batch.flatMap((rel) => {
        try {
          return linkEdges(rel, readFileSync(safeResolve(this.rt.paths.root, rel), 'utf8'), columns);
        } catch {
          return [];
        }
      });
      tx(this.db, () => {
        this.st.deleteLinks.run(JSON.stringify(batch), LINK_CONFIDENCE);
        for (const e of edges) this.st.insertEdge.run(e.src, e.rel, e.dst, e.path, e.line, e.confidence);
      });
    }
  }
}

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/** `file:<rel> REFERENCES column:t.c` for the first occurrence of each identifier naming a known column. */
function linkEdges(rel: string, text: string, columns: ColumnIndex): GraphEdge[] {
  if (columns.size === 0) return [];
  const firstAt = new Map<string, number>();
  const seen = new Set<string>();
  for (const m of text.matchAll(IDENTIFIER_RE)) {
    const raw = m[0];
    if (raw.length < LINK_MIN_LENGTH || seen.has(raw)) continue;
    seen.add(raw);
    const token = /[A-Z]/.test(raw) ? snakeCase(raw) : raw;
    if (columns.has(token) && !firstAt.has(token)) {
      firstAt.set(token, m.index);
      if (firstAt.size >= LINK_MAX_PER_FILE) break;
    }
  }
  if (firstAt.size === 0) return [];
  const starts = lineIndex(text);
  const edges: GraphEdge[] = [];
  for (const [token, offset] of [...firstAt].sort((a, b) => a[1] - b[1])) {
    for (const dst of columns.get(token)!) {
      edges.push({ src: `file:${rel}`, rel: 'REFERENCES', dst, path: rel, line: lineAt(starts, offset), confidence: LINK_CONFIDENCE });
    }
  }
  return edges;
}

/** `customerId` / `CustomerID` / `CUSTOMER_ID` → `customer_id`. */
export function snakeCase(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}
