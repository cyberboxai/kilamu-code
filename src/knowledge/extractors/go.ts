import { CONF, ResultBuilder, blockEnd, braceDepths, fileRef, stripCLike, type ExtractResult } from './common.ts';

/** Go extractor: top-level funcs/methods, types, vars/consts, imports. */
export const PARSER_NAME = 'go-regex';
export const PARSER_VERSION = 1;

const FUNC_RE = /^func\s+(?:\(\s*\w*\s*\*?\s*(\w+)(?:\[[^\]]*\])?\s*\)\s*)?(\w+)\s*(?:\[[^\]]*\])?\s*\(/;
const TYPE_RE = /^(?:type\s+)?(\w+)\s+(?:\[[^\]]*\]\s*)?(struct|interface)?\b/;
const VAR_RE = /^(?:var|const)\s+(\w+)/;
const IMPORT_LINE_RE = /^(?:import\s+)?(?:[\w.]+\s+)?"([^"]+)"/;

const exported = (name: string) => /^[A-Z]/.test(name);

export function extract(rel: string, text: string): ExtractResult {
  const b = new ResultBuilder(rel);
  const { code, skeleton } = stripCLike(text, { backtickStrings: true });
  const lines = code.split('\n');
  const skel = skeleton.split('\n');
  const depths = braceDepths(skel);
  let group: 'import' | 'type' | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const ln = i + 1;
    if (!line || (depths[i] ?? 0) > 0) continue;
    if (group) {
      if (line.startsWith(')')) {
        group = null;
        continue;
      }
      if (group === 'import') {
        const m = IMPORT_LINE_RE.exec(line);
        if (m) b.edge(fileRef(rel), 'IMPORTS', `module:${m[1]!}`, ln, CONF.moduleImport);
      } else {
        addType(b, line, ln, blockEnd(skel, i));
      }
      continue;
    }
    if (/^import\s*\($/.test(line)) group = 'import';
    else if (/^type\s*\($/.test(line)) group = 'type';
    else if (line.startsWith('import')) {
      const m = IMPORT_LINE_RE.exec(line);
      if (m) b.edge(fileRef(rel), 'IMPORTS', `module:${m[1]!}`, ln, CONF.moduleImport);
    } else if (line.startsWith('func')) {
      const m = FUNC_RE.exec(line);
      if (m) {
        const name = m[1] ? `${m[1]}.${m[2]!}` : m[2]!;
        b.symbol(name, m[1] ? 'method' : 'function', ln, blockEnd(skel, i), line, exported(m[2]!));
      }
    } else if (line.startsWith('type ')) {
      addType(b, line, ln, blockEnd(skel, i));
    } else {
      const m = VAR_RE.exec(line);
      if (m) b.symbol(m[1]!, 'variable', ln, ln, line, exported(m[1]!));
    }
  }
  return b.result();
}

function addType(b: ResultBuilder, line: string, ln: number, end: number): void {
  const m = TYPE_RE.exec(line);
  if (!m) return;
  const kind = m[2] === 'struct' ? 'class' : m[2] === 'interface' ? 'interface' : 'type';
  b.symbol(m[1]!, kind, ln, kind === 'type' ? ln : end, line, exported(m[1]!));
}
