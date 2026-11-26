import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../core/exec.ts';
import { sha256 } from '../core/ids.ts';
import { isInside } from '../core/paths.ts';

/** Small git helpers used for checkpoints and reconciliation. All read-only. */

/**
 * Neutralize repository-local config that can execute programs during
 * read-only commands (e.g. core.fsmonitor in a cloned/archived repo's .git/config).
 */
export const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

export async function gitHead(root: string): Promise<string | null> {
  const r = await run(['git', ...SAFE_GIT, 'rev-parse', 'HEAD'], { cwd: root, timeoutMs: 10_000, maxOutputBytes: 4096 });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/** sha256 per owned path (files only; directory entries ending in "/" are expanded lazily by callers). */
export function hashFiles(root: string, files: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of files) {
    if (f.endsWith('/')) continue;
    const abs = join(root, f);
    if (!isInside(root, abs)) continue;
    try {
      out[f] = existsSync(abs) && statSync(abs).isFile() ? sha256(readFileSync(abs)) : null;
    } catch {
      out[f] = null;
    }
  }
  return out;
}

/** Owned files whose content differs from the checkpoint snapshot. */
export function changedSince(root: string, snapshot: Record<string, string | null>): string[] {
  const now = hashFiles(root, Object.keys(snapshot));
  return Object.keys(snapshot).filter((f) => now[f] !== snapshot[f]).sort();
}
