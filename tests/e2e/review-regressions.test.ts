import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Regression tests for defects reproduced by the 0.1.0 architecture, security
 * and code reviews. Each drives the real launcher, like Claude would.
 */
const BIN = resolve(import.meta.dirname, '..', '..', 'bin', 'kilamu');
let root: string;

function k(args: string[], input?: string): { code: number; out: string; err: string } {
  const r = spawnSync(BIN, args, {
    cwd: root, input, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, KILAMU_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root, NO_COLOR: '1' },
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

function git(args: string[]): void {
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root });
}

function plan(obj: unknown, name = 'p.json'): string {
  writeFileSync(join(root, '.kilamu/cache', name), JSON.stringify(obj));
  return `.kilamu/cache/${name}`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kilamu-regress-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }));
  git(['init', '-q']);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('review regressions', { timeout: 240_000 }, () => {
  it('commands never create state in uninitialized directories; --help never executes', () => {
    expect(k(['status']).code).toBe(1);
    expect(k(['init', '--help']).code).toBe(0);
    expect(k(['statusline', 'install', '--help']).code).toBe(0);
    expect(existsSync(join(root, '.kilamu'))).toBe(false);
    expect(existsSync(join(root, '.claude'))).toBe(false);
  });

  it('a .kilamu/ shipped in the repository is ignored by hooks and refused by init', () => {
    mkdirSync(join(root, '.kilamu/logs'), { recursive: true });
    writeFileSync(join(root, '.kilamu/config.json'), '{"$(id)": 1}');
    git(['add', '-f', '.kilamu/config.json']);
    const hook = k(['hook', 'session-start'], JSON.stringify({ session_id: 's', source: 'startup', cwd: root }));
    expect(hook.code).toBe(0);
    expect(hook.out).toBe('');
    expect(existsSync(join(root, '.kilamu/logs/kilamu.jsonl'))).toBe(false);
    const init = k(['init']);
    expect(init.code).toBe(1);
    expect(init.err).toMatch(/tracked by git/);
  });

  it('rejects plans whose verification commands could run arbitrary code', () => {
    k(['init']);
    for (const command of ["npm exec -c 'echo pwned > pwned.txt'", 'npx cowsay', 'node -pe 1', "git -c alias.x=!id x"]) {
      const r = k(['plan', 'create', '--file', plan({ objective: `bad ${command}`, tasks: [{ id: 'T1', files: ['a.js'], acceptance: [{ kind: 'command', command }] }] })]);
      expect(r.code, command).toBe(1);
      expect(r.err).toMatch(/verification commands not allowed/);
    }
    expect(existsSync(join(root, 'pwned.txt'))).toBe(false);
  });

  it('bounds retries, blocks self-attestation after release, and keeps verify idempotent', () => {
    k(['init']);
    const p = plan({ objective: 'attest', tasks: [{ id: 'T1', files: ['a.js'], maxRetries: 1, acceptance: [{ kind: 'attestation', description: 'reviewed' }] }] });
    expect(k(['plan', 'create', '--file', p]).code).toBe(0);
    expect(k(['task', 'start', 'T1', '--owner', 'dev1']).code).toBe(0);
    expect(k(['task', 'release', 'T1', '--reason', 'stalled']).code).toBe(0);
    // owner is cleared by release, but dev1 still started an attempt → cannot attest.
    const self = k(['verify', 'T1', '--attest', 'T1.c1=looks fine', '--as', 'dev1']);
    expect(self.code).toBe(1);
    expect(self.err).toMatch(/cannot attest its own work/);
    // READY without verify-first cannot be verified without a new attempt.
    expect(k(['verify', 'T1']).err).toMatch(/needs a started attempt/);
    expect(k(['task', 'start', 'T1', '--owner', 'dev1']).code).toBe(0);
    expect(k(['verify', 'T1', '--attest', 'T1.c1=read the diff', '--as', 'reviewer']).code).toBe(0);
    const again = k(['verify', 'T1']);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/already VERIFIED/);
  });

  it('refuses sensitive files and never echoes their content in errors', () => {
    k(['init']);
    writeFileSync(join(root, '.env'), 'DB_PASS=Sup3rS3cr3tValue\n');
    const put = k(['artifact', 'put', '--file', '.env']);
    expect(put.code).toBe(1);
    expect(put.err).toMatch(/sensitive/);
    const planEnv = k(['plan', 'create', '--file', '.env', '--json']);
    expect(planEnv.out + planEnv.err).not.toContain('Sup3rS3cr3t');
  });

  it('quotes task titles safely in agent briefs', () => {
    k(['init']);
    k(['plan', 'create', '--file', plan({ objective: 'q', tasks: [{ id: 'T1', title: 'Setup $(id>/tmp/pwn) it\'s', files: ['a.js'], acceptance: [{ kind: 'file_exists', path: 'a.js' }] }] })]);
    const brief = k(['brief', 'T1']).out;
    expect(brief).toContain("kilamu context 'Setup $(id>/tmp/pwn) it'\\''s' --task T1");
  });

  it('parses --json anywhere and keeps the database private', () => {
    k(['init']);
    expect(JSON.parse(k(['config', '--json', 'get', 'execution.maxRetries']).out)).toBe(2);
    expect(Array.isArray(JSON.parse(k(['execution', '--json']).out))).toBe(true);
    expect(statSync(join(root, '.kilamu/state/execution.db')).mode & 0o077).toBe(0);
  });

  it('doctor exits non-zero when a check fails', () => {
    mkdirSync(join(root, '.kilamu'));
    const r = k(['doctor']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not created by `kilamu init`/);
  });
});
