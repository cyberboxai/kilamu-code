/**
 * Guards the A/B benchmark fixtures: every task must be unsolved as shipped,
 * solvable (its reference solution passes the unchanged tests), and must not
 * ship ignored local state. Reference solutions live outside the fixture
 * directory so no trial can read them.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFiles, hashTree, listGitVisible } from '../../scripts/ab-lib.ts';

const REPO = resolve(import.meta.dirname, '..', '..');
const FIXTURES = join(REPO, 'tests', 'fixtures', 'ab');
const SOLUTIONS = join(REPO, 'tests', 'fixtures', 'ab-solutions');
const TASKS = readdirSync(FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

function nodeTest(dir: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' } });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function trialCopy(task: string): string {
  const src = join(FIXTURES, task);
  const dir = mkdtempSync(join(tmpdir(), `kilamu-ab-fx-${task}-`));
  copyFiles(src, listGitVisible(REPO, src), dir);
  return dir;
}

describe('A/B fixtures', () => {
  it('has the seven task kinds the protocol needs', () => {
    expect(TASKS).toEqual(['bugfix-pagination', 'feature-slugify', 'log-triage', 'multi-feature', 'refactor-rename', 'schema-rename', 'security-fix']);
  });

  describe.each(TASKS)('%s', (task) => {
    it('ships a TASK.md, a node --test package and a test/ directory, and no ignored state', () => {
      const files = listGitVisible(REPO, join(FIXTURES, task));
      expect(files).toContain('TASK.md');
      expect(JSON.parse(readFileSync(join(FIXTURES, task, 'package.json'), 'utf8')).scripts.test).toBe('node --test');
      expect(files.some((f) => f.startsWith('test/'))).toBe(true);
      expect(files.filter((f) => /(^|\/)(\.omc|\.kilamu|node_modules|\.claude)\//.test(f))).toEqual([]);
      const withMarkers = files.filter((f) => /\bTODO\b|\bFIXME\b/.test(readFileSync(join(FIXTURES, task, f), 'utf8')));
      expect(withMarkers, 'stubs must not carry TODO/FIXME markers').toEqual([]);
    });

    it('ships every file and directory its TASK.md refers to', () => {
      const files = listGitVisible(REPO, join(FIXTURES, task));
      const text = readFileSync(join(FIXTURES, task, 'TASK.md'), 'utf8');
      const refs = [...text.matchAll(/(?:^|[\s`(*"'])((?:[\w.-]+\/)+[\w.-]*)/g)]
        .map((m) => m[1]!.replace(/^\.\//, '').replace(/[.,:;]+$/, ''))
        .filter((r) => r !== '');
      expect(refs.length, 'TASK.md should name at least one path').toBeGreaterThan(0);
      const missing = refs.filter((r) => (r.endsWith('/') ? !files.some((f) => f.startsWith(r)) : !files.includes(r)));
      expect(missing, 'paths named in TASK.md but not shipped (ignored by .gitignore?)').toEqual([]);
    });

    it('fails as shipped and passes with the reference solution, without touching test/', () => {
      expect(existsSync(join(SOLUTIONS, task)), `missing reference solution for ${task}`).toBe(true);
      expect(existsSync(join(SOLUTIONS, task, 'test')), 'a solution must not replace tests').toBe(false);
      const dir = trialCopy(task);
      try {
        const testsBefore = hashTree(join(dir, 'test'));
        expect(nodeTest(dir).status, 'fixture must start unsolved').not.toBe(0);
        cpSync(join(SOLUTIONS, task), dir, { recursive: true });
        const after = nodeTest(dir);
        expect(after.status, after.out.slice(-2000)).toBe(0);
        expect(hashTree(join(dir, 'test'))).toBe(testsBefore);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  });
});
