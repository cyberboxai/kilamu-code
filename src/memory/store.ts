import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { KilamuError } from '../core/errors.ts';
import { newId, nowIso, sha256 } from '../core/ids.ts';
import type { Logger } from '../core/log.ts';
import { isSensitivePath, safeResolve, toRel } from '../core/paths.ts';
import { containsSecret, redact } from '../core/redact.ts';
import type { MemoryCategory, MemoryItem, MemorySourceRef, MemoryValidation } from '../core/types.ts';
import { parseJson, tx, type Db } from '../persistence/db.ts';
import type { Runtime } from '../runtime.ts';

/**
 * Durable engineering memory (directive §11). Every item is evidence-backed,
 * tied to source file hashes so it goes STALE when the code it describes
 * changes, and secret-free. Reusable patterns require verification.
 */

export const CATEGORIES: readonly MemoryCategory[] = ['project', 'execution', 'pattern', 'technical'];
export const VALIDATIONS: readonly MemoryValidation[] = ['UNVERIFIED', 'VERIFIED', 'STALE', 'INVALIDATED'];

const LIMITS = {
  scope: 200,
  description: 500,
  text: 4000,
  listEntry: 500,
  evidence: 50,
  conditions: 30,
  sources: 50,
  queryLimit: 200,
};
const ID_PATTERN = /^m_[0-9a-z]{9,40}$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const VERIFIED_MIN_CONFIDENCE = 0.7;
const MIN_PROMOTION_EVIDENCE = 2;
const DEFAULT_CONFIDENCE = 0.5;

export interface MemorySourceInput {
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface MemoryInput {
  category: MemoryCategory;
  scope: string;
  description: string;
  problem: string;
  solution: string;
  evidence?: string[];
  sources?: MemorySourceInput[];
  confidence?: number;
  invalidationConditions?: string[];
}

export interface MemoryListFilter {
  category?: MemoryCategory;
  validation?: MemoryValidation;
  scope?: string;
  limit?: number;
}

interface MemoryRow {
  id: string;
  category: string;
  scope: string;
  description: string;
  problem: string;
  solution: string;
  evidence_json: string;
  sources_json: string;
  confidence: number;
  validation: string;
  invalidation_json: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function invalid(message: string, details: Record<string, unknown> = {}): KilamuError {
  return new KilamuError('MEMORY_INVALID', message, details);
}

function checkText(field: string, value: unknown, max: number, required = true): string {
  if (typeof value !== 'string') throw invalid(`${field} must be a string`, { field });
  const v = value.trim();
  if (required && v === '') throw invalid(`${field} is required`, { field });
  if (v.length > max) throw invalid(`${field} exceeds ${max} characters (store a summary, not a transcript)`, { field, max });
  if (containsSecret(v)) throw new KilamuError('SECRET_DETECTED', `${field} appears to contain a secret; memory refuses to store it`, { field });
  return v;
}

function checkList(field: string, value: unknown, maxItems: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`${field} must be an array`, { field });
  if (value.length > maxItems) throw invalid(`${field} exceeds ${maxItems} entries`, { field });
  const out = value.map((v, i) => checkText(`${field}[${i}]`, v, LIMITS.listEntry));
  return [...new Set(out)];
}

function checkConfidence(value: unknown): number {
  if (value === undefined) return DEFAULT_CONFIDENCE;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalid('confidence must be a number within 0..1');
  }
  return value;
}

function checkCategory(value: unknown): MemoryCategory {
  if (!CATEGORIES.includes(value as MemoryCategory)) throw invalid(`category must be one of ${CATEGORIES.join(', ')}`);
  return value as MemoryCategory;
}

function checkLine(field: string, value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw invalid(`${field} must be a positive integer`);
  return value as number;
}

function hashFile(abs: string): string | null {
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  return sha256(readFileSync(abs));
}

/** Atomic, owner-only write. */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function toItem(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    category: row.category as MemoryCategory,
    scope: row.scope,
    description: row.description,
    problem: row.problem,
    solution: row.solution,
    evidence: parseJson<string[]>(row.evidence_json, []),
    sources: parseJson<MemorySourceRef[]>(row.sources_json, []),
    confidence: row.confidence,
    validation: row.validation as MemoryValidation,
    invalidationConditions: parseJson<string[]>(row.invalidation_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Escape LIKE wildcards; used with `ESCAPE '\'`. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function queryTerms(text: string): string[] {
  const terms = text.toLowerCase().match(/[\p{L}\p{N}_$.-]{3,}/gu) ?? [];
  return [...new Set(terms)].slice(0, 12);
}

function clampLimit(limit: number | undefined, fallback: number): number {
  return Math.min(Math.max(1, Math.floor(limit ?? fallback)), LIMITS.queryLimit);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class MemoryStore {
  private readonly db: Db;
  private readonly root: string;
  private readonly memoryDir: string;
  private readonly promotionConfidence: number;
  private readonly log: Logger;

  constructor(rt: Runtime) {
    this.db = rt.db;
    this.root = rt.paths.root;
    this.memoryDir = rt.paths.memoryDir;
    this.promotionConfidence = rt.config.memory.promotionConfidence;
    this.log = rt.log;
  }

  // -- source handling ------------------------------------------------------

  /** Validate a source path and hash its current content (null when absent). */
  private resolveSource(src: MemorySourceInput, idx: number): MemorySourceRef {
    if (!src || typeof src.path !== 'string' || src.path.trim() === '') throw invalid(`sources[${idx}].path is required`);
    let abs: string;
    try {
      abs = safeResolve(this.root, src.path);
    } catch (e) {
      throw new KilamuError('UNSAFE_PATH', `sources[${idx}] escapes the project root: ${src.path}`, { cause: (e as Error).message });
    }
    const rel = toRel(this.root, abs);
    if (rel === '') throw invalid(`sources[${idx}] must be a file, not the project root`);
    if (isSensitivePath(rel)) throw new KilamuError('SENSITIVE_PATH', `sources[${idx}] is a sensitive path and cannot back a memory: ${rel}`);
    const lineStart = checkLine(`sources[${idx}].lineStart`, src.lineStart);
    const lineEnd = checkLine(`sources[${idx}].lineEnd`, src.lineEnd);
    if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) throw invalid(`sources[${idx}].lineEnd < lineStart`);
    return {
      path: rel,
      sha256: hashFile(abs),
      ...(lineStart !== undefined ? { lineStart } : {}),
      ...(lineEnd !== undefined ? { lineEnd } : {}),
    };
  }

  /** Reasons the item's sources no longer match what the memory was built on. */
  private staleReasons(item: MemoryItem): string[] {
    const reasons: string[] = [];
    for (const s of item.sources) {
      let current: string | null;
      try {
        const abs = safeResolve(this.root, s.path);
        current = isSensitivePath(toRel(this.root, abs)) ? null : hashFile(abs);
      } catch {
        current = null;
      }
      if (current === s.sha256) continue;
      if (current === null) reasons.push(`source ${s.path} is missing`);
      else if (s.sha256 === null) reasons.push(`source ${s.path} appeared after the memory was recorded`);
      else reasons.push(`source ${s.path} changed (sha256 ${s.sha256.slice(0, 12)} → ${current.slice(0, 12)})`);
    }
    return reasons;
  }

  // -- shared checks --------------------------------------------------------

  private normalize(input: MemoryInput): Omit<MemoryItem, 'id' | 'validation' | 'createdAt' | 'updatedAt'> {
    if (!input || typeof input !== 'object') throw invalid('memory input must be an object');
    const category = checkCategory(input.category);
    const evidence = checkList('evidence', input.evidence, LIMITS.evidence);
    const confidence = checkConfidence(input.confidence);
    const sourcesIn = input.sources ?? [];
    if (!Array.isArray(sourcesIn) || sourcesIn.length > LIMITS.sources) throw invalid(`sources must be an array of at most ${LIMITS.sources}`);
    const item = {
      category,
      scope: checkText('scope', input.scope, LIMITS.scope),
      description: checkText('description', input.description, LIMITS.description),
      problem: checkText('problem', input.problem, LIMITS.text),
      solution: checkText('solution', input.solution, LIMITS.text),
      evidence,
      sources: sourcesIn.map((s, i) => this.resolveSource(s, i)),
      confidence,
      invalidationConditions: checkList('invalidationConditions', input.invalidationConditions, LIMITS.conditions),
    };
    if (category === 'pattern') this.assertPatternEligible(evidence.length, confidence, 1);
    return item;
  }

  private assertPatternEligible(evidenceCount: number, confidence: number, minEvidence: number, extra: string[] = []): void {
    const reasons = [...extra];
    if (evidenceCount < minEvidence) reasons.push(`needs at least ${minEvidence} evidence entr${minEvidence === 1 ? 'y' : 'ies'} (has ${evidenceCount})`);
    if (confidence < this.promotionConfidence) reasons.push(`confidence ${confidence} is below promotion threshold ${this.promotionConfidence}`);
    if (reasons.length) throw new KilamuError('PROMOTION_DENIED', `Pattern denied: ${reasons.join('; ')}`, { reasons });
  }

  private insert(item: MemoryItem): void {
    this.db
      .prepare(
        `INSERT INTO memory_items (id, category, scope, description, problem, solution, evidence_json, sources_json,
           confidence, validation, invalidation_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id, item.category, item.scope, item.description, item.problem, item.solution,
        JSON.stringify(item.evidence), JSON.stringify(item.sources), item.confidence, item.validation,
        JSON.stringify(item.invalidationConditions), item.createdAt, item.updatedAt,
      );
  }

  private save(item: MemoryItem): MemoryItem {
    const updated = { ...item, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE memory_items SET category = ?, evidence_json = ?, confidence = ?, validation = ?, invalidation_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(updated.category, JSON.stringify(updated.evidence), updated.confidence, updated.validation,
        JSON.stringify(updated.invalidationConditions), updated.updatedAt, updated.id);
    return updated;
  }

  private require(id: string): MemoryItem {
    const item = this.get(id);
    if (!item) throw new KilamuError('MEMORY_NOT_FOUND', `Memory item not found: ${String(id).slice(0, 60)}`);
    return item;
  }

  private markTriggered(item: MemoryItem, validation: 'STALE' | 'INVALIDATED', reason: string): MemoryItem {
    const note = `TRIGGERED ${nowIso()} [${validation}]: ${reason}`.slice(0, LIMITS.listEntry);
    const conditions = [...item.invalidationConditions, note].slice(-LIMITS.conditions);
    this.log.info(`memory.${validation.toLowerCase()}`, { id: item.id, reason });
    return this.save({ ...item, validation, invalidationConditions: conditions });
  }

  // -- public API -----------------------------------------------------------

  add(input: MemoryInput): MemoryItem {
    const now = nowIso();
    const item: MemoryItem = { id: newId('m'), ...this.normalize(input), validation: 'UNVERIFIED', createdAt: now, updatedAt: now };
    this.insert(item);
    return item;
  }

  get(id: string): MemoryItem | null {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
    const row = this.db.prepare('SELECT * FROM memory_items WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? toItem(row) : null;
  }

  list(filter: MemoryListFilter = {}): MemoryItem[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.category) { where.push('category = ?'); params.push(checkCategory(filter.category)); }
    if (filter.validation) {
      if (!VALIDATIONS.includes(filter.validation)) throw invalid('unknown validation state');
      where.push('validation = ?');
      params.push(filter.validation);
    }
    if (filter.scope) { where.push('scope = ?'); params.push(filter.scope); }
    const sql = `SELECT * FROM memory_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, id LIMIT ${clampLimit(filter.limit, 50)}`;
    return (this.db.prepare(sql).all(...params) as unknown as MemoryRow[]).map(toItem);
  }

  /** Every term must appear in description, problem or solution (case-insensitive LIKE). */
  search(text: string, limit = 20): MemoryItem[] {
    const terms = (typeof text === 'string' ? text.trim().split(/\s+/) : []).filter(Boolean).slice(0, 12);
    if (!terms.length) return [];
    const clause = "(description LIKE ? ESCAPE '\\' OR problem LIKE ? ESCAPE '\\' OR solution LIKE ? ESCAPE '\\')";
    const params = terms.flatMap((t) => { const p = likePattern(t); return [p, p, p]; });
    const sql = `SELECT * FROM memory_items WHERE ${terms.map(() => clause).join(' AND ')}
      ORDER BY CASE validation WHEN 'VERIFIED' THEN 0 WHEN 'UNVERIFIED' THEN 1 ELSE 2 END, confidence DESC, updated_at DESC, id
      LIMIT ${clampLimit(limit, 20)}`;
    return (this.db.prepare(sql).all(...params) as unknown as MemoryRow[]).map(toItem);
  }

  /** UNVERIFIED → VERIFIED (or add evidence to a VERIFIED item). */
  validate(id: string, evidence: string[]): MemoryItem {
    const added = checkList('evidence', evidence, LIMITS.evidence);
    if (!added.length) throw invalid('validation requires at least one evidence entry');
    const item = this.require(id);
    if (item.validation !== 'UNVERIFIED' && item.validation !== 'VERIFIED') {
      throw new KilamuError('MEMORY_STATE', `Cannot validate a ${item.validation} memory; record a new one instead`, { id });
    }
    const merged = [...new Set([...item.evidence, ...added])];
    if (merged.length > LIMITS.evidence) throw invalid(`evidence exceeds ${LIMITS.evidence} entries`);
    return this.save({ ...item, evidence: merged, validation: 'VERIFIED', confidence: Math.max(item.confidence, VERIFIED_MIN_CONFIDENCE) });
  }

  invalidate(id: string, reason: string): MemoryItem {
    const why = checkText('reason', reason, LIMITS.listEntry - 60);
    return this.markTriggered(this.require(id), 'INVALIDATED', why);
  }

  /** Recompute source hashes; any changed or missing source marks the item STALE. */
  checkStaleness(): { checked: number; stale: string[] } {
    const rows = this.db
      .prepare("SELECT * FROM memory_items WHERE validation IN ('UNVERIFIED','VERIFIED') ORDER BY id")
      .all() as unknown as MemoryRow[];
    const stale: string[] = [];
    let checked = 0;
    tx(this.db, () => {
      for (const item of rows.map(toItem)) {
        if (!item.sources.length) continue;
        checked++;
        const reasons = this.staleReasons(item);
        if (!reasons.length) continue;
        this.markTriggered(item, 'STALE', reasons.join('; '));
        stale.push(item.id);
      }
    });
    return { checked, stale };
  }

  /** execution|technical → pattern, only when verified, confident, evidenced and still fresh. */
  promote(id: string): MemoryItem {
    const item = this.require(id);
    const blockers: string[] = [];
    if (item.category !== 'execution' && item.category !== 'technical') blockers.push(`category ${item.category} cannot be promoted`);
    if (item.validation !== 'VERIFIED') blockers.push(`validation is ${item.validation}, must be VERIFIED`);
    const stale = this.staleReasons(item);
    if (stale.length) blockers.push(`sources changed: ${stale.join('; ')}`);
    this.assertPatternEligible(item.evidence.length, item.confidence, MIN_PROMOTION_EVIDENCE, blockers);
    return this.save({ ...item, category: 'pattern' });
  }

  /** Usable memories for a query: never STALE/INVALIDATED, VERIFIED first. */
  relevant(query: string, limit: number): MemoryItem[] {
    const terms = queryTerms(typeof query === 'string' ? query : '');
    const params = terms.flatMap((t) => { const p = likePattern(t); return [p, p, p, p]; });
    const match = terms.length
      ? `AND (${terms.map(() => "description LIKE ? ESCAPE '\\' OR problem LIKE ? ESCAPE '\\' OR solution LIKE ? ESCAPE '\\' OR scope LIKE ? ESCAPE '\\'").join(' OR ')})`
      : '';
    const rows = this.db
      .prepare(`SELECT * FROM memory_items WHERE validation IN ('VERIFIED','UNVERIFIED') ${match} ORDER BY id LIMIT 500`)
      .all(...params) as unknown as MemoryRow[];
    const scored = rows.map(toItem).map((m) => {
      const hay = `${m.scope}\n${m.description}\n${m.problem}\n${m.solution}`.toLowerCase();
      return { m, score: terms.filter((t) => hay.includes(t)).length };
    });
    scored.sort((a, b) =>
      (a.m.validation === 'VERIFIED' ? 0 : 1) - (b.m.validation === 'VERIFIED' ? 0 : 1)
      || b.score - a.score
      || b.m.confidence - a.m.confidence
      || (a.m.updatedAt < b.m.updatedAt ? 1 : a.m.updatedAt > b.m.updatedAt ? -1 : 0)
      || (a.m.id < b.m.id ? -1 : 1));
    return scored.slice(0, clampLimit(limit, 5)).map((s) => s.m);
  }

  /** One human-readable `<category>.md` per category. `dir` must stay inside the project. */
  exportMarkdown(dir?: string): string[] {
    const target = dir === undefined ? this.memoryDir : safeResolve(this.root, dir);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const items = this.exportJson();
    return CATEGORIES.map((cat) => {
      const file = join(target, `${cat}.md`);
      writeAtomic(file, renderCategory(cat, items.filter((i) => i.category === cat)));
      return file;
    });
  }

  exportJson(): MemoryItem[] {
    const rows = this.db.prepare('SELECT * FROM memory_items ORDER BY created_at, id').all() as unknown as MemoryRow[];
    return rows.map(toItem);
  }

  /**
   * Import exported items atomically. Every item is re-checked like `add`
   * (secrets, paths, lengths, pattern rule); ids are kept, duplicates rejected.
   * Items whose sources no longer match are imported as STALE.
   */
  importJson(items: unknown): { imported: string[]; stale: string[] } {
    if (!Array.isArray(items)) throw invalid('import payload must be an array of memory items');
    const prepared = items.map((raw, idx) => this.prepareImport(raw, idx));
    const ids = prepared.map((p) => p.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) throw new KilamuError('MEMORY_DUPLICATE', `Duplicate id in import payload: ${dup}`, { id: dup });
    const stale: string[] = [];
    tx(this.db, () => {
      for (const item of prepared) {
        if (this.get(item.id)) throw new KilamuError('MEMORY_DUPLICATE', `Memory item already exists: ${item.id}`, { id: item.id });
        const reasons = item.validation === 'INVALIDATED' ? [] : this.staleReasons(item);
        if (reasons.length) {
          item.validation = 'STALE';
          item.invalidationConditions = [...item.invalidationConditions, `TRIGGERED ${nowIso()} [STALE]: ${reasons.join('; ')}`.slice(0, LIMITS.listEntry)].slice(-LIMITS.conditions);
          stale.push(item.id);
        }
        this.insert(item);
      }
    });
    return { imported: ids, stale };
  }

  private prepareImport(raw: unknown, idx: number): MemoryItem {
    try {
      if (!raw || typeof raw !== 'object') throw invalid('item must be an object');
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== 'string' || !ID_PATTERN.test(r.id)) throw invalid('id is missing or malformed');
      const validation = r.validation;
      if (!VALIDATIONS.includes(validation as MemoryValidation)) throw invalid('validation is invalid');
      const base = this.normalize({
        category: r.category as MemoryCategory,
        scope: r.scope as string,
        description: r.description as string,
        problem: r.problem as string,
        solution: r.solution as string,
        evidence: r.evidence as string[],
        sources: r.sources as MemorySourceInput[],
        confidence: r.confidence as number,
        invalidationConditions: r.invalidationConditions as string[],
      });
      if (validation === 'VERIFIED' && base.evidence.length === 0) throw invalid('VERIFIED item has no evidence');
      // Keep the hashes the memory was built against so staleness is detected, not hidden.
      const rawSources = Array.isArray(r.sources) ? (r.sources as Array<Record<string, unknown>>) : [];
      const sources = base.sources.map((s, i) => {
        const recorded = rawSources[i]?.sha256;
        if (recorded !== null && recorded !== undefined && (typeof recorded !== 'string' || !SHA_PATTERN.test(recorded))) {
          throw invalid(`sources[${i}].sha256 is malformed`);
        }
        return { ...s, sha256: recorded === undefined ? s.sha256 : (recorded as string | null) };
      });
      const createdAt = typeof r.createdAt === 'string' && !Number.isNaN(Date.parse(r.createdAt)) ? r.createdAt : nowIso();
      const updatedAt = typeof r.updatedAt === 'string' && !Number.isNaN(Date.parse(r.updatedAt)) ? r.updatedAt : createdAt;
      return { ...base, sources, id: r.id, validation: validation as MemoryValidation, createdAt, updatedAt };
    } catch (e) {
      if (e instanceof KilamuError) throw new KilamuError(e.code, `import item ${idx}: ${e.message}`, { ...e.details, index: idx });
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

const VALIDATION_ORDER: Record<MemoryValidation, number> = { VERIFIED: 0, UNVERIFIED: 1, STALE: 2, INVALIDATED: 3 };

function renderSource(s: MemorySourceRef): string {
  const range = s.lineStart !== undefined ? `:${s.lineStart}${s.lineEnd !== undefined ? `-${s.lineEnd}` : ''}` : '';
  return `\`${s.path}${range}\` (sha256 ${s.sha256 ? s.sha256.slice(0, 12) : 'none'})`;
}

function renderItem(i: MemoryItem): string[] {
  const lines = [
    `## ${i.description}`,
    '',
    `- **id:** \`${i.id}\` · **status:** ${i.validation} · **confidence:** ${i.confidence} · **scope:** ${i.scope}`,
    `- **updated:** ${i.updatedAt}`,
    '',
    `**Problem.** ${i.problem}`,
    '',
    `**Solution.** ${i.solution}`,
  ];
  if (i.evidence.length) lines.push('', '**Evidence.**', ...i.evidence.map((e) => `- ${e}`));
  if (i.sources.length) lines.push('', '**Sources.**', ...i.sources.map((s) => `- ${renderSource(s)}`));
  if (i.invalidationConditions.length) lines.push('', '**Invalidation.**', ...i.invalidationConditions.map((c) => `- ${c}`));
  lines.push('');
  return lines;
}

function renderCategory(cat: MemoryCategory, items: MemoryItem[]): string {
  const sorted = [...items].sort((a, b) => VALIDATION_ORDER[a.validation] - VALIDATION_ORDER[b.validation] || (a.id < b.id ? -1 : 1));
  const body = sorted.length ? sorted.flatMap(renderItem) : ['_No entries._', ''];
  const doc = [
    `# Kilamu memory — ${cat}`,
    '',
    '> Generated by Kilamu Code from the memory store. Edits here are overwritten; use `kilamu memory` commands.',
    '',
    ...body,
  ].join('\n');
  return redact(doc).text;
}
