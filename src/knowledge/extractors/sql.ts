import { CONF, ResultBuilder, clip, fileRef, lineAt, lineIndex, splitTopLevel, symbolRef, type ExtractResult } from './common.ts';

/**
 * SQL DDL extractor: CREATE TABLE (columns, inline and table-level foreign
 * keys), ALTER TABLE (ADD/DROP/RENAME/ALTER COLUMN, ADD FOREIGN KEY),
 * CREATE INDEX, CREATE VIEW. Case-insensitive; identifiers are unquoted,
 * schema-stripped and lowercased so `"Public"."Customers"` → `customers`.
 */
export const PARSER_NAME = 'sql-regex';
export const PARSER_VERSION = 1;

const PART = '(?:[\\w$]+|"[^"]+"|`[^`]+`|\\[[^\\]]+\\])';
const IDENT = `(${PART}(?:\\s*\\.\\s*${PART})*)`;
const ONE = `(${PART})`;

const CREATE_TABLE_RE = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?(?:(?:global|local)\\s+)?(?:temporary\\s+|temp\\s+|unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${IDENT}\\s*\\(`, 'i');
const ALTER_TABLE_RE = new RegExp(`^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${IDENT}\\s+([\\s\\S]*)$`, 'i');
const CREATE_INDEX_RE = new RegExp(`^create\\s+(?:unique\\s+)?(?:clustered\\s+|nonclustered\\s+)?index\\s+(?:concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?(?:${IDENT}\\s+)?on\\s+(?:only\\s+)?${IDENT}\\s*(?:using\\s+\\w+\\s*)?\\(([^)]*)\\)`, 'i');
const CREATE_VIEW_RE = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?(?:temp(?:orary)?\\s+)?(?:materialized\\s+)?view\\s+(?:if\\s+not\\s+exists\\s+)?${IDENT}[\\s\\S]*?\\bas\\b([\\s\\S]*)$`, 'i');
const INLINE_REF_RE = new RegExp(`\\breferences\\s+${IDENT}\\s*(?:\\(\\s*${ONE}\\s*\\))?`, 'i');
const FK_RE = new RegExp(`foreign\\s+key\\s*\\(([^)]*)\\)\\s*references\\s+${IDENT}\\s*(?:\\(([^)]*)\\))?`, 'i');
const COLUMN_RE = new RegExp(`^${ONE}\\s+([\\s\\S]+)$`);
const CONSTRAINT_START = /^(constraint|primary|foreign|unique|check|index|key|exclude|like|fulltext|spatial|period)\b/i;
const FROM_JOIN_RE = new RegExp(`\\b(?:from|join)\\s+${IDENT}`, 'gi');

/** `"Public"."Customers"` → `customers`. */
export function normIdent(raw: string): string {
  const parts = raw.match(new RegExp(PART, 'g')) ?? [raw];
  return parts[parts.length - 1]!.replace(/^["`[]|["`\]]$/g, '').toLowerCase();
}

/** Blank `--` and `/* *\/` comments, preserving offsets. Quoted strings are kept. */
function stripSql(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') {
        out.push(' ');
        i++;
      }
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) out.push(text[i] === '\n' ? '\n' : ' ');
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length : end + 1;
      out.push(text.slice(i, stop));
      i = stop;
    } else {
      out.push(ch);
      i++;
    }
  }
  return out.join('');
}

interface Statement {
  text: string;
  offset: number;
}

function statements(code: string): Statement[] {
  const out: Statement[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i <= code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if ((ch === ';' && depth === 0) || ch === undefined) {
      const raw = code.slice(start, i);
      const lead = raw.length - raw.trimStart().length;
      if (raw.trim()) out.push({ text: raw.trim(), offset: start + lead });
      start = i + 1;
    }
  }
  return out;
}

/** Index of the `)` matching the `(` at `open`, or -1. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

const identList = (s: string) => splitTopLevel(s).map((x) => normIdent(x.trim().split(/\s+/)[0] ?? x));

class SqlBuilder {
  readonly b: ResultBuilder;
  readonly starts: number[];
  constructor(rel: string, code: string) {
    this.b = new ResultBuilder(rel);
    this.starts = lineIndex(code);
  }

  line(offset: number): number {
    return lineAt(this.starts, offset);
  }

  column(table: string, col: string, def: string, offset: number, migration: boolean): void {
    const ln = this.line(offset);
    const ref = `column:${table}.${col}`;
    this.b.symbol(`${table}.${col}`, 'column', ln, ln, `${table}.${col} ${def}`, true);
    this.b.edge(`table:${table}`, 'DEFINES', ref, ln, CONF.schema);
    if (migration) this.b.edge(fileRef(this.b.rel), 'MIGRATES_TO', ref, ln, CONF.schema);
    const fk = INLINE_REF_RE.exec(def);
    if (fk) this.foreignKey(table, [col], normIdent(fk[1]!), fk[2] ? [normIdent(fk[2])] : [], ln);
  }

  foreignKey(table: string, cols: string[], other: string, otherCols: string[], line: number): void {
    cols.forEach((c, k) => {
      const target = otherCols[k] ? `column:${other}.${otherCols[k]!}` : `table:${other}`;
      this.b.edge(`column:${table}.${c}`, 'REFERENCES', target, line, CONF.foreignKey);
    });
  }
}

export function extract(rel: string, text: string): ExtractResult {
  const code = stripSql(text);
  const sb = new SqlBuilder(rel, code);
  for (const st of statements(code)) {
    if (createTable(sb, st) || alterTable(sb, st) || createIndex(sb, st)) continue;
    createView(sb, st);
  }
  return sb.b.result();
}

function createTable(sb: SqlBuilder, st: Statement): boolean {
  const m = CREATE_TABLE_RE.exec(st.text);
  if (!m) return false;
  const table = normIdent(m[1]!);
  const open = m[0].length - 1;
  const close = matchParen(st.text, open);
  const startLine = sb.line(st.offset);
  const endLine = sb.line(st.offset + (close === -1 ? st.text.length : close));
  sb.b.symbol(table, 'table', startLine, endLine, `CREATE TABLE ${table}`, true);
  sb.b.edge(fileRef(sb.b.rel), 'DEFINES', `table:${table}`, startLine, CONF.schema);
  const body = st.text.slice(open + 1, close === -1 ? undefined : close);
  let cursor = 0;
  for (const item of splitTopLevel(body)) {
    const at = body.indexOf(item, cursor);
    cursor = at === -1 ? cursor : at + item.length;
    const offset = st.offset + open + 1 + Math.max(0, at);
    if (CONSTRAINT_START.test(item)) {
      const fk = FK_RE.exec(item);
      if (fk) sb.foreignKey(table, identList(fk[1]!), normIdent(fk[2]!), fk[3] ? identList(fk[3]) : [], sb.line(offset));
      continue;
    }
    const col = COLUMN_RE.exec(item);
    if (col) sb.column(table, normIdent(col[1]!), clip(col[2]!, 120), offset, false);
  }
  return true;
}

function alterTable(sb: SqlBuilder, st: Statement): boolean {
  const m = ALTER_TABLE_RE.exec(st.text);
  if (!m) return false;
  const table = normIdent(m[1]!);
  const actionsAt = st.text.length - m[2]!.length;
  let cursor = 0;
  for (const clause of splitTopLevel(m[2]!)) {
    const at = m[2]!.indexOf(clause, cursor);
    cursor = at === -1 ? cursor : at + clause.length;
    const offset = st.offset + actionsAt + Math.max(0, at);
    const ln = sb.line(offset);
    const fk = FK_RE.exec(clause);
    let c: RegExpExecArray | null;
    if (/^add\s+/i.test(clause) && fk) {
      sb.foreignKey(table, identList(fk[1]!), normIdent(fk[2]!), fk[3] ? identList(fk[3]) : [], ln);
    } else if ((c = new RegExp(`^add\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?${ONE}\\s+([\\s\\S]+)$`, 'i').exec(clause)) && !CONSTRAINT_START.test(c[1]!)) {
      sb.column(table, normIdent(c[1]!), clip(c[2]!, 120), offset, true);
    } else if ((c = new RegExp(`^rename\\s+column\\s+${ONE}\\s+to\\s+${ONE}`, 'i').exec(clause))) {
      sb.b.edge(fileRef(sb.b.rel), 'MIGRATES_TO', `column:${table}.${normIdent(c[1]!)}`, ln, CONF.schema);
      sb.column(table, normIdent(c[2]!), `renamed from ${normIdent(c[1]!)}`, offset, true);
    } else if ((c = new RegExp(`^(?:drop|alter|modify|change)\\s+(?:column\\s+)?(?:if\\s+exists\\s+)?${ONE}`, 'i').exec(clause)) && !/^(constraint|primary|foreign|index|key|unique)$/i.test(c[1]!)) {
      sb.b.edge(fileRef(sb.b.rel), 'MIGRATES_TO', `column:${table}.${normIdent(c[1]!)}`, ln, CONF.schema);
    }
  }
  return true;
}

function createIndex(sb: SqlBuilder, st: Statement): boolean {
  const m = CREATE_INDEX_RE.exec(st.text);
  if (!m) return false;
  const table = normIdent(m[2]!);
  const name = m[1] ? normIdent(m[1]) : `${table}_idx`;
  const ln = sb.line(st.offset);
  sb.b.symbol(name, 'other', ln, sb.line(st.offset + st.text.length), clip(st.text, 160), true);
  for (const col of splitTopLevel(m[3]!)) {
    const simple = new RegExp(`^${ONE}(?:\\s+(?:asc|desc|nulls\\s+\\w+|collate\\s+\\S+))*$`, 'i').exec(col.trim());
    if (simple) sb.b.edge(symbolRef(sb.b.rel, name), 'REFERENCES', `column:${table}.${normIdent(simple[1]!)}`, ln, CONF.schema);
  }
  return true;
}

function createView(sb: SqlBuilder, st: Statement): void {
  const m = CREATE_VIEW_RE.exec(st.text);
  if (!m) return;
  const view = normIdent(m[1]!);
  const ln = sb.line(st.offset);
  sb.b.symbol(view, 'table', ln, sb.line(st.offset + st.text.length), `CREATE VIEW ${view}`, true);
  sb.b.edge(fileRef(sb.b.rel), 'DEFINES', `table:${view}`, ln, CONF.schema);
  const seen = new Set<string>();
  for (const f of m[2]!.matchAll(FROM_JOIN_RE)) {
    const t = normIdent(f[1]!);
    if (seen.has(t) || t === 'select' || t === 'lateral') continue;
    seen.add(t);
    sb.b.edge(`table:${view}`, 'READS', `table:${t}`, ln, CONF.view);
  }
}
