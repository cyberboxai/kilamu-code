import { posix } from 'node:path';
import type { EdgeRelation, GraphEdge, NodeRef, SymbolRecord } from '../../core/types.ts';

/**
 * Shared helpers for the regex/line-scanner extractors. Everything here is
 * pure. Extractors never touch the filesystem; import resolution goes through
 * the optional `ExtractContext.fileExists` supplied by the indexer.
 */
export interface ExtractResult {
  symbols: SymbolRecord[];
  edges: GraphEdge[];
}

export interface ExtractContext {
  /** True if `rel` (POSIX, project-relative) is a known project file. */
  fileExists?: (rel: string) => boolean;
}

export interface Extractor {
  /** Stored in files.parser. */
  name: string;
  /** Stored in files.parser_version; bump to force a reindex. */
  version: number;
  extract(rel: string, text: string, ctx?: ExtractContext): ExtractResult;
}

/** Confidence levels. All heuristic: strictly below 1. */
export const CONF = {
  definition: 0.9,
  resolvedImport: 0.9,
  moduleImport: 0.8,
  inheritanceLocal: 0.85,
  inheritanceUnresolved: 0.6,
  endpoint: 0.8,
  schema: 0.95,
  foreignKey: 0.9,
  view: 0.7,
  orm: 0.6,
  docLink: 0.8,
  config: 0.9,
} as const;

export const fileRef = (rel: string): NodeRef => `file:${rel}`;
export const symbolRef = (rel: string, name: string): NodeRef => `symbol:${rel}#${name}`;
/** Base type whose defining file is unknown. */
export const unresolvedSymbolRef = (name: string): NodeRef => `symbol:?#${name}`;

export class ResultBuilder {
  readonly symbols: SymbolRecord[] = [];
  readonly edges: GraphEdge[] = [];
  readonly rel: string;
  constructor(rel: string) {
    this.rel = rel;
  }

  symbol(name: string, kind: SymbolRecord['kind'], lineStart: number, lineEnd: number, signature: string, exported: boolean): void {
    this.symbols.push({ path: this.rel, name, kind, lineStart, lineEnd: Math.max(lineStart, lineEnd), signature: clip(signature), exported });
  }

  edge(src: NodeRef, rel: EdgeRelation, dst: NodeRef, line: number, confidence: number): void {
    this.edges.push({ src, rel, dst, path: this.rel, line, confidence });
  }

  result(): ExtractResult {
    return { symbols: this.symbols, edges: this.edges };
  }
}

export function clip(s: string, max = 200): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Offsets of each line start, for offset → 1-based line lookups. */
export function lineIndex(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Blank comments (and, in `skeleton`, string contents) in C-family source while
 * preserving offsets and newlines. Single/double-quoted strings end at a newline
 * so an unbalanced quote (e.g. a Rust lifetime) only desyncs one line.
 */
export function stripCLike(text: string, opts: { backtickStrings?: boolean; rustLifetimes?: boolean } = {}): { code: string; skeleton: string } {
  const code: string[] = [];
  const skel: string[] = [];
  const special = /[/'"`]/g;
  let copied = 0;
  let pos = 0;
  for (;;) {
    special.lastIndex = pos;
    const m = special.exec(text);
    if (!m) break;
    const at = m.index;
    const ch = text[at]!;
    const next = text[at + 1];
    let end: number;
    let isString = false;
    if (ch === '/' && next === '/') {
      end = text.indexOf('\n', at);
      if (end === -1) end = text.length;
    } else if (ch === '/' && next === '*') {
      const close = text.indexOf('*/', at + 2);
      end = close === -1 ? text.length : close + 2;
    } else if (ch === "'" && opts.rustLifetimes && /[A-Za-z_]/.test(next ?? '') && text[at + 2] !== "'") {
      pos = at + 1; // Rust lifetime (`'a`, `'_`), not a char literal.
      continue;
    } else if (ch === '"' || ch === "'" || (ch === '`' && opts.backtickStrings)) {
      end = stringEnd(text, at, ch);
      isString = true;
    } else {
      pos = at + 1;
      continue;
    }
    const before = text.slice(copied, at);
    const region = text.slice(at, end);
    code.push(before, isString ? region : blankOut(region));
    skel.push(before, isString ? blankStringBody(region, ch) : blankOut(region));
    copied = pos = end;
  }
  const rest = text.slice(copied);
  code.push(rest);
  skel.push(rest);
  return { code: code.join(''), skeleton: skel.join('') };
}

/** Exclusive end of the string literal opening at `start`; '/"-strings stop at a newline. */
function stringEnd(text: string, start: number, quote: string): number {
  for (let j = start + 1; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (c === 92) j++; // backslash escape
    else if (text[j] === quote) return j + 1;
    else if (c === 10 && quote !== '`') return j;
  }
  return text.length;
}

/** Replace every character except newlines with a space (offsets preserved). */
export function blankOut(s: string): string {
  // Much faster than a per-character regex replace on hot paths.
  if (!s.includes('\n')) return ' '.repeat(s.length);
  return s.split('\n').map((part) => ' '.repeat(part.length)).join('\n');
}

function blankStringBody(region: string, quote: string): string {
  const closed = region.length >= 2 && region.endsWith(quote);
  return closed ? `${quote}${blankOut(region.slice(1, -1))}${quote}` : `${quote}${blankOut(region.slice(1))}`;
}

const OPEN = 123; // {
const CLOSE = 125; // }
const SEMI = 59; // ;

/** Net `{`/`}` depth before each line (index 0 = line 1) computed on a skeleton. */
export function braceDepths(skeletonLines: string[]): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const line of skeletonLines) {
    depths.push(depth);
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c === OPEN) depth++;
      else if (c === CLOSE && depth > 0) depth--;
    }
  }
  return depths;
}

/** 1-based end line of a brace block opened on or after `lineIdx` (0-based). */
export function blockEnd(skeletonLines: string[], lineIdx: number, maxScan = 5000): number {
  let depth = 0;
  let opened = false;
  const limit = Math.min(skeletonLines.length, lineIdx + maxScan);
  for (let i = lineIdx; i < limit; i++) {
    const line = skeletonLines[i]!;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c === OPEN) {
        depth++;
        opened = true;
      } else if (c === CLOSE) {
        depth--;
        if (opened && depth <= 0) return i + 1;
      } else if (c === SEMI && !opened) {
        return i + 1;
      }
    }
  }
  return opened ? limit : lineIdx + 1;
}

/** Normalize `base/../x` style paths; null if the result escapes the root. */
export function joinRel(dir: string, spec: string): string | null {
  const joined = posix.normalize(posix.join(dir, spec));
  if (joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) return null;
  return joined === '.' ? '' : joined;
}

export function firstExisting(candidates: string[], ctx: ExtractContext | undefined): string | null {
  if (!ctx?.fileExists) return null;
  for (const c of candidates) if (c && ctx.fileExists(c)) return c;
  return null;
}

/** A local name introduced by an import: the file it resolves to and the exported name ('*' for namespaces). */
export interface ImportBinding {
  file: string;
  name: string;
}

/** EXTENDS/IMPLEMENTS target: a local type, an imported file's type, or unresolved. */
export function typeTarget(name: string, rel: string, local: ReadonlySet<string>, importedFrom: ReadonlyMap<string, ImportBinding>): { ref: NodeRef; confidence: number } {
  const bare = name.replace(/<.*$/, '').trim();
  const parts = bare.split(/[.:]+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? bare;
  if (parts.length === 1 && local.has(last)) return { ref: symbolRef(rel, last), confidence: CONF.inheritanceLocal };
  const binding = importedFrom.get(parts[0] ?? bare);
  if (binding) {
    const exported = parts.length > 1 || binding.name === '*' || binding.name === 'default' ? last : binding.name;
    return { ref: symbolRef(binding.file, exported), confidence: CONF.inheritanceLocal };
  }
  if (local.has(last)) return { ref: symbolRef(rel, last), confidence: CONF.inheritanceLocal };
  return { ref: unresolvedSymbolRef(last), confidence: CONF.inheritanceUnresolved };
}

/** Split a comma list at top level (ignores commas nested in <>, (), []). */
export function splitTopLevel(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
