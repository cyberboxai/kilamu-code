import { posix } from 'node:path';
import { CONF, ResultBuilder, fileRef, joinRel, type ExtractContext, type ExtractResult } from './common.ts';

/**
 * Markdown / reStructuredText line scanner: headings become `heading`
 * symbols; links that resolve to project files become DOCUMENTS edges from
 * `doc:<rel>`. Fenced code blocks are skipped.
 */
export const PARSER_NAME = 'markdown-lines';
export const PARSER_VERSION = 1;

const ATX_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const MD_LINK_RE = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const MD_REF_RE = /^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/;
const RST_LINK_RE = /`[^`<]*<([^>`]+)>`_/g;
const RST_DIRECTIVE_RE = /^\s*\.\.\s+(?:include|literalinclude|image|figure)::\s*(\S+)/;
const RST_UNDERLINE_RE = /^([=\-~^"'`#*+.:_])\1{2,}\s*$/;

interface Heading {
  level: number;
  title: string;
  line: number;
}

function resolveLink(rel: string, target: string, ctx: ExtractContext | undefined): string | null {
  if (!ctx?.fileExists || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) return null;
  let clean: string;
  try {
    clean = decodeURIComponent(target.replace(/[#?].*$/, ''));
  } catch {
    return null;
  }
  if (!clean) return null;
  const resolved = clean.startsWith('/') ? joinRel('', clean.slice(1)) : joinRel(posix.dirname(rel), clean);
  return resolved && ctx.fileExists(resolved) ? resolved : null;
}

export function extract(rel: string, text: string, ctx?: ExtractContext): ExtractResult {
  const b = new ResultBuilder(rel);
  const rst = rel.toLowerCase().endsWith('.rst');
  const lines = text.split('\n');
  const headings: Heading[] = [];
  const rstLevels: string[] = [];
  const linked = new Set<string>();
  let fence: string | null = null;

  const link = (target: string, line: number) => {
    const resolved = resolveLink(rel, target, ctx);
    if (!resolved || resolved === rel || linked.has(resolved)) return;
    linked.add(resolved);
    b.edge(`doc:${rel}`, 'DOCUMENTS', fileRef(resolved), line, CONF.docLink);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '');
    const ln = i + 1;
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]![0]!;
      else if (fenceMatch[1]![0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (rst) {
      const next = lines[i + 1]?.replace(/\r$/, '') ?? '';
      const u = RST_UNDERLINE_RE.exec(next);
      if (u && line.trim() && !RST_UNDERLINE_RE.test(line) && next.trim().length >= line.trim().length) {
        if (!rstLevels.includes(u[1]!)) rstLevels.push(u[1]!);
        headings.push({ level: rstLevels.indexOf(u[1]!) + 1, title: line.trim(), line: ln });
        i++;
        continue;
      }
      const d = RST_DIRECTIVE_RE.exec(line);
      if (d) link(d[1]!, ln);
      for (const m of line.matchAll(RST_LINK_RE)) link(m[1]!.trim(), ln);
    } else {
      const h = ATX_RE.exec(line);
      if (h) headings.push({ level: h[1]!.length, title: h[2]!, line: ln });
      const r = MD_REF_RE.exec(line);
      if (r) link(r[1]!, ln);
    }
    for (const m of line.matchAll(MD_LINK_RE)) link(m[1]!, ln);
  }

  headings.forEach((h, k) => {
    const next = headings.slice(k + 1).find((o) => o.level <= h.level);
    const end = next ? next.line - 1 : lines.length;
    b.symbol(h.title, 'heading', h.line, end, `${'#'.repeat(h.level)} ${h.title}`, true);
  });
  return b.result();
}
