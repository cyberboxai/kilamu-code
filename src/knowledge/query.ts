import { KilamuError } from '../core/errors.ts';
import type { GraphEdge, KnowledgeQuery, NodeRef, SearchHit, SymbolRecord } from '../core/types.ts';
import type { Db } from '../persistence/db.ts';
import { NO_PARSER, PDF_PARSER, TEXT_PARSER } from './extractors/index.ts';
import { detectLanguage } from './languages.ts';
import { LAYER_ORDER, classifyLayer, type Layer } from './layers.ts';

/**
 * Read-only query surface over the knowledge tables: FTS search, symbol
 * lookup, graph neighbourhoods, impact analysis, coverage and stats.
 * All user input reaches SQLite as bound parameters; FTS input is
 * tokenized and re-quoted so it can never inject MATCH syntax.
 */
export interface ImpactEntry {
  path: string;
  line: number;
  layer: Layer;
  /** Edges from the seed to the affected file, as "src -REL-> dst" (or an evidence note). */
  via: string[];
  confidence: number;
}

export interface ImpactReport {
  term: string;
  seeds: NodeRef[];
  layers: Array<{ layer: Layer; entries: ImpactEntry[] }>;
  total: number;
  truncated: boolean;
}

export type CoverageConfidence = 'structural-heuristic' | 'text-only' | 'unsupported';

export interface CoverageRow {
  language: string;
  files: number;
  parser: string;
  parserVersion: number;
  confidence: CoverageConfidence;
}

export interface KnowledgeStats {
  files: number;
  indexed: number;
  skipped: number;
  errors: number;
  symbols: number;
  edges: number;
  chunks: number;
  byLanguage: Record<string, number>;
  lastIndexedAt: string | null;
}

/** Confidence of a file found only by full-text evidence. */
export const FTS_EVIDENCE_CONFIDENCE = 0.2;
const MAX_FTS_TOKENS = 16;
const MAX_EDGES_PER_NODE = 500;
const MAX_FRONTIER = 500;
const SYMBOL_SEED_FILE_CONFIDENCE = 0.8;

interface EdgeRow {
  src: string;
  rel: string;
  dst: string;
  path: string;
  line: number;
  confidence: number;
}

interface SymbolRow {
  path: string;
  name: string;
  kind: SymbolRecord['kind'];
  line_start: number;
  line_end: number;
  signature: string;
  exported: number;
}

const clampInt = (v: number | undefined, def: number, min: number, max: number): number => {
  const n = Number.isFinite(v) ? Math.trunc(v as number) : def;
  return Math.min(max, Math.max(min, n));
};

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Turn arbitrary user text into FTS5 phrase tokens: words only, each quoted
 * with internal quotes doubled. Operators, column filters and `*` cannot survive.
 */
export function ftsPhrases(query: string): string[] {
  return queryWords(query).map((w) => `"${w.replaceAll('"', '""')}"`);
}

/** English function words that carry no retrieval signal in natural-language queries. */
const STOPWORDS = new Set(('a an and are as at be by can could do does did for from has have how i if in into is it its me my of on or our should so that the their them then there these this those to was we were what when where which who why will with would you your ' +
  'work works working use used using get make find show explain about').split(' '));

/** Query words with stopwords removed (kept verbatim when the query is only stopwords). */
export function queryWords(query: string): string[] {
  const words = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? [])];
  const content = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  return (content.length ? content : words).slice(0, MAX_FTS_TOKENS);
}

const PROSE_FILE = /\.(md|mdx|markdown|txt|rst)$/i;

/**
 * Rerank bm25 hits (the path column is indexed with weight 3): chunks whose path names a query term (e.g. "verification"
 * → src/verification/engine.ts) are boosted, prose is mildly down-weighted so
 * engineering questions surface code first. Deterministic.
 */
function rerank(rows: Array<{ path: string; line_start: number; rank: number }>, words: string[]): Map<string, number> {
  const terms = words.map((w) => w.toLowerCase()).filter((w) => w.length >= 3);
  const out = new Map<string, number>();
  for (const r of rows) {
    const p = r.path.toLowerCase();
    const pathHits = terms.filter((t) => p.includes(t) || (t.length > 5 && p.includes(t.slice(0, -1)))).length;
    const base = -Number(r.rank);
    out.set(`${r.path}:${r.line_start}`, base * (1 + 0.5 * pathHits) * (PROSE_FILE.test(r.path) ? 0.75 : 1));
  }
  return out;
}

const toEdge = (r: EdgeRow): GraphEdge => ({ src: r.src, rel: r.rel as GraphEdge['rel'], dst: r.dst, path: r.path, line: Number(r.line), confidence: Number(r.confidence) });

const toSymbol = (r: SymbolRow): SymbolRecord => ({
  path: r.path, name: r.name, kind: r.kind, lineStart: Number(r.line_start), lineEnd: Number(r.line_end), signature: r.signature, exported: Number(r.exported) === 1,
});

const EDGE_COLS = 'src, rel, dst, path, line, confidence';
const EDGE_ORDER = 'ORDER BY confidence DESC, path, line, src, rel, dst';

export class KnowledgeGraph implements KnowledgeQuery {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  search(query: string, limit = 20): SearchHit[] {
    const words = queryWords(query);
    const phrases = ftsPhrases(query);
    if (phrases.length === 0) return [];
    const lim = clampInt(limit, 20, 1, 200);
    const stmt = this.db.prepare(`SELECT path, line_start, line_end, snippet(chunks_fts, 3, '«', '»', '…', 16) AS snippet, bm25(chunks_fts, 3.0, 0, 0, 1.0) AS rank
      FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank, path, line_start LIMIT ?`);
    // OR + bm25: chunks matching more (and rarer) terms rank higher, without
    // the all-terms requirement that makes long natural-language queries brittle.
    const rows = stmt.all(phrases.join(' OR '), lim * 4) as Array<{ path: string; line_start: number; line_end: number; snippet: string; rank: number }>;
    const scores = rerank(rows, words);
    const key = (r: { path: string; line_start: number }) => `${r.path}:${r.line_start}`;
    rows.sort((a, b) => (scores.get(key(b))! - scores.get(key(a))!) || a.path.localeCompare(b.path) || Number(a.line_start) - Number(b.line_start));
    return rows.slice(0, lim).map((r) => ({ path: r.path, lineStart: Number(r.line_start), lineEnd: Number(r.line_end), snippet: r.snippet, score: scores.get(key(r))! }));
  }

  /** Exact (case-insensitive) name, or a qualified name ending in `.name` (methods, columns). */
  findSymbols(name: string, limit = 20): SymbolRecord[] {
    const n = name.trim();
    if (!n) return [];
    const rows = this.db.prepare(`SELECT path, name, kind, line_start, line_end, signature, exported FROM symbols
      WHERE name = ? COLLATE NOCASE OR name LIKE ? ESCAPE '\\'
      ORDER BY (name = ? COLLATE NOCASE) DESC, exported DESC, path, line_start LIMIT ?`).all(n, `%.${escapeLike(n)}`, n, clampInt(limit, 20, 1, 500)) as unknown as SymbolRow[];
    return rows.map(toSymbol);
  }

  neighbors(ref: NodeRef, direction: 'in' | 'out' | 'both', limit = 50): GraphEdge[] {
    const lim = clampInt(limit, 50, 1, 1000);
    const where = direction === 'out' ? 'src = ?' : direction === 'in' ? 'dst = ?' : 'src = ? OR dst = ?';
    const args = direction === 'both' ? [ref, ref] : [ref];
    const rows = this.db.prepare(`SELECT ${EDGE_COLS} FROM edges WHERE ${where} ${EDGE_ORDER} LIMIT ?`).all(...args, lim) as unknown as EdgeRow[];
    return rows.map(toEdge);
  }

  fileInfo(path: string): { path: string; sha256: string; size: number; language: string } | null {
    const r = this.db.prepare('SELECT path, sha256, size, language FROM files WHERE path = ?').get(path) as { path: string; sha256: string; size: number; language: string } | undefined;
    return r ? { path: r.path, sha256: r.sha256, size: Number(r.size), language: r.language } : null;
  }

  // -------------------------------------------------------------------------
  // Impact analysis
  // -------------------------------------------------------------------------

  impact(term: string, opts: { depth?: number; limit?: number } = {}): ImpactReport {
    const t = term.trim();
    if (!t) throw new KilamuError('INVALID_INPUT', 'impact: term must be a non-empty string');
    const depth = clampInt(opts.depth, 3, 1, 6);
    const limit = clampInt(opts.limit, 100, 1, 1000);
    const best = new Map<string, Omit<ImpactEntry, 'layer'>>();
    const consider = (path: string, line: number, via: string[], confidence: number) => {
      const cur = best.get(path);
      if (!cur || isBetter(confidence, via, line, cur)) best.set(path, { path, line, via, confidence });
    };

    const { seeds, frontier } = this.resolveSeeds(t, consider);
    this.traverse(frontier, depth, consider);
    for (const hit of this.search(t, 50)) {
      if (!best.has(hit.path)) consider(hit.path, hit.lineStart, [`fts:${JSON.stringify(t)}`], FTS_EVIDENCE_CONFIDENCE);
    }

    const all = [...best.values()].sort((a, b) => b.confidence - a.confidence || cmp(a.path, b.path));
    const kept = all.slice(0, limit);
    const langOf = this.db.prepare('SELECT language FROM files WHERE path = ?');
    const grouped = new Map<Layer, ImpactEntry[]>();
    for (const e of kept) {
      const lang = (langOf.get(e.path) as { language: string } | undefined)?.language ?? detectLanguage(e.path);
      const layer = classifyLayer(e.path, lang);
      const list = grouped.get(layer) ?? [];
      list.push({ ...e, layer, confidence: round(e.confidence) });
      grouped.set(layer, list);
    }
    const layers = LAYER_ORDER.filter((l) => grouped.has(l)).map((layer) => ({ layer, entries: grouped.get(layer)! }));
    return { term: t, seeds, layers, total: all.length, truncated: all.length > kept.length };
  }

  private resolveSeeds(term: string, consider: (path: string, line: number, via: string[], c: number) => void): { seeds: NodeRef[]; frontier: Map<NodeRef, Frontier> } {
    const lower = term.toLowerCase();
    const seeds = new Set<NodeRef>();
    const frontier = new Map<NodeRef, Frontier>();
    const add = (ref: NodeRef, confidence = 1) => {
      seeds.add(ref);
      if ((frontier.get(ref)?.confidence ?? -1) < confidence) frontier.set(ref, { confidence, via: [] });
    };
    const colLike = `column:%.${escapeLike(lower)}`;
    const colRows = this.db.prepare(`SELECT DISTINCT ref FROM (
        SELECT 'column:' || name AS ref FROM symbols WHERE kind = 'column' AND (name = ? OR name LIKE ? ESCAPE '\\')
        UNION SELECT dst FROM edges WHERE dst = ? OR dst LIKE ? ESCAPE '\\'
        UNION SELECT src FROM edges WHERE src = ? OR src LIKE ? ESCAPE '\\') ORDER BY ref`)
      .all(lower, `%.${escapeLike(lower)}`, `column:${lower}`, colLike, `column:${lower}`, colLike) as Array<{ ref: string }>;
    for (const r of colRows) add(r.ref);
    const table = `table:${lower}`;
    if (this.db.prepare('SELECT 1 FROM edges WHERE src = ? OR dst = ? LIMIT 1').get(table, table)) add(table);
    for (const ref of [`module:${term}`, `endpoint:${term}`]) {
      if (this.db.prepare('SELECT 1 FROM edges WHERE dst = ? LIMIT 1').get(ref)) add(ref);
    }
    const syms = this.db.prepare("SELECT path, name, line_start FROM symbols WHERE name = ? COLLATE NOCASE AND kind != 'column' ORDER BY path, line_start LIMIT 50")
      .all(term) as Array<{ path: string; name: string; line_start: number }>;
    for (const s of syms) {
      add(`symbol:${s.path}#${s.name}`);
      add(`file:${s.path}`, SYMBOL_SEED_FILE_CONFIDENCE);
      consider(s.path, Number(s.line_start), [`seed:symbol:${s.path}#${s.name}`], 1);
    }
    const files = this.db.prepare("SELECT path FROM files WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY path LIMIT 20")
      .all(term, `%/${escapeLike(term)}`) as Array<{ path: string }>;
    for (const f of files) {
      add(`file:${f.path}`);
      consider(f.path, 1, [`seed:file:${f.path}`], 1);
    }
    return { seeds: [...seeds].sort(), frontier };
  }

  /**
   * Bounded BFS. Reverse edges (who points at the node) carry impact; the only
   * forward step is a column's own foreign key, since its target is affected too.
   * Each traversed edge also pulls in its observing file, so importers follow.
   */
  private traverse(start: Map<NodeRef, Frontier>, depth: number, consider: (path: string, line: number, via: string[], c: number) => void): void {
    const reverse = this.db.prepare(`SELECT ${EDGE_COLS} FROM edges WHERE dst = ? ${EDGE_ORDER} LIMIT ${MAX_EDGES_PER_NODE}`);
    const forwardFk = this.db.prepare(`SELECT ${EDGE_COLS} FROM edges WHERE src = ? AND rel = 'REFERENCES' ${EDGE_ORDER} LIMIT ${MAX_EDGES_PER_NODE}`);
    const visited = new Map<NodeRef, number>();
    for (const [n, f] of start) visited.set(n, f.confidence);
    let frontier = start;
    for (let d = 0; d < depth && frontier.size > 0; d++) {
      const next = new Map<NodeRef, Frontier>();
      const ordered = [...frontier].sort((a, b) => b[1].confidence - a[1].confidence || cmp(a[0], b[0])).slice(0, MAX_FRONTIER);
      for (const [node, item] of ordered) {
        const edges = reverse.all(node) as unknown as EdgeRow[];
        if (node.startsWith('column:')) edges.push(...(forwardFk.all(node) as unknown as EdgeRow[]));
        for (const e of edges) {
          const confidence = item.confidence * Number(e.confidence);
          const via = [...item.via, `${e.src} -${e.rel}-> ${e.dst}`];
          consider(e.path, Number(e.line), via, confidence);
          for (const reached of [e.dst === node ? e.src : e.dst, `file:${e.path}`]) {
            if ((visited.get(reached) ?? -1) >= confidence) continue;
            visited.set(reached, confidence);
            next.set(reached, { confidence, via });
          }
        }
      }
      frontier = next;
    }
  }

  // -------------------------------------------------------------------------
  // Coverage & stats
  // -------------------------------------------------------------------------

  coverage(): CoverageRow[] {
    const rows = this.db.prepare(`SELECT language, parser, parser_version, status, COUNT(*) AS n FROM files
      GROUP BY language, parser, parser_version, status ORDER BY language, parser, parser_version`).all() as Array<{ language: string; parser: string; parser_version: number; status: string; n: number }>;
    const out = new Map<string, CoverageRow>();
    for (const r of rows) {
      const confidence = coverageConfidence(r.parser, r.status);
      const key = `${r.language}\0${r.parser}\0${r.parser_version}\0${confidence}`;
      const row = out.get(key) ?? { language: r.language, files: 0, parser: r.parser, parserVersion: Number(r.parser_version), confidence };
      row.files += Number(r.n);
      out.set(key, row);
    }
    return [...out.values()];
  }

  stats(): KnowledgeStats {
    const count = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    const byStatus = this.db.prepare('SELECT status, COUNT(*) AS n FROM files GROUP BY status').all() as Array<{ status: string; n: number }>;
    const status = (s: string) => Number(byStatus.find((r) => r.status === s)?.n ?? 0);
    const langs = this.db.prepare('SELECT language, COUNT(*) AS n FROM files GROUP BY language ORDER BY language').all() as Array<{ language: string; n: number }>;
    const last = this.db.prepare('SELECT MAX(indexed_at) AS at FROM files').get() as { at: string | null };
    return {
      files: count('SELECT COUNT(*) AS n FROM files'),
      indexed: status('INDEXED'),
      skipped: status('SKIPPED'),
      errors: status('ERROR'),
      symbols: count('SELECT COUNT(*) AS n FROM symbols'),
      edges: count('SELECT COUNT(*) AS n FROM edges'),
      chunks: count('SELECT COUNT(*) AS n FROM chunks_fts'),
      byLanguage: Object.fromEntries(langs.map((l) => [l.language, Number(l.n)])),
      lastIndexedAt: last.at ?? null,
    };
  }
}

interface Frontier {
  confidence: number;
  via: string[];
}

function coverageConfidence(parser: string, status: string): CoverageConfidence {
  if (status === 'SKIPPED' || parser === NO_PARSER.name) return 'unsupported';
  if (parser === TEXT_PARSER.name || parser === PDF_PARSER.name) return 'text-only';
  return 'structural-heuristic';
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const round = (n: number): number => Math.round(n * 10_000) / 10_000;

/** Deterministic preference: higher confidence, then shorter chain, then earlier line, then chain text. */
function isBetter(confidence: number, via: string[], line: number, cur: Omit<ImpactEntry, 'layer'>): boolean {
  if (confidence !== cur.confidence) return confidence > cur.confidence;
  if (via.length !== cur.via.length) return via.length < cur.via.length;
  if (line !== cur.line) return line < cur.line;
  return cmp(via.join('|'), cur.via.join('|')) < 0;
}
