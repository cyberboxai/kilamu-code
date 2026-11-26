import { describe, expect, it } from 'vitest';
import { analyzeGraph, filesOverlap, findCycle, normalizePlan, serializeConflicts, validatePlan } from '../../../src/orchestrator/graph.ts';
import { plan, task } from '../../helpers/plan.ts';

describe('normalizePlan', () => {
  it('applies defaults and normalizes string criteria to attestations', () => {
    const p = normalizePlan({ objective: 'x', tasks: [{ id: 'T1', acceptance: ['looks right'] }] }, { maxRetries: 2 });
    const t = p.tasks[0]!;
    expect(t.role).toBe('developer');
    expect(t.taskClass).toBe('implementation');
    expect(t.maxRetries).toBe(2);
    expect(t.acceptance[0]).toEqual({ id: 'T1.c1', kind: 'attestation', description: 'looks right' });
  });

  it.each([
    [{ tasks: [] }, /objective/],
    [{ objective: 'x', tasks: [] }, /non-empty/],
    [{ objective: 'x', tasks: [{ id: 'bad id!' }] }, /must match/],
    [{ objective: 'x', tasks: [{ id: 'T1', role: 'wizard' }] }, /unknown role/],
    [{ objective: 'x', tasks: [{ id: 'T1', files: ['../etc/passwd'] }] }, /project-relative/],
    [{ objective: 'x', tasks: [{ id: 'T1', files: ['/abs'] }] }, /project-relative/],
    [{ objective: 'x', tasks: [{ id: 'T1', acceptance: [{ kind: 'command' }] }] }, /needs "command"/],
    [{ objective: 'x', tasks: [{ id: 'T1', priority: 9 }] }, /priority/],
  ])('rejects invalid input %#', (raw, re) => {
    expect(() => normalizePlan(raw, { maxRetries: 1 })).toThrow(re);
  });
});

describe('validatePlan', () => {
  it('flags unknown deps, self deps, duplicates and missing criteria', () => {
    const issues = validatePlan(plan([
      task('A', { dependsOn: ['Z'] }),
      task('B', { dependsOn: ['B'] }),
      task('A'),
      task('C', { acceptance: [] }),
    ]));
    const msgs = issues.map((i) => i.message).join('\n');
    expect(msgs).toMatch(/Unknown dependency "Z"/);
    expect(msgs).toMatch(/depends on itself/);
    expect(msgs).toMatch(/Duplicate task id "A"/);
    expect(msgs).toMatch(/no acceptance criteria/);
  });

  it('detects cycles', () => {
    const p = plan([task('A', { dependsOn: ['C'] }), task('B', { dependsOn: ['A'] }), task('C', { dependsOn: ['B'] })]);
    expect(findCycle(p.tasks)).not.toBeNull();
    expect(validatePlan(p).some((i) => /cycle/.test(i.message))).toBe(true);
  });

  it('warns on attestation-only tasks and writing tasks without owned files', () => {
    const issues = validatePlan(plan([task('A', { files: [], acceptance: [{ id: 'x', kind: 'attestation', description: 'ok' }] })]));
    expect(issues.filter((i) => i.severity === 'warning')).toHaveLength(2);
  });
});

describe('analyzeGraph', () => {
  it('computes levels, width, critical path and parallelism', () => {
    const p = plan([
      task('A', { complexity: 'small' }),
      task('B', { dependsOn: ['A'] }),
      task('C', { dependsOn: ['A'] }),
      task('D', { dependsOn: ['B', 'C'], complexity: 'small' }),
    ]);
    const g = analyzeGraph(p);
    expect(g.levels).toEqual([['A'], ['B', 'C'], ['D']]);
    expect(g.maxWidth).toBe(2);
    expect(g.criticalPathWeight).toBe(2 + 5 + 2);
    expect(g.totalWeight).toBe(2 + 5 + 5 + 2);
    expect(g.parallelism).toBeCloseTo(14 / 9);
  });

  it('reports conflicts only between concurrently runnable tasks', () => {
    const p = plan([
      task('A', { files: ['src/shared.ts'] }),
      task('B', { files: ['src/shared.ts'] }),
      task('C', { files: ['src/shared.ts'], dependsOn: ['A', 'B'] }),
    ]);
    const g = analyzeGraph(p);
    expect(g.conflicts).toEqual([{ a: 'A', b: 'B', files: ['src/shared.ts'] }]);
  });

  it('serializeConflicts adds a dependency and keeps the graph acyclic', () => {
    const p = plan([task('A', { files: ['src/x/'] }), task('B', { files: ['src/x/y.ts'] })]);
    const added = serializeConflicts(p, analyzeGraph(p));
    expect(added).toEqual([{ from: 'B', to: 'A', files: ['src/x/'] }]);
    expect(findCycle(p.tasks)).toBeNull();
    expect(analyzeGraph(p).conflicts).toHaveLength(0);
  });
});

describe('filesOverlap', () => {
  it('treats trailing-slash entries as directories', () => {
    expect(filesOverlap('src/a/', 'src/a/b.ts')).toBe(true);
    expect(filesOverlap('src/a.ts', 'src/a.ts')).toBe(true);
    expect(filesOverlap('src/a', 'src/ab.ts')).toBe(false);
    expect(filesOverlap('src/a.ts', 'src/b.ts')).toBe(false);
  });
});
