import {
  CONF, ResultBuilder, blockEnd, braceDepths, fileRef, firstExisting, splitTopLevel, stripCLike, symbolRef, typeTarget,
  type ExtractContext, type ExtractResult, type ImportBinding,
} from './common.ts';

/** Java / Kotlin extractor: classes/interfaces/enums/records/objects, methods/funs, imports, extends/implements. */
export const PARSER_NAME = 'jvm-regex';
export const PARSER_VERSION = 1;

const MODS = '(?:(?:public|private|protected|internal|abstract|final|static|sealed|non-sealed|data|open|inner|value|annotation|enum|strictfp)\\s+)*';
const TYPE_RE = new RegExp(`^(?:@\\w+(?:\\([^)]*\\))?\\s+)*${MODS}(class|interface|enum|record|object|@interface)\\s+(\\w+)([^{]*)`);
const JAVA_METHOD_RE = /^(?:@\w+(?:\([^)]*\))?\s+)*((?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)+[\w<>[\], ?.]+\s+(\w+)\s*\(/;
const KOTLIN_FUN_RE = /^(?:@\w+(?:\([^)]*\))?\s+)*((?:public|private|protected|internal|override|suspend|inline|open|abstract|operator|infix|tailrec)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(/;
const IMPORT_RE = /^import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;?/;
const SOURCE_ROOTS = ['', 'src/', 'src/main/java/', 'src/main/kotlin/', 'app/src/main/java/', 'app/src/main/kotlin/'];

export function extract(rel: string, text: string, ctx?: ExtractContext): ExtractResult {
  const b = new ResultBuilder(rel);
  const kotlin = /\.kts?$/.test(rel);
  const { code, skeleton } = stripCLike(text, { backtickStrings: kotlin });
  const lines = code.split('\n');
  const skel = skeleton.split('\n');
  const depths = braceDepths(skel);
  const local = new Set<string>();
  const importedFrom = new Map<string, ImportBinding>();
  const types: Array<{ name: string; depth: number; end: number }> = [];
  const heritage: Array<{ name: string; rel: 'EXTENDS' | 'IMPLEMENTS'; base: string; line: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const ln = i + 1;
    const depth = depths[i] ?? 0;
    if (!line) continue;
    let m: RegExpExecArray | null;
    if ((m = IMPORT_RE.exec(line))) {
      const fqcn = m[1]!;
      const asPath = fqcn.replaceAll('.', '/');
      const file = firstExisting(SOURCE_ROOTS.flatMap((r) => [`${r}${asPath}.java`, `${r}${asPath}.kt`]), ctx);
      b.edge(fileRef(rel), 'IMPORTS', file ? fileRef(file) : `module:${fqcn}`, ln, file ? CONF.resolvedImport : CONF.moduleImport);
      if (file) importedFrom.set(fqcn.split('.').pop()!, { file, name: fqcn.split('.').pop()! });
      continue;
    }
    if ((m = TYPE_RE.exec(line))) {
      const name = m[2]!;
      const kind = m[1] === 'interface' || m[1] === '@interface' ? 'interface' : m[1] === 'enum' ? 'type' : 'class';
      const end = blockEnd(skel, i);
      b.symbol(name, kind, ln, end, line, !/\bprivate\b/.test(line));
      local.add(name);
      types.push({ name, depth, end });
      collectHeritage(name, m[3]!, kotlin, kind === 'interface', ln, heritage);
      continue;
    }
    const owner = types.find((t) => ln <= t.end && depth === t.depth + 1);
    m = kotlin ? KOTLIN_FUN_RE.exec(line) : JAVA_METHOD_RE.exec(line);
    if (m && (owner || (kotlin && depth === 0))) {
      const name = owner ? `${owner.name}.${m[2]!}` : m[2]!;
      b.symbol(name, owner ? 'method' : 'function', ln, blockEnd(skel, i), line, !/\bprivate\b/.test(m[1] ?? ''));
    }
  }
  for (const h of heritage) {
    const t = typeTarget(h.base, rel, local, importedFrom);
    b.edge(symbolRef(rel, h.name), h.rel, t.ref, h.line, t.confidence);
  }
  return b.result();
}

function collectHeritage(
  name: string, tail: string, kotlin: boolean, isInterface: boolean, line: number,
  out: Array<{ name: string; rel: 'EXTENDS' | 'IMPLEMENTS'; base: string; line: number }>,
): void {
  if (kotlin) {
    // Kotlin: `class A(...) : B(), C` — superclass vs interface is not syntactically distinguishable.
    const colon = /\)?\s*:\s*([^{]+)$/.exec(tail.replace(/\([^)]*\)/g, (s) => (s.includes(':') ? '()' : s)));
    if (colon) for (const base of splitTopLevel(colon[1]!)) out.push({ name, rel: 'EXTENDS', base: base.replace(/\(.*$/, ''), line });
    return;
  }
  const ext = /\bextends\s+([^{]+?)(?:\bimplements\b|$)/.exec(tail);
  if (ext) for (const base of splitTopLevel(ext[1]!)) out.push({ name, rel: 'EXTENDS', base, line });
  const impl = /\bimplements\s+([^{]+)/.exec(tail);
  if (impl && !isInterface) for (const base of splitTopLevel(impl[1]!)) out.push({ name, rel: 'IMPLEMENTS', base, line });
}
