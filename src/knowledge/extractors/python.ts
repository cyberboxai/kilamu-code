import { posix } from 'node:path';
import type { SymbolRecord } from '../../core/types.ts';
import {
  CONF, ResultBuilder, blankOut, fileRef, firstExisting, joinRel, splitTopLevel, symbolRef, typeTarget, type ExtractContext, type ExtractResult, type ImportBinding,
} from './common.ts';

/**
 * Python regex/indentation extractor: def/class (bases → EXTENDS), imports,
 * FastAPI/Flask route decorators, Django `path()` URLs, and ORM table/column
 * mapping for Django models and SQLAlchemy declarative classes.
 * ORM edges are low confidence: table names follow defaults, not runtime config.
 */
export const PARSER_NAME = 'python-regex';
export const PARSER_VERSION = 1;

const CLASS_RE = /^class\s+(\w+)\s*(?:\(([\s\S]*?)\))?\s*:/;
const DEF_RE = /^(?:async\s+)?def\s+(\w+)\s*\(/;
const IMPORT_RE = /^import\s+(.+)$/;
const FROM_RE = /^from\s+(\.*)([\w.]*)\s+import\s+\(?([\s\S]+?)\)?\s*$/;
const DECORATOR_ROUTE_RE = /^@(\w+)\.(get|post|put|patch|delete|options|head|route|api_route|websocket)\s*\(\s*['"]([^'"]*)['"]([\s\S]*)$/;
const ROUTER_RE = /^(\w+)\s*=\s*(?:\w+\.)?(?:APIRouter|Blueprint)\s*\(([\s\S]*)\)\s*$/;
const DJANGO_PATH_RE = /(?<![.\w])(re_path|path)\s*\(\s*r?['"]([^'"]*)['"]/g;
const TABLENAME_RE = /^__tablename__\s*=\s*['"]([^'"]+)['"]/;
const DB_TABLE_RE = /^db_table\s*=\s*['"]([^'"]+)['"]/;
const FIELD_RE = /^(\w+)\s*(?::\s*[^=]+)?=\s*(?:(models)\.(\w+)|(?:db\.|sa\.|sqlalchemy\.|orm\.)?(Column|mapped_column))\s*\(([\s\S]*)$/;
const SA_FK_RE = /ForeignKey\(\s*['"](\w+)\.(\w+)['"]/;
const DJANGO_FK_TYPES = new Set(['ForeignKey', 'OneToOneField']);

/** Blank `#` comments and triple-quoted string bodies, preserving offsets. */
function stripPython(text: string): string {
  const out: string[] = [];
  const special = /[#'"]/g;
  let copied = 0;
  let pos = 0;
  for (;;) {
    special.lastIndex = pos;
    const m = special.exec(text);
    if (!m) break;
    const at = m.index;
    const ch = text[at]!;
    let end: number;
    let keep = false;
    if (ch === '#') {
      end = text.indexOf('\n', at);
      if (end === -1) end = text.length;
    } else if (text.startsWith(ch.repeat(3), at)) {
      const q = ch.repeat(3);
      end = findClose(text, at + 3, q, false);
      const closed = end - at >= 6 && text.startsWith(q, end - 3);
      const bodyEnd = closed ? end - 3 : end;
      out.push(text.slice(copied, at), q, blankOut(text.slice(at + 3, bodyEnd)), closed ? q : '');
      copied = pos = end;
      continue;
    } else {
      end = findClose(text, at + 1, ch, true);
      keep = true;
    }
    out.push(text.slice(copied, at), keep ? text.slice(at, end) : blankOut(text.slice(at, end)));
    copied = pos = end;
  }
  out.push(text.slice(copied));
  return out.join('');
}

/** Exclusive end of a string body starting at `from` and closed by `close`. */
function findClose(text: string, from: number, close: string, stopAtNewline: boolean): number {
  for (let j = from; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (c === 92) j++;
    else if (stopAtNewline && c === 10) return j;
    else if (text.startsWith(close, j)) return j + close.length;
  }
  return text.length;
}

interface LogicalLine {
  text: string;
  line: number;
  indent: number;
  /** Index of the last physical line consumed. */
  lastIdx: number;
}

/** Join physical lines while brackets are open, so multi-line signatures parse. */
function logicalLines(code: string): LogicalLine[] {
  const phys = code.split('\n');
  const out: LogicalLine[] = [];
  for (let i = 0; i < phys.length; i++) {
    const first = phys[i]!;
    if (!first.trim()) continue;
    const indent = first.length - first.trimStart().length;
    let text = first.trim();
    let depth = bracketDelta(text);
    let j = i;
    while ((depth > 0 || text.endsWith('\\')) && j + 1 < phys.length && j - i < 50) {
      j++;
      text = `${text.replace(/\\$/, '')} ${phys[j]!.trim()}`;
      depth += bracketDelta(phys[j]!);
    }
    out.push({ text, line: i + 1, indent, lastIdx: j });
    i = j;
  }
  return out;
}

function bracketDelta(s: string): number {
  let d = 0;
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') d++;
    else if (ch === ')' || ch === ']' || ch === '}') d--;
  }
  return d;
}

function moduleCandidates(modPath: string, absolute: boolean): string[] {
  const roots = absolute ? ['', 'src/'] : [''];
  return roots.flatMap((r) => [`${r}${modPath}.py`, `${r}${modPath}/__init__.py`]);
}

interface ImportResolution {
  targets: Array<{ file: string | null; spec: string }>;
  /** [imported name, binding] */
  bindings: Array<[string, ImportBinding]>;
}

function resolveFrom(rel: string, dots: string, mod: string, names: string[], ctx: ExtractContext | undefined): ImportResolution {
  let base: string | null = '';
  if (dots) {
    base = posix.dirname(rel);
    for (let k = 1; k < dots.length && base !== null; k++) base = joinRel(base, '..');
  }
  const res: ImportResolution = { targets: [], bindings: [] };
  const spec = `${dots}${mod}`;
  if (base === null) return { targets: [{ file: null, spec }], bindings: [] };
  const modPath = [base, mod.replaceAll('.', '/')].filter(Boolean).join('/');
  const modFile = modPath ? firstExisting(moduleCandidates(modPath, !dots), ctx) : null;
  if (modFile) res.targets.push({ file: modFile, spec });
  for (const name of names) {
    const sub = firstExisting(moduleCandidates([modPath, name].filter(Boolean).join('/'), !dots), ctx);
    if (sub) {
      res.targets.push({ file: sub, spec: `${spec}.${name}` });
      res.bindings.push([name, { file: sub, name: '*' }]);
    } else if (modFile) {
      res.bindings.push([name, { file: modFile, name }]);
    }
  }
  if (res.targets.length === 0) res.targets.push({ file: null, spec });
  return res;
}

function importedNames(list: string): Array<{ name: string; alias: string }> {
  return splitTopLevel(list.replace(/[()]/g, ''))
    .map((part) => /^([\w.*]+)(?:\s+as\s+(\w+))?$/.exec(part.trim()))
    .filter((m): m is RegExpExecArray => m !== null && m[1] !== '*')
    .map((m) => ({ name: m[1]!, alias: m[2] ?? m[1]! }));
}

interface OrmField {
  column: string;
  line: number;
  fk: string | null;
}

interface Scope {
  kind: 'class' | 'def';
  name: string;
  qualified: string;
  indent: number;
  lastLine: number;
  symbols: SymbolRecord[];
  table: string | null;
  fields: OrmField[];
}

function quotedList(s: string): string[] {
  return [...s.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

function normalizeRoute(prefix: string, path: string): string {
  const joined = `${prefix.replace(/\/$/, '')}${path && !path.startsWith('/') && prefix ? '/' : ''}${path}`;
  return joined.startsWith('/') ? joined : `/${joined}`;
}

export function extract(rel: string, text: string, ctx?: ExtractContext): ExtractResult {
  const b = new ResultBuilder(rel);
  const code = stripPython(text);
  const importedFrom = new Map<string, ImportBinding>();
  const local = new Set<string>();
  const heritage: Array<{ name: string; base: string; line: number }> = [];
  const prefixes = new Map<string, string>();
  const scopes: Scope[] = [];
  let decorators: Array<{ text: string; line: number }> = [];

  const finalize = (s: Scope) => {
    for (const sym of s.symbols) sym.lineEnd = Math.max(sym.lineStart, s.lastLine);
    if (s.kind === 'class') emitOrm(b, rel, s);
  };

  for (const ll of logicalLines(code)) {
    while (scopes.length > 0 && ll.indent <= scopes[scopes.length - 1]!.indent) finalize(scopes.pop()!);
    const parent = scopes[scopes.length - 1];
    const t = ll.text;
    let m: RegExpExecArray | null;

    if (t.startsWith('@')) {
      decorators.push({ text: t, line: ll.line });
    } else if (t.startsWith('class ') && (m = CLASS_RE.exec(t))) {
      const name = m[1]!;
      const qualified = parent ? `${parent.qualified}.${name}` : name;
      b.symbol(qualified, 'class', decorators[0]?.line ?? ll.line, ll.line, t, !name.startsWith('_'));
      local.add(name);
      const bases = (m[2] ?? '').trim();
      for (const base of splitTopLevel(bases)) if (!base.includes('=')) heritage.push({ name: qualified, base, line: ll.line });
      const django = /\bmodels\.Model\b/.test(bases);
      scopes.push({ kind: 'class', name, qualified, indent: ll.indent, lastLine: ll.line, symbols: [b.symbols[b.symbols.length - 1]!], table: django ? name.toLowerCase() : null, fields: [] });
      decorators = [];
    } else if ((t.startsWith('def ') || t.startsWith('async ')) && (m = DEF_RE.exec(t))) {
      const name = m[1]!;
      const isMethod = parent?.kind === 'class';
      const qualified = parent ? `${parent.qualified}.${name}` : name;
      const syms: SymbolRecord[] = [];
      if (!parent || isMethod) {
        b.symbol(qualified, isMethod ? 'method' : 'function', decorators[0]?.line ?? ll.line, ll.line, t, !name.startsWith('_'));
        syms.push(b.symbols[b.symbols.length - 1]!);
      }
      for (const d of decorators) syms.push(...endpointFromDecorator(b, rel, d, prefixes));
      scopes.push({ kind: 'def', name, qualified, indent: ll.indent, lastLine: ll.line, symbols: syms, table: null, fields: [] });
      decorators = [];
    } else {
      decorators = [];
      handleStatement(b, rel, t, ll.line, parent, scopes[scopes.length - 2], ctx, importedFrom, prefixes);
    }
    for (const s of scopes) s.lastLine = ll.lastIdx + 1;
  }
  while (scopes.length > 0) finalize(scopes.pop()!);

  for (const h of heritage) {
    const tt = typeTarget(h.base, rel, local, importedFrom);
    b.edge(symbolRef(rel, h.name), 'EXTENDS', tt.ref, h.line, tt.confidence);
  }
  if (/\burlpatterns\b/.test(code)) {
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const pm of lines[i]!.matchAll(DJANGO_PATH_RE)) {
        const name = `ANY ${normalizeRoute('', pm[2]!)}`;
        b.symbol(name, 'endpoint', i + 1, i + 1, lines[i]!, true);
        b.edge(fileRef(rel), 'DEFINES', `endpoint:${name}`, i + 1, CONF.endpoint);
      }
    }
  }
  return b.result();
}

function handleStatement(
  b: ResultBuilder, rel: string, t: string, line: number, parent: Scope | undefined, outer: Scope | undefined, ctx: ExtractContext | undefined,
  importedFrom: Map<string, ImportBinding>, prefixes: Map<string, string>,
): void {
  let m: RegExpExecArray | null;
  if (t.startsWith('from ') && (m = FROM_RE.exec(t))) {
    const names = importedNames(m[3]!);
    const res = resolveFrom(rel, m[1]!, m[2]!, names.map((n) => n.name), ctx);
    for (const target of res.targets) {
      b.edge(fileRef(rel), 'IMPORTS', target.file ? fileRef(target.file) : `module:${target.spec}`, line, target.file ? CONF.resolvedImport : CONF.moduleImport);
    }
    const aliasOf = new Map(names.map((n) => [n.name, n.alias]));
    for (const [name, binding] of res.bindings) importedFrom.set(aliasOf.get(name) ?? name, binding);
    return;
  }
  if (t.startsWith('import ') && (m = IMPORT_RE.exec(t))) {
    for (const { name, alias } of importedNames(m[1]!)) {
      const file = firstExisting(moduleCandidates(name.replaceAll('.', '/'), true), ctx);
      b.edge(fileRef(rel), 'IMPORTS', file ? fileRef(file) : `module:${name}`, line, file ? CONF.resolvedImport : CONF.moduleImport);
      if (file) importedFrom.set(alias, { file, name: '*' });
    }
    return;
  }
  if ((t.includes('Router(') || t.includes('Blueprint(')) && (m = ROUTER_RE.exec(t))) {
    const p = /(?:url_)?prefix\s*=\s*['"]([^'"]*)['"]/.exec(m[2]!);
    prefixes.set(m[1]!, p ? p[1]! : '');
    return;
  }
  if (parent?.kind !== 'class') return;
  if ((m = TABLENAME_RE.exec(t))) {
    parent.table = m[1]!.toLowerCase();
  } else if ((m = DB_TABLE_RE.exec(t)) && parent.name === 'Meta' && outer?.kind === 'class') {
    // Django `class Meta: db_table = ...` overrides the model's default table.
    outer.table = m[1]!.toLowerCase();
  } else if ((m = FIELD_RE.exec(t))) {
    const args = m[5] ?? '';
    if (m[2] === 'models') {
      const type = m[3]!;
      if (type === 'ManyToManyField') return;
      const dbColumn = /db_column\s*=\s*['"](\w+)['"]/.exec(args);
      const column = dbColumn ? dbColumn[1]! : DJANGO_FK_TYPES.has(type) ? `${m[1]!}_id` : m[1]!;
      const target = DJANGO_FK_TYPES.has(type) ? /^\s*['"]?(?:\w+\.)?(\w+)/.exec(args) : null;
      parent.fields.push({ column: column.toLowerCase(), line, fk: target ? `table:${target[1]!.toLowerCase()}` : null });
    } else {
      const named = /^\s*['"](\w+)['"]/.exec(args);
      const fk = SA_FK_RE.exec(args);
      parent.fields.push({ column: (named ? named[1]! : m[1]!).toLowerCase(), line, fk: fk ? `column:${fk[1]!.toLowerCase()}.${fk[2]!.toLowerCase()}` : null });
    }
  }
}

function endpointFromDecorator(b: ResultBuilder, rel: string, d: { text: string; line: number }, prefixes: Map<string, string>): SymbolRecord[] {
  const m = DECORATOR_ROUTE_RE.exec(d.text);
  if (!m) return [];
  const verb = m[2]!;
  let methods: string[];
  if (verb === 'route' || verb === 'api_route') {
    const list = /methods\s*=\s*[[(]([^\])]*)[\])]/.exec(m[4]!);
    methods = list ? quotedList(list[1]!).map((x) => x.toUpperCase()) : ['GET'];
  } else {
    methods = [verb === 'websocket' ? 'WS' : verb.toUpperCase()];
  }
  const path = normalizeRoute(prefixes.get(m[1]!) ?? '', m[3]!);
  const out: SymbolRecord[] = [];
  for (const method of methods) {
    const name = `${method} ${path}`;
    b.symbol(name, 'endpoint', d.line, d.line, d.text, true);
    out.push(b.symbols[b.symbols.length - 1]!);
    b.edge(fileRef(rel), 'DEFINES', `endpoint:${name}`, d.line, CONF.endpoint);
  }
  return out;
}

function emitOrm(b: ResultBuilder, rel: string, cls: Scope): void {
  const table = cls.table;
  if (cls.name === 'Meta' || !table || cls.fields.length === 0) return;
  const src = symbolRef(rel, cls.qualified);
  const line = cls.symbols[0]?.lineStart ?? 1;
  b.edge(src, 'READS', `table:${table}`, line, CONF.orm);
  for (const f of cls.fields) {
    const col = `column:${table}.${f.column}`;
    b.edge(src, 'READS', col, f.line, CONF.orm);
    if (f.fk) b.edge(col, 'REFERENCES', f.fk, f.line, CONF.orm);
  }
}
