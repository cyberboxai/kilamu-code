import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectPaths } from '../../../src/core/paths.ts';
import { isTrusted, trust } from '../../../src/core/trust.ts';
import { openRuntime } from '../../../src/runtime.ts';

describe('data directory trust', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kil-trust-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('never opens or creates state without init', () => {
    expect(() => openRuntime({ root })).toThrow(/not initialized/);
  });

  it('ignores a .kilamu/ that was not created by init (e.g. shipped in a repo)', () => {
    mkdirSync(join(root, '.kilamu/state'), { recursive: true });
    expect(isTrusted(projectPaths(root))).toBe(false);
    expect(() => openRuntime({ root })).toThrow(/not initialized/);
  });

  it('a copied/cloned data dir with a forged token is not trusted', () => {
    openRuntime({ root, create: true }).close();
    const paths = projectPaths(root);
    writeFileSync(join(paths.dataDir, '.trust-token'), 'attacker-guess\n');
    expect(isTrusted(paths)).toBe(false);
  });

  it('trusts the directory after init, keyed to its secret token', () => {
    openRuntime({ root, create: true }).close();
    const paths = projectPaths(root);
    expect(isTrusted(paths)).toBe(true);
    openRuntime({ root }).close();
    // A swapped (re-created) directory has no token → untrusted, even if the inode number is reused.
    rmSync(paths.dataDir, { recursive: true, force: true });
    mkdirSync(paths.dataDir);
    expect(isTrusted(paths)).toBe(false);
    trust(paths);
    expect(isTrusted(paths)).toBe(true);
  });
});
