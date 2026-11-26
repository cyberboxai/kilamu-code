import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { writeFileAtomic } from './fsx.ts';
import { join } from 'node:path';
import { KilamuError } from './errors.ts';
import { sha256 } from './ids.ts';
import { userConfigDir, type ProjectPaths } from './paths.ts';

/**
 * Trust boundary for project data directories (security review H2).
 *
 * A `.kilamu/` directory that arrives with a cloned repository is attacker-
 * controlled: its database can inject orientation text, its config can change
 * behaviour, and symlinks inside it can redirect writes. Kilamu therefore only
 * uses a data directory that `kilamu init` registered in the USER-scope trust
 * file. The entry binds the realpath to a random secret token stored inside
 * the directory (`.trust-token`, 0600): a re-created, swapped or cloned
 * directory cannot carry the token (inode numbers are reused, so they are not
 * a sufficient identity). Hooks and the statusline ignore untrusted dirs.
 */
interface TrustEntry {
  path: string;
  /** sha256 of the token file content. */
  tokenHash: string;
  trustedAt: string;
}

const TOKEN_FILE = '.trust-token';

function trustFile(): string {
  return join(userConfigDir(), 'trusted-projects.json');
}

function readEntries(): TrustEntry[] {
  const f = trustFile();
  if (!existsSync(f)) return [];
  try {
    const v = JSON.parse(readFileSync(f, 'utf8')) as { entries?: unknown };
    return Array.isArray(v.entries) ? (v.entries as TrustEntry[]).filter((e) => typeof e?.path === 'string' && typeof e?.tokenHash === 'string') : [];
  } catch {
    return [];
  }
}

/** Real path of a plain (non-symlink) directory, or null. */
function realDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const l = lstatSync(dir);
  if (l.isSymbolicLink() || !l.isDirectory()) return null;
  return realpathSync(dir);
}

function readToken(dir: string): string | null {
  const f = join(dir, TOKEN_FILE);
  try {
    const l = lstatSync(f);
    if (!l.isFile()) return null;
    return readFileSync(f, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function isTrusted(paths: ProjectPaths): boolean {
  const path = realDir(paths.dataDir);
  if (!path) return false;
  const token = readToken(paths.dataDir);
  if (!token) return false;
  const hash = sha256(token);
  return readEntries().some((e) => e.path === path && e.tokenHash === hash);
}

/** Data dir exists AND was registered by `kilamu init`. Cheap: two stats and one small JSON read. */
export function isInitialized(paths: ProjectPaths): boolean {
  return isTrusted(paths);
}

/** Register the data dir: (re)generate its secret token and record its hash with the realpath. */
export function trust(paths: ProjectPaths): void {
  const path = realDir(paths.dataDir);
  if (!path) throw new KilamuError('UNSAFE_PATH', `Cannot trust ${paths.dataDir}: missing, not a directory, or a symlink`);
  const tokenFile = join(paths.dataDir, TOKEN_FILE);
  if (existsSync(tokenFile) && !lstatSync(tokenFile).isFile()) throw new KilamuError('UNSAFE_PATH', `Refusing non-regular ${tokenFile}`);
  const token = randomBytes(32).toString('hex');
  writeFileAtomic(tokenFile, `${token}\n`, { refuseSymlinkTarget: true });
  const entries = readEntries().filter((e) => e.path !== path);
  entries.push({ path, tokenHash: sha256(token), trustedAt: new Date().toISOString() });
  mkdirSync(userConfigDir(), { recursive: true, mode: 0o700 });
  writeFileAtomic(trustFile(), `${JSON.stringify({ entries }, null, 2)}\n`, { refuseSymlinkTarget: true });
}
