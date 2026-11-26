import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * End-to-end: drives the real `bin/kilamu` launcher against a throwaway git
 * project, exactly as Claude would through the Bash tool.
 */
const BIN = resolve(import.meta.dirname, '..', '..', 'bin', 'kilamu');

let root: string;

function k(args: string[], input?: string, extraEnv: Record<string, string> = { KILAMU_SESSION_ID: 's1' }): { code: number; out: string; err: string } {
  const r = spawnSync(BIN, args, {
    cwd: root,
    input,
    encoding: 'utf8',
    env: { ...process.env, KILAMU_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root, NO_COLOR: '1', ...extraEnv },
    timeout: 120_000,
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

function kj<T = Record<string, unknown>>(args: string[], input?: string): T {
  const r = k([...args, '--json'], input);
  if (r.code !== 0 && r.code !== 1) throw new Error(`kilamu ${args.join(' ')} failed (${r.code}): ${r.err}${r.out}`);
  return JSON.parse(r.out) as T;
}

function git(args: string[]): void {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kilamu-e2e-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }, null, 2));
  writeFileSync(join(root, 'src/math.js'), 'export function sum(a, b) {\n  return a + b;\n}\n');
  writeFileSync(join(root, 'README.md'), '# Demo\n\nSee [math](src/math.js).\n');
  writeFileSync(join(root, '.env'), 'API_KEY=sk-ant-THIS_MUST_NEVER_BE_INDEXED_0123456789\n');
  git(['init', '-q']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('kilamu CLI end-to-end', { timeout: 240_000 }, () => {
  it('reports capabilities without creating state', () => {
    const r = k(['doctor']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/node/i);
    expect(existsSync(join(root, '.kilamu'))).toBe(false);
    const dry = k(['init', '--dry-run']);
    expect(dry.out).toMatch(/Dry run/);
    expect(existsSync(join(root, '.kilamu'))).toBe(false);
  });

  it('hooks are no-ops before init', () => {
    const r = k(['hook', 'session-start'], JSON.stringify({ session_id: 's0', source: 'startup', cwd: root }));
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(existsSync(join(root, '.kilamu'))).toBe(false);
  });

  it('initializes, indexes and never indexes secrets', () => {
    expect(k(['init']).code).toBe(0);
    expect(readFileSync(join(root, '.kilamu/.gitignore'), 'utf8')).toMatch(/^\*$/m);
    const stats = kj<{ indexed: number }>(['index']);
    expect(stats.indexed).toBeGreaterThanOrEqual(3);
    const hits = kj<unknown[]>(['search', 'THIS_MUST_NEVER_BE_INDEXED']);
    expect(hits).toEqual([]);
    const sym = kj<Array<{ name: string }>>(['symbols', 'sum']);
    expect(sym.some((s) => s.name === 'sum')).toBe(true);
  });

  it('plans, executes, verifies and completes a real task', () => {
    const plan = {
      objective: 'Add a multiply function with tests',
      tasks: [
        {
          id: 'T1', title: 'Implement multiply', description: 'Add multiply(a,b) to src/math.js', role: 'developer', taskClass: 'implementation', complexity: 'small',
          files: ['src/math.js', 'test/math.test.js'],
          acceptance: [
            { kind: 'command', command: 'npm test' },
            { kind: 'file_contains', path: 'src/math.js', pattern: 'export function multiply' },
          ],
        },
        {
          id: 'T2', title: 'Document multiply', description: 'Mention multiply in README', role: 'developer', taskClass: 'implementation', complexity: 'trivial',
          dependsOn: ['T1'], files: ['README.md'],
          acceptance: [{ kind: 'file_contains', path: 'README.md', pattern: 'multiply' }],
        },
      ],
    };
    writeFileSync(join(root, '.kilamu/cache/plan.json'), JSON.stringify(plan));
    const created = kj<{ execution: { id: string; mode: string } }>(['plan', 'create', '--file', '.kilamu/cache/plan.json']);
    expect(created.execution.mode).toBe('SINGLE');

    const next = kj<{ ready: Array<{ taskId: string; prompt: string }> }>(['next']);
    expect(next.ready.map((b) => b.taskId)).toEqual(['T1']);
    expect(next.ready[0]!.prompt).toMatch(/Files you own/);

    // An agent cannot claim completion: verify on an unstarted task is refused.
    expect(k(['verify', 'T1']).code).not.toBe(0);

    expect(k(['task', 'start', 'T1']).code).toBe(0);
    // First attempt: implementation present but test fails → FAILED → READY (retry).
    writeFileSync(join(root, 'src/math.js'), 'export function sum(a, b) {\n  return a + b;\n}\nexport function multiply(a, b) {\n  return a + b;\n}\n');
    writeFileSync(join(root, 'test/math.test.js'), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { multiply } from '../src/math.js';\ntest('multiply', () => assert.strictEqual(multiply(3, 4), 12));\n");
    expect(k(['task', 'submit', 'T1', '--summary', 'added multiply']).code).toBe(0);
    const v1 = k(['verify', 'T1']);
    expect(v1.code).toBe(1);
    expect(v1.out).toMatch(/FAIL/);
    expect(v1.out).toMatch(/READY/);

    // Second attempt fixes the bug → VERIFIED with evidence.
    expect(k(['task', 'start', 'T1']).code).toBe(0);
    writeFileSync(join(root, 'src/math.js'), 'export function sum(a, b) {\n  return a + b;\n}\nexport function multiply(a, b) {\n  return a * b;\n}\n');
    expect(k(['task', 'submit', 'T1', '--summary', 'fixed multiply']).code).toBe(0);
    const v2 = k(['verify', 'T1']);
    expect(v2.code).toBe(0);
    expect(v2.out).toMatch(/VERIFIED/);

    // T2 is now ready; complete it.
    expect(kj<{ ready: Array<{ taskId: string }> }>(['next']).ready.map((b) => b.taskId)).toEqual(['T2']);
    expect(k(['task', 'start', 'T2']).code).toBe(0);
    writeFileSync(join(root, 'README.md'), '# Demo\n\nSee [math](src/math.js): sum and multiply.\n');
    k(['task', 'submit', 'T2', '--summary', 'documented']);
    expect(k(['verify', 'T2']).code).toBe(0);

    const report = k(['report']);
    expect(report.out).toMatch(/FINAL STATUS: VERIFIED/);
    expect(report.out).toMatch(/UNAVAILABLE|MEASURED/);
  });

  it('gates agent-team task completion on verification', () => {
    const plan = { objective: 'Gate test', tasks: [{ id: 'G1', title: 'gate', files: ['src/gate.js'], acceptance: [{ kind: 'file_exists', path: 'src/gate.js' }] }] };
    writeFileSync(join(root, '.kilamu/cache/gate.json'), JSON.stringify(plan));
    expect(k(['plan', 'create', '--file', '.kilamu/cache/gate.json']).code).toBe(0);
    const blocked = k(['hook', 'task-completed'], JSON.stringify({ task_subject: '[kilamu:G1] gate', cwd: root }));
    expect(blocked.code).toBe(2);
    expect(blocked.err).toMatch(/not VERIFIED/);
    const untracked = k(['hook', 'task-completed'], JSON.stringify({ task_subject: 'some other task', cwd: root }));
    expect(untracked.code).toBe(0);
  });

  it('recovers an interrupted task without blind replay', () => {
    expect(k(['task', 'start', 'G1', '--owner', 'kilamu-code:developer']).code).toBe(0);
    writeFileSync(join(root, 'src/gate.js'), 'export const gate = true;\n');
    // A different live session starting does NOT steal the task...
    const other = k(['hook', 'session-start'], JSON.stringify({ session_id: 's2', source: 'startup', cwd: root }));
    expect(JSON.parse(other.out).hookSpecificOutput.additionalContext).toMatch(/another session may still own them/);
    // ...but once session s1 has ended, the next session reconciles it.
    expect(k(['hook', 'session-end'], JSON.stringify({ session_id: 's1', reason: 'prompt_input_exit', cwd: root })).code).toBe(0);
    const r = k(['hook', 'session-start'], JSON.stringify({ session_id: 's3', source: 'startup', cwd: root }));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext).toMatch(/Verify first \(owned files changed\): G1/);
    // Work already on disk is verified rather than redone.
    expect(k(['task', 'submit', 'G1', '--summary', 'recovered']).code).toBe(0);
    expect(k(['verify', 'G1']).code).toBe(0);
    const ok = k(['hook', 'task-completed'], JSON.stringify({ task_subject: '[kilamu:G1] gate', cwd: root }));
    expect(ok.code).toBe(0);
  });

  it('compresses large output into an artifact and serves line ranges', () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `ok ${i} step passed`);
    lines[2500] = 'Error: connection refused at db.connect (src/db.js:42:7)';
    const r = kj<{ artifactId: string; findings: Array<{ text: string; lineStart?: number }> }>(['compress', '--source', 'npm test', '--exit-code', '1'], lines.join('\n'));
    expect(r.findings.some((f) => /connection refused/.test(f.text))).toBe(true);
    const show = k(['artifact', 'show', r.artifactId, '--lines', '2500-2502']);
    expect(show.out).toMatch(/connection refused/);
  });

  it('renders a statusline from real payload data', () => {
    const payload = { session_id: 's1', model: { display_name: 'Opus' }, workspace: { project_dir: root }, cost: { total_cost_usd: 0.12, total_duration_ms: 5000 }, context_window: { total_input_tokens: 12000, total_output_tokens: 3000, used_percentage: 7 } };
    const r = k(['statusline'], JSON.stringify(payload));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/KILAMU/);
    expect(r.out).toMatch(/Opus/);
    const usage = k(['usage']);
    expect(usage.out).toMatch(/MEASURED/);
  });

  it('pre-compact prints preservation instructions', () => {
    const plan = { objective: 'Compact test', tasks: [{ id: 'C1', title: 'c', files: ['src/c.js'], acceptance: [{ kind: 'file_exists', path: 'src/c.js' }] }] };
    writeFileSync(join(root, '.kilamu/cache/c.json'), JSON.stringify(plan));
    k(['plan', 'create', '--file', '.kilamu/cache/c.json']);
    const r = k(['hook', 'pre-compact'], JSON.stringify({ trigger: 'auto', cwd: root }));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Preserve Kilamu Code execution state/);
  });
});
