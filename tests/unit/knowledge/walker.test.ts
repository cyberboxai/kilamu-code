import { execFileSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseGitignore } from '../../../src/knowledge/gitignore.ts';
import { listProjectFiles } from '../../../src/knowledge/walker.ts';
import { tempProject } from './helpers.ts';

const OPTS = { respectGitignore: true, maxFiles: 1000, maxFileBytes: 10_000 };

function sampleProject() {
  return tempProject({
    'src/index.ts': 'export const a = 1;\n',
    'src/big.txt': 'x'.repeat(20_000),
    'src/image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]),
    'docs/manual.pdf': Buffer.from('%PDF-1.4\n\x00binary-ish'),
    '.env': 'SECRET=1\n',
    '.env.example': 'SECRET=\n',
    'keys/id_rsa': 'private\n',
    'config/server.pem': 'cert\n',
    'node_modules/pkg/index.js': 'module.exports = 1;\n',
    'dist/out.js': 'built\n',
    'logs/app.log': 'log\n',
    'tmp/keep.txt': 'keep\n',
    'tmp/drop.txt': 'drop\n',
    'build-notes.md': '# notes\n',
    '.gitignore': '*.log\n/tmp/*\n!/tmp/keep.txt\nbuild-notes.md\n',
  });
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe.each([
  { mode: 'fallback walker', git: false },
  { mode: 'git ls-files', git: true },
])('listProjectFiles ($mode)', ({ git }) => {
  it('applies the exclusion policy', async () => {
    const p = sampleProject();
    cleanup = p.cleanup;
    symlinkSync(join(p.root, 'src/index.ts'), join(p.root, 'src/link.ts'));
    if (git) execFileSync('git', ['init', '-q'], { cwd: p.root });

    const r = await listProjectFiles(p.root, OPTS);
    const rels = r.files.map((f) => f.rel);
    const reason = (rel: string) => r.skipped.find((s) => s.rel === rel)?.reason;

    expect(rels).toContain('src/index.ts');
    expect(rels).toContain('docs/manual.pdf');
    expect(rels).toContain('.env.example');
    expect(rels).toContain('tmp/keep.txt');
    expect(rels).toEqual([...rels].sort());

    for (const excluded of ['.env', 'keys/id_rsa', 'config/server.pem', 'node_modules/pkg/index.js', 'dist/out.js', 'src/link.ts', 'src/big.txt', 'src/image.png', 'logs/app.log', 'tmp/drop.txt', 'build-notes.md']) {
      expect(rels, excluded).not.toContain(excluded);
    }
    expect(reason('.env')).toBe('sensitive');
    expect(reason('keys/id_rsa')).toBe('sensitive');
    expect(reason('src/link.ts')).toBe('symlink');
    expect(reason('src/image.png')).toBe('binary');
    expect(reason('src/big.txt')).toMatch(/^too-large/);
    expect(reason('node_modules/pkg/index.js')).toBeUndefined();
  });
});

describe('listProjectFiles caps', () => {
  it('reports overflow beyond maxFiles in skipped', async () => {
    const p = tempProject({ 'a.ts': '1', 'b.ts': '2', 'c.ts': '3' });
    cleanup = p.cleanup;
    const r = await listProjectFiles(p.root, { ...OPTS, respectGitignore: false, maxFiles: 2 });
    expect(r.files.map((f) => f.rel)).toEqual(['a.ts', 'b.ts']);
    expect(r.skipped).toEqual([{ rel: 'c.ts', reason: 'max-files (2)' }]);
  });

  it('ignores .gitignore when respectGitignore is off', async () => {
    const p = tempProject({ 'x.log': 'l', '.gitignore': '*.log\n' });
    cleanup = p.cleanup;
    const r = await listProjectFiles(p.root, { ...OPTS, respectGitignore: false });
    expect(r.files.map((f) => f.rel)).toContain('x.log');
  });
});

describe('parseGitignore', () => {
  const m = parseGitignore(['# comment', '', '*.tmp', 'build/', '/root-only.txt', 'docs/**/draft.md', '!keep.tmp', 'a?c'].join('\n'));
  it.each([
    ['x.tmp', false, true],
    ['deep/x.tmp', false, true],
    ['keep.tmp', false, false],
    ['build', true, true],
    ['build', false, false],
    ['src/build/x.js', false, true],
    ['root-only.txt', false, true],
    ['sub/root-only.txt', false, false],
    ['docs/draft.md', false, true],
    ['docs/a/b/draft.md', false, true],
    ['abc', false, true],
    ['abbc', false, false],
  ])('%s (dir=%s) → ignored=%s', (rel, isDir, expected) => {
    expect(m.ignores(rel, isDir)).toBe(expected);
  });
});
