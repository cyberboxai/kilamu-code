import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { run } from '../core/exec.ts';
import { isIgnoredDir, isSensitivePath } from '../core/paths.ts';
import { parseGitignore, type IgnoreMatcher } from './gitignore.ts';

/**
 * Project file enumeration (directive §10, §17). Applies the exclusion policy
 * every indexed file must pass: no sensitive paths, no symlinks, no ignored
 * directories, no oversized or binary files.
 */
export interface WalkOptions {
  respectGitignore: boolean;
  maxFiles: number;
  maxFileBytes: number;
}

export interface WalkedFile {
  rel: string;
  size: number;
  mtimeMs: number;
}

export interface WalkResult {
  files: WalkedFile[];
  skipped: Array<{ rel: string; reason: string }>;
}

const BINARY_PROBE_BYTES = 8192;

/**
 * List indexable files under `root`, sorted by path. Async because the git
 * listing goes through core/exec `run` (no shell).
 */
export async function listProjectFiles(root: string, opts: WalkOptions): Promise<WalkResult> {
  const candidates = (opts.respectGitignore ? await gitListing(root) : null) ?? walkTree(root, opts.respectGitignore);
  const result: WalkResult = { files: [], skipped: [] };
  for (const rel of [...new Set(candidates)].sort()) {
    if (rel.split('/').slice(0, -1).some(isIgnoredDir)) continue;
    const reason = exclusionReason(root, rel, opts.maxFileBytes, result);
    if (reason) result.skipped.push({ rel, reason });
  }
  if (result.files.length > opts.maxFiles) {
    for (const f of result.files.slice(opts.maxFiles)) result.skipped.push({ rel: f.rel, reason: `max-files (${opts.maxFiles})` });
    result.files = result.files.slice(0, opts.maxFiles);
  }
  return result;
}

/** Returns null when the file is accepted (and appended to `out.files`), else the skip reason. */
function exclusionReason(root: string, rel: string, maxFileBytes: number, out: WalkResult): string | null {
  if (isSensitivePath(rel)) return 'sensitive';
  let st: Stats;
  try {
    st = lstatSync(join(root, rel));
  } catch {
    return 'missing';
  }
  if (st.isSymbolicLink()) return 'symlink';
  if (!st.isFile()) return 'not-a-file';
  if (st.size > maxFileBytes) return `too-large (${st.size} > ${maxFileBytes})`;
  if (!rel.toLowerCase().endsWith('.pdf')) {
    const probe = readHead(join(root, rel), Math.min(st.size, BINARY_PROBE_BYTES));
    if (probe === null) return 'unreadable';
    if (probe.includes(0)) return 'binary';
  }
  out.files.push({ rel, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
  return null;
}

function readHead(abs: string, bytes: number): Buffer | null {
  if (bytes === 0) return Buffer.alloc(0);
  let fd: number | null = null;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** `git ls-files` listing, or null when root is not inside a git work tree or git is missing. */
async function gitListing(root: string): Promise<string[] | null> {
  const probe = await run(['git', '-c', 'core.fsmonitor=false', 'rev-parse', '--is-inside-work-tree'], { cwd: root, timeoutMs: 10_000, maxOutputBytes: 4096 });
  if (probe.exitCode !== 0 || probe.stdout.trim() !== 'true') return null;
  const ls = await run(['git', '-c', 'core.fsmonitor=false', 'ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, timeoutMs: 60_000, maxOutputBytes: 64 * 1024 * 1024 });
  if (ls.exitCode !== 0 || ls.truncated) return null;
  return ls.stdout.split('\0').filter(Boolean);
}

/** Recursive walk honouring IGNORED_DIRS and, optionally, the root .gitignore. */
function walkTree(root: string, respectGitignore: boolean): string[] {
  const giFile = join(root, '.gitignore');
  const matcher: IgnoreMatcher | null = respectGitignore && existsSync(giFile) ? parseGitignore(safeRead(giFile)) : null;
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0) {
    const dirRel = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(join(root, dirRel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (isIgnoredDir(e.name) || matcher?.ignores(rel, true)) continue;
        stack.push(rel);
      } else if (!matcher?.ignores(rel, false)) {
        // Symlinks and special files are reported by exclusionReason.
        out.push(rel);
      }
    }
  }
  return out;
}

function safeRead(abs: string): string {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}
