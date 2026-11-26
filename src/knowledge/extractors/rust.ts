import { posix } from 'node:path';
import {
  CONF, ResultBuilder, blockEnd, braceDepths, fileRef, firstExisting, joinRel, symbolRef, typeTarget, stripCLike,
  type ExtractContext, type ExtractResult,
} from './common.ts';

/** Rust extractor: fns (methods inside impl), structs/enums/traits/types, `use`, `mod x;`, impl Trait for Type. */
export const PARSER_NAME = 'rust-regex';
export const PARSER_VERSION = 1;

const VIS = '(pub(?:\\([^)]*\\))?\\s+)?';
const FN_RE = new RegExp(`^${VIS}(?:default\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]*"\\s+)?fn\\s+(\\w+)`);
const TYPE_RE = new RegExp(`^${VIS}(struct|enum|trait|type|union)\\s+(\\w+)`);
const IMPL_RE = /^(?:unsafe\s+)?impl\s*(?:<[^{]*?>)?\s*(?:([\w:]+)(?:<[^{]*?>)?\s+for\s+)?([\w:]+)/;
const USE_RE = new RegExp(`^${VIS}use\\s+([\\w:]+)`);
const MOD_RE = new RegExp(`^${VIS}mod\\s+(\\w+)\\s*;`);

const KIND = { struct: 'class', enum: 'type', trait: 'interface', type: 'type', union: 'class' } as const;

export function extract(rel: string, text: string, ctx?: ExtractContext): ExtractResult {
  const b = new ResultBuilder(rel);
  const { code, skeleton } = stripCLike(text, { rustLifetimes: true });
  const lines = code.split('\n');
  const skel = skeleton.split('\n');
  const depths = braceDepths(skel);
  const local = new Set<string>();
  const impls: Array<{ type: string; depth: number; end: number }> = [];
  const traitImpls: Array<{ type: string; trait: string; line: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const ln = i + 1;
    const depth = depths[i] ?? 0;
    if (!line || line.startsWith('#')) continue;
    let m: RegExpExecArray | null;
    if ((m = IMPL_RE.exec(line))) {
      const type = m[2]!.split('::').pop()!;
      impls.push({ type, depth, end: blockEnd(skel, i) });
      if (m[1]) traitImpls.push({ type, trait: m[1], line: ln });
    } else if ((m = FN_RE.exec(line))) {
      const owner = impls.find((x) => ln <= x.end && depth === x.depth + 1);
      if (owner) b.symbol(`${owner.type}.${m[2]!}`, 'method', ln, blockEnd(skel, i), line, Boolean(m[1]));
      else if (depth === 0) b.symbol(m[2]!, 'function', ln, blockEnd(skel, i), line, Boolean(m[1]));
    } else if (depth === 0 && (m = TYPE_RE.exec(line))) {
      b.symbol(m[3]!, KIND[m[2] as keyof typeof KIND], ln, blockEnd(skel, i), line, Boolean(m[1]));
      local.add(m[3]!);
    } else if (depth === 0 && (m = MOD_RE.exec(line))) {
      const dir = posix.dirname(rel);
      const name = m[2]!;
      const target = firstExisting([joinRel(dir, `${name}.rs`) ?? '', joinRel(dir, `${name}/mod.rs`) ?? ''], ctx);
      b.edge(fileRef(rel), 'IMPORTS', target ? fileRef(target) : `module:${name}`, ln, target ? CONF.resolvedImport : CONF.moduleImport);
    } else if ((m = USE_RE.exec(line))) {
      const path = m[2]!.replace(/::$/, '');
      b.edge(fileRef(rel), 'IMPORTS', `module:${path}`, ln, CONF.moduleImport);
    }
  }
  for (const t of traitImpls) {
    const target = typeTarget(t.trait, rel, local, new Map());
    b.edge(symbolRef(rel, t.type), 'IMPLEMENTS', target.ref, t.line, target.confidence);
  }
  return b.result();
}
