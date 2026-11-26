import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyFiles, hashTree, listFixtureFiles, parseStream, prng, shuffle } from '../../scripts/ab-lib.ts';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'kilamu-ab-lib-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const write = (root: string, rel: string, body = rel): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), body);
};

const lines = (...events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n');
const toolUse = (name: string, input: Record<string, unknown>, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_use', name, input }] },
});

describe('parseStream', () => {
  it('extracts the result event, loaded plugins and MCP server count', () => {
    const s = parseStream(lines(
      { type: 'system', subtype: 'init', plugins: [{ name: 'kilamu-code', path: '/x' }, 'other'], mcp_servers: [{ name: 'a' }, { name: 'b' }] },
      { type: 'result', total_cost_usd: 0.12, num_turns: 3 },
    ));
    expect(s.result).toEqual({ type: 'result', total_cost_usd: 0.12, num_turns: 3 });
    expect(s.plugins).toEqual(['kilamu-code', 'other']);
    expect(s.mcpServers).toBe(2);
    expect(s.badLines).toBe(0);
  });

  it('reports null (not zero) when the init event lacks plugin or MCP fields', () => {
    const s = parseStream(lines({ type: 'system', subtype: 'init' }));
    expect(s.plugins).toBeNull();
    expect(s.mcpServers).toBeNull();
    expect(s.result).toBeNull();
  });

  it('counts kilamu CLI calls only when kilamu is the command being run', () => {
    const s = parseStream(lines(
      toolUse('Bash', { command: 'kilamu status --json' }),
      toolUse('Bash', { command: 'npm test 2>&1 | kilamu compress --source "npm test"' }),
      toolUse('Bash', { command: 'cd /p && kilamu verify T1' }),
      toolUse('Bash', { command: 'echo $(kilamu version)' }),
      toolUse('Bash', { command: 'echo kilamu' }),
      toolUse('Bash', { command: 'ls .kilamu/state' }),
      toolUse('Bash', { command: 'cat kilamu-code/README.md' }),
    ));
    expect(s.engagement.kilamuCliCalls).toBe(4);
  });

  it('counts Kilamu skills and main-agent subagent calls, ignoring nested subagent traffic', () => {
    const s = parseStream(lines(
      toolUse('Skill', { skill: 'kilamu-code:orchestrate' }),
      toolUse('Skill', { skill: 'other-plugin:thing' }),
      toolUse('Agent', { subagent_type: 'kilamu-code:developer', prompt: 'x' }),
      toolUse('Task', { subagent_type: 'general-purpose', prompt: 'y' }),
      toolUse('Agent', { prompt: 'nested' }, 'toolu_parent'),
      toolUse('Bash', { command: 'kilamu status' }, 'toolu_parent'),
    ));
    expect(s.engagement).toEqual({ subagentCalls: 2, kilamuCliCalls: 0, kilamuSkills: ['kilamu-code:orchestrate'] });
  });

  it('counts unparseable lines instead of throwing', () => {
    const s = parseStream(`not json\n\n${JSON.stringify({ type: 'result' })}\n{"broken"`);
    expect(s.badLines).toBe(2);
    expect(s.result).toEqual({ type: 'result' });
  });
});

describe('hashTree', () => {
  it('is stable and detects edits, additions, deletions and renames in nested directories', () => {
    const d = tmp();
    write(d, 'a.test.js', 'one');
    write(d, 'data/x.json', '{}');
    const base = hashTree(d);
    expect(hashTree(d)).toBe(base);

    write(d, 'data/x.json', '{"a":1}');
    const edited = hashTree(d);
    expect(edited).not.toBe(base);

    write(d, 'data/y.json', '{}');
    expect(hashTree(d)).not.toBe(edited);
    rmSync(join(d, 'data', 'y.json'));
    expect(hashTree(d)).toBe(edited);

    const e = tmp();
    write(e, 'a.test.js', 'one');
    write(e, 'data/z.json', '{"a":1}');
    expect(hashTree(e)).not.toBe(edited);
  });
});

describe('prng and shuffle', () => {
  it('reproduces the same sequence from the same seed', () => {
    const a = prng(42);
    const b = prng(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(prng(43)()).not.toBe(xs[0]);
  });

  it('returns a permutation without mutating the input, and both orders occur for two arms', () => {
    const input = ['A', 'B'] as const;
    const rand = prng(7);
    const orders = new Set(Array.from({ length: 50 }, () => shuffle(input, rand).join('')));
    expect(orders).toEqual(new Set(['AB', 'BA']));
    expect(input).toEqual(['A', 'B']);
    expect(shuffle([1, 2, 3, 4, 5], prng(1)).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('listFixtureFiles and copyFiles', () => {
  it('lists tracked and untracked-but-not-ignored files only, and copies them', () => {
    const repo = tmp();
    const git = (...a: string[]) => {
      const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    git('init', '-q');
    write(repo, '.gitignore', '.omc/\nnode_modules/\n');
    write(repo, 'fx/task/TASK.md');
    write(repo, 'fx/task/src/a.js');
    git('add', '-A');
    git('commit', '-qm', 'init');
    write(repo, 'fx/task/test/new.test.js');
    write(repo, 'fx/task/.omc/state/x.json');
    write(repo, 'fx/task/node_modules/m/index.js');
    write(repo, 'fx/other/TASK.md');

    const files = listFixtureFiles(repo, join(repo, 'fx', 'task'));
    expect(files).toEqual(['TASK.md', 'src/a.js', 'test/new.test.js']);

    const dest = tmp();
    copyFiles(join(repo, 'fx', 'task'), files, dest);
    expect(hashTree(dest)).toBe(hashTree((() => {
      const ref = tmp();
      write(ref, 'TASK.md', 'fx/task/TASK.md');
      write(ref, 'src/a.js', 'fx/task/src/a.js');
      write(ref, 'test/new.test.js', 'fx/task/test/new.test.js');
      return ref;
    })()));
  });

  it('refuses fixtures outside the repository and empty fixtures', () => {
    const repo = tmp();
    spawnSync('git', ['init', '-q'], { cwd: repo });
    expect(() => listFixtureFiles(repo, tmp())).toThrow(/outside the repository/);
    mkdirSync(join(repo, 'empty'));
    expect(() => listFixtureFiles(repo, join(repo, 'empty'))).toThrow(/no tracked files/);
  });
});
