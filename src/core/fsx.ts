import { randomBytes } from 'node:crypto';
import { closeSync, constants, copyFileSync, lstatSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KilamuError } from './errors.ts';

/**
 * Symlink-safe file writes (security review round 2, N2/N3).
 *
 * Temp files use an unpredictable name and O_CREAT|O_EXCL|O_NOFOLLOW, so a
 * planted symlink at the temp path makes the write fail instead of writing
 * through it. The final rename replaces the directory entry (it never follows
 * a symlink at the destination). Callers that must not replace a symlinked
 * destination at all pass `refuseSymlinkTarget`.
 */
export function writeFileAtomic(file: string, data: string, opts: { mode?: number; refuseSymlinkTarget?: boolean } = {}): void {
  const parent = dirname(file);
  if (isSymlink(parent)) throw new KilamuError('UNSAFE_PATH', `Refusing to write into symlinked directory ${parent}`);
  if (opts.refuseSymlinkTarget && isSymlink(file)) throw new KilamuError('UNSAFE_PATH', `Refusing to replace symlink ${file}`);
  const tmp = join(parent, `.${randomBytes(12).toString('hex')}.kilamu-tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, opts.mode ?? 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Create a NEW file; fails if anything (including a dangling symlink) exists at the path. */
export function writeFileExclusive(file: string, data: string, mode = 0o600): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** Copy to a NEW destination only (never through an existing file or symlink). */
export function copyFileExclusive(src: string, dest: string): void {
  copyFileSync(src, dest, constants.COPYFILE_EXCL);
}

export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
