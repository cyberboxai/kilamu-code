/**
 * Minimal root-level .gitignore matcher used when git is unavailable.
 * Supports: comments, blank lines, `!` negation, trailing `/` (directory
 * only), leading or inner `/` (anchored to root), `*`, `?`, `**`, `[...]`.
 * Last matching rule wins, as in git. Not supported: nested .gitignore files,
 * escaped trailing spaces, and git's rule that a file inside an excluded
 * directory cannot be re-included (pruning makes that moot for the walker).
 */
interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

export interface IgnoreMatcher {
  ignores(rel: string, isDir: boolean): boolean;
}

function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        out += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
      } else {
        const body = glob.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\');
        out += `[${body}]`;
        i = close;
      }
    } else if (ch === '\\' && i + 1 < glob.length) {
      out += glob[i + 1]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      i++;
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return out;
}

function parseRule(raw: string): Rule | null {
  let line = raw.replace(/\r$/, '').replace(/\s+$/, '');
  if (!line || line.startsWith('#')) return null;
  let negate = false;
  if (line.startsWith('!')) {
    negate = true;
    line = line.slice(1);
  } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
    line = line.slice(1);
  }
  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (!line) return null;
  const anchored = line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);
  const body = globToRegex(line);
  // A pattern also matches everything below a matching directory.
  const re = new RegExp(anchored ? `^${body}(?:/.*)?$` : `(?:^|/)${body}(?:/.*)?$`);
  return { re, negate, dirOnly };
}

export function parseGitignore(text: string): IgnoreMatcher {
  const rules = text.split('\n').map(parseRule).filter((r): r is Rule => r !== null);
  return {
    ignores(rel: string, isDir: boolean): boolean {
      let ignored = false;
      for (const rule of rules) {
        // A directory-only rule applies to a file only through one of its ancestors.
        const subject = rule.dirOnly && !isDir ? rel.slice(0, Math.max(0, rel.lastIndexOf('/'))) : rel;
        if (subject && rule.re.test(subject)) ignored = !rule.negate;
      }
      return ignored;
    },
  };
}
