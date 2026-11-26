import { posix } from 'node:path';
import {
  CONF, ResultBuilder, blockEnd, fileRef, firstExisting, joinRel, splitTopLevel, stripCLike, symbolRef, typeTarget,
  type ExtractContext, type ExtractResult,
} from './common.ts';

/**
 * C / C++ extractor: #include, struct/class/union/enum, top-level functions
 * (namespace bodies count as top level), C++ base classes.
 */
export const PARSER_NAME = 'c-family-regex';
export const PARSER_VERSION = 1;

const INCLUDE_RE = /^#\s*include\s*([<"])([^>"]+)[>"]/;
const TYPE_RE = /^(?:typedef\s+)?(?:template\s*<[^>]*>\s*)?(struct|class|union|enum)(?:\s+class)?\s+(?:\[\[[^\]]*\]\]\s*)?(\w+)\s*(?:final\s*)?(?::\s*([^{]+))?\{?\s*$/;
const FUNC_RE = /^(?:template\s*<[^>]*>\s*)?(?:[\w:*&<>,]+\s+)+[*&]*\s*((?:\w+::)*~?\w+)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?\{?\s*$/;
const NOT_FUNCS = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'catch', 'else', 'do']);

/** Depth per line, ignoring braces opened by `namespace X {` and `extern "C" {`. */
function scopeDepths(skel: string[]): number[] {
  const out: number[] = [];
  const stack: boolean[] = [];
  for (const line of skel) {
    out.push(stack.filter(Boolean).length);
    const transparent = /^\s*(?:inline\s+)?namespace\b|^\s*extern\s+"C"/.test(line);
    let first = true;
    for (const ch of line) {
      if (ch === '{') {
        stack.push(!(transparent && first));
        first = false;
      } else if (ch === '}') {
        stack.pop();
      }
    }
  }
  return out;
}

export function extract(rel: string, text: string, ctx?: ExtractContext): ExtractResult {
  const b = new ResultBuilder(rel);
  const { code, skeleton } = stripCLike(text);
  const lines = code.split('\n');
  const skel = skeleton.split('\n');
  const depths = scopeDepths(skel);
  const local = new Set<string>();
  const heritage: Array<{ name: string; base: string; line: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const ln = i + 1;
    if (!line) continue;
    let m: RegExpExecArray | null;
    if ((m = INCLUDE_RE.exec(line))) {
      const spec = m[2]!;
      const target = m[1] === '"' ? firstExisting([joinRel(posix.dirname(rel), spec) ?? '', spec, `include/${spec}`, `src/${spec}`], ctx) : null;
      b.edge(fileRef(rel), 'IMPORTS', target ? fileRef(target) : `module:${spec}`, ln, target ? CONF.resolvedImport : CONF.moduleImport);
      continue;
    }
    if ((depths[i] ?? 0) !== 0) continue;
    if ((m = TYPE_RE.exec(line))) {
      const name = m[2]!;
      b.symbol(name, m[1] === 'enum' ? 'type' : 'class', ln, blockEnd(skel, i), line, true);
      local.add(name);
      if (m[3]) for (const base of splitTopLevel(m[3])) heritage.push({ name, base: base.replace(/^(?:(?:public|private|protected|virtual)\s+)+/, ''), line: ln });
      continue;
    }
    if ((m = FUNC_RE.exec(line)) && !NOT_FUNCS.has(m[1]!) && !line.startsWith('return') && !line.endsWith(';')) {
      const name = m[1]!.replace(/::/g, '.');
      b.symbol(name, name.includes('.') ? 'method' : 'function', ln, blockEnd(skel, i), line, !/^static\b/.test(line));
    }
  }
  for (const h of heritage) {
    const t = typeTarget(h.base, rel, local, new Map());
    b.edge(symbolRef(rel, h.name), 'EXTENDS', t.ref, h.line, t.confidence);
  }
  return b.result();
}
