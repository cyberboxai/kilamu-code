import { posix } from 'node:path';
import {
  CONF, ResultBuilder, blockEnd, braceDepths, fileRef, firstExisting, joinRel, lineAt, lineIndex, splitTopLevel, stripCLike, symbolRef, typeTarget,
  type ExtractContext, type ExtractResult, type ImportBinding,
} from './common.ts';

/**
 * TypeScript / JavaScript (ts, tsx, js, jsx, mjs, cjs) regex extractor.
 * Best effort: declarations are matched per line after blanking comments;
 * method detection relies on brace depth and may miss unusual formatting.
 */
export const PARSER_NAME = 'ts-js-regex';
export const PARSER_VERSION = 1;

const ID = '[A-Za-z_$][\\w$]*';
const FUNC_RE = new RegExp(`^(export\\s+)?(default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})`);
const CLASS_RE = new RegExp(`^(export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${ID})\\s*(?:<[^{]*?>)?\\s*(?:extends\\s+(${ID}(?:\\.${ID})*)(?:<[^{]*?>)?)?\\s*(?:implements\\s+([^{]+))?`);
const INTERFACE_RE = new RegExp(`^(export\\s+)?(?:declare\\s+)?interface\\s+(${ID})\\s*(?:<[^{]*?>)?\\s*(?:extends\\s+([^{]+))?`);
const TYPE_RE = new RegExp(`^(export\\s+)?(?:declare\\s+)?type\\s+(${ID})\\s*(?:<[^=]*>)?\\s*=`);
const ENUM_RE = new RegExp(`^(export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(${ID})`);
const VAR_RE = new RegExp(`^(export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=\\s*(.*)$`);
const FUNC_VALUE_RE = new RegExp(`^(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]+)?=>|${ID}\\s*=>)`);
const METHOD_RE = new RegExp(`^(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set|declare)\\s+)*\\*?\\s*(#?${ID})\\s*(?:<[^>]*>)?\\s*\\(`);
const PROP_FN_RE = new RegExp(`^(?:(?:public|private|protected|static|readonly|override)\\s+)*(#?${ID})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:\\([^)]*\\)|${ID})\\s*(?::[^=]+)?=>`);
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}\s*;?\s*$/;
/** Cheap guard: only lines starting with a declaration keyword can match the declaration regexes. */
const DECL_START = /^(?:export|default|declare|abstract|async|function|class|interface|type|enum|const|let|var)\b/;
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'super', 'await', 'typeof', 'with', 'do', 'else', 'constructor']);

const IMPORT_FROM_RE = /\b(?:import|export)\s+(?:type\s+)?([\w*{}\s,$]*?)\s*from\s*(['"])([^'"\n]+)\2/g;
const SIDE_EFFECT_RE = /(?:^|[;\s])import\s*(['"])([^'"\n]+)\1/g;
const DYNAMIC_RE = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const REQUIRE_RE = /\b(?:(?:const|let|var)\s+([\w$]+|\{[^}]*\})\s*=\s*)?require\s*\(\s*(['"])([^'"\n]+)\2\s*\)/g;
const ROUTE_RE = /\b(app|router|server|[A-Za-z_$][\w$]*(?:Router|router|App|app))\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*(['"`])(\/[^'"`\n]*)\3/g;

const JS_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

/** Resolve a relative module specifier to a project file, or null. */
export function resolveJsImport(rel: string, spec: string, ctx: ExtractContext | undefined): string | null {
  if (!spec.startsWith('.')) return null;
  const base = joinRel(posix.dirname(rel), spec);
  if (base === null) return null;
  const candidates = [base, ...JS_EXTS.map((e) => base + e), ...JS_EXTS.map((e) => `${base}/index${e}`)];
  const jsExt = /\.(m|c)?jsx?$/.exec(base);
  if (jsExt) {
    const stem = base.slice(0, -jsExt[0].length);
    candidates.splice(1, 0, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
  }
  return firstExisting(candidates, ctx);
}

/** [local, imported] name pairs from an import clause like `A, { b as c }, * as ns`. */
function bindingNames(clause: string): Array<[string, string]> {
  const names: Array<[string, string]> = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1]!.split(',')) {
      const m = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(part.trim());
      if (m) names.push([m[2] ?? m[1]!, m[1]!]);
    }
  }
  const rest = clause.replace(/\{[^}]*\}/, '');
  const ns = /\*\s*as\s+([\w$]+)/.exec(rest);
  if (ns) names.push([ns[1]!, '*']);
  const def = /^\s*([\w$]+)\s*(,|$)/.exec(rest);
  if (def && def[1] !== 'type') names.push([def[1]!, 'default']);
  return names;
}

interface ImportSite {
  spec: string;
  line: number;
  names: Array<[string, string]>;
}

function importSites(code: string, starts: number[]): ImportSite[] {
  const sites: ImportSite[] = [];
  for (const m of code.matchAll(IMPORT_FROM_RE)) sites.push({ spec: m[3]!, line: lineAt(starts, m.index), names: bindingNames(m[1]!) });
  for (const m of code.matchAll(SIDE_EFFECT_RE)) sites.push({ spec: m[2]!, line: lineAt(starts, m.index), names: [] });
  for (const m of code.matchAll(DYNAMIC_RE)) sites.push({ spec: m[2]!, line: lineAt(starts, m.index), names: [] });
  for (const m of code.matchAll(REQUIRE_RE)) sites.push({ spec: m[3]!, line: lineAt(starts, m.index), names: m[1] ? bindingNames(m[1]) : [] });
  return sites;
}

interface ClassScope {
  name: string;
  depth: number;
  endLine: number;
}

export function extract(rel: string, text: string, ctx?: ExtractContext): ExtractResult {
  const b = new ResultBuilder(rel);
  const { code, skeleton } = stripCLike(text, { backtickStrings: true });
  const starts = lineIndex(code);
  const lines = code.split('\n');
  const skel = skeleton.split('\n');
  const depths = braceDepths(skel);

  const importedFrom = new Map<string, ImportBinding>();
  for (const site of importSites(code, starts)) {
    const target = resolveJsImport(rel, site.spec, ctx);
    if (target) {
      b.edge(fileRef(rel), 'IMPORTS', fileRef(target), site.line, CONF.resolvedImport);
      for (const [localName, name] of site.names) importedFrom.set(localName, { file: target, name });
    } else {
      b.edge(fileRef(rel), 'IMPORTS', `module:${site.spec}`, site.line, CONF.moduleImport);
    }
  }

  const local = new Set<string>();
  const heritage: Array<{ name: string; rel: 'EXTENDS' | 'IMPLEMENTS'; base: string; line: number }> = [];
  const exportList = new Set<string>();
  const classes: ClassScope[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (!line) continue;
    const ln = i + 1;
    const depth = depths[i] ?? 0;
    const end = () => blockEnd(skel, i);
    const decl = DECL_START.test(line);

    const exportsList = decl ? EXPORT_LIST_RE.exec(line) : null;
    if (exportsList) {
      for (const part of exportsList[1]!.split(',')) {
        const m = /^([\w$]+)/.exec(part.trim());
        if (m) exportList.add(m[1]!);
      }
      continue;
    }
    let m = decl ? CLASS_RE.exec(line) : null;
    if (m) {
      const name = m[2]!;
      const e = end();
      b.symbol(name, 'class', ln, e, line, Boolean(m[1]));
      local.add(name);
      classes.push({ name, depth, endLine: e });
      if (m[3]) heritage.push({ name, rel: 'EXTENDS', base: m[3], line: ln });
      if (m[4]) for (const base of splitTopLevel(m[4])) heritage.push({ name, rel: 'IMPLEMENTS', base, line: ln });
      continue;
    }
    if (decl && (m = INTERFACE_RE.exec(line))) {
      const name = m[2]!;
      b.symbol(name, 'interface', ln, end(), line, Boolean(m[1]));
      local.add(name);
      if (m[3]) for (const base of splitTopLevel(m[3])) heritage.push({ name, rel: 'EXTENDS', base, line: ln });
      continue;
    }
    if (decl && ((m = TYPE_RE.exec(line)) || (m = ENUM_RE.exec(line)))) {
      b.symbol(m[2]!, 'type', ln, end(), line, Boolean(m[1]));
      local.add(m[2]!);
      continue;
    }
    if (decl && (m = FUNC_RE.exec(line))) {
      b.symbol(m[3]!, 'function', ln, end(), line, Boolean(m[1]));
      local.add(m[3]!);
      continue;
    }
    if (decl && (m = VAR_RE.exec(line))) {
      const isFn = FUNC_VALUE_RE.test(m[3]!);
      const exported = Boolean(m[1]);
      if (exported || (isFn && depth === 0)) {
        b.symbol(m[2]!, isFn ? 'function' : 'variable', ln, isFn ? end() : ln, line, exported);
        local.add(m[2]!);
      }
      continue;
    }
    const owner = classes.length === 0 ? undefined : classes.find((c) => ln <= c.endLine && depth === c.depth + 1);
    if (owner) {
      const mm = PROP_FN_RE.exec(line) ?? METHOD_RE.exec(line);
      if (mm && !NOT_METHODS.has(mm[1]!)) b.symbol(`${owner.name}.${mm[1]!}`, 'method', ln, end(), line, false);
    }
  }

  for (const s of b.symbols) if (exportList.has(s.name)) s.exported = true;
  for (const h of heritage) {
    const t = typeTarget(h.base, rel, local, importedFrom);
    b.edge(symbolRef(rel, h.name), h.rel, t.ref, h.line, t.confidence);
  }
  for (const r of code.matchAll(ROUTE_RE)) {
    const method = r[2]!.toUpperCase();
    const name = `${method} ${r[4]!}`;
    const ln = lineAt(starts, r.index);
    b.symbol(name, 'endpoint', ln, ln, (lines[ln - 1] ?? '').trim(), true);
    b.edge(fileRef(rel), 'DEFINES', `endpoint:${name}`, ln, CONF.endpoint);
  }
  return b.result();
}
