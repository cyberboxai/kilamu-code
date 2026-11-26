import { CONF, ResultBuilder, blockEnd, braceDepths, fileRef, splitTopLevel, stripCLike, symbolRef, typeTarget, type ExtractResult } from './common.ts';

/**
 * C# extractor: using directives, classes/interfaces/structs/records/enums,
 * methods. Base list: names matching `I[A-Z]...` are treated as interfaces
 * (naming convention, not semantics).
 */
export const PARSER_NAME = 'csharp-regex';
export const PARSER_VERSION = 1;

const MODS = '(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|unsafe|new|file|ref)\\s+)*';
const USING_RE = /^(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/;
const TYPE_RE = new RegExp(`^(?:\\[[^\\]]*\\]\\s*)*${MODS}(class|interface|struct|record(?:\\s+struct|\\s+class)?|enum)\\s+(\\w+)(?:<[^>]*>)?(?:\\s*\\([^)]*\\))?(?:\\s*:\\s*([^{]+?))?(?:\\s+where\\b.*)?\\s*\\{?\\s*$`);
const METHOD_RE = /^(?:\[[^\]]*\]\s*)*((?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|unsafe|new|partial)\s+)+[\w<>[\],.?]+\s+(\w+)\s*(?:<[^>]*>)?\s*\(/;
const NAMESPACE_RE = /^namespace\s+[\w.]+\s*(;|\{?\s*$)/;

export function extract(rel: string, text: string): ExtractResult {
  const b = new ResultBuilder(rel);
  const { code, skeleton } = stripCLike(text);
  const lines = code.split('\n');
  const skel = skeleton.split('\n');
  const depths = braceDepths(skel);
  const local = new Set<string>();
  const types: Array<{ name: string; depth: number; end: number }> = [];
  const heritage: Array<{ name: string; base: string; line: number }> = [];
  let nsOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const ln = i + 1;
    if (!line) continue;
    const depth = (depths[i] ?? 0) - nsOffset;
    let m: RegExpExecArray | null;
    if ((m = USING_RE.exec(line))) {
      b.edge(fileRef(rel), 'IMPORTS', `module:${m[1]!}`, ln, CONF.moduleImport);
    } else if ((m = NAMESPACE_RE.exec(line))) {
      // Block-scoped namespaces add one transparent brace level.
      if (m[1] !== ';') nsOffset = 1;
    } else if ((m = TYPE_RE.exec(line))) {
      const name = m[2]!;
      const end = blockEnd(skel, i);
      b.symbol(name, m[1] === 'interface' ? 'interface' : m[1] === 'enum' ? 'type' : 'class', ln, end, line, /\b(public|internal)\b/.test(line));
      local.add(name);
      types.push({ name, depth, end });
      if (m[3]) for (const base of splitTopLevel(m[3])) heritage.push({ name, base, line: ln });
    } else if ((m = METHOD_RE.exec(line))) {
      const owner = types.find((t) => ln <= t.end && depth === t.depth + 1);
      if (owner) b.symbol(`${owner.name}.${m[2]!}`, 'method', ln, blockEnd(skel, i), line, /\bpublic\b/.test(m[1]!));
    }
  }
  for (const h of heritage) {
    const t = typeTarget(h.base, rel, local, new Map());
    const isInterface = /^I[A-Z]/.test(h.base.replace(/^.*\./, ''));
    b.edge(symbolRef(rel, h.name), isInterface ? 'IMPLEMENTS' : 'EXTENDS', t.ref, h.line, t.confidence);
  }
  return b.result();
}
