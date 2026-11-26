import { describe, expect, it } from 'vitest';
import { selectMode } from '../../../src/orchestrator/mode.ts';
import { plan, task } from '../../helpers/plan.ts';

const base = { teamsAvailable: true, maxParallelAgents: 3 };

describe('selectMode', () => {
  it('chooses SINGLE for a single small task', () => {
    const d = selectMode({ ...base, plan: plan([task('A', { complexity: 'small' })]) });
    expect(d.mode).toBe('SINGLE');
    expect(d.teamSize).toBe(1);
    expect(d.reasons.join(' ')).toMatch(/overhead/);
  });

  it('chooses SINGLE for a purely sequential chain', () => {
    const d = selectMode({ ...base, plan: plan([task('A'), task('B', { dependsOn: ['A'] }), task('C', { dependsOn: ['B'] })]) });
    expect(d.mode).toBe('SINGLE');
    expect(d.reasons.join(' ')).toMatch(/depends on the previous/);
  });

  it('chooses TEAM for independent substantial writing streams', () => {
    const d = selectMode({ ...base, plan: plan([task('api', { complexity: 'large' }), task('db', { complexity: 'large' }), task('ui', { complexity: 'large' })]) });
    expect(d.mode).toBe('TEAM');
    expect(d.teamSize).toBe(3);
  });

  it('respects maxParallelAgents for team size', () => {
    const tasks = ['a', 'b', 'c', 'd', 'e'].map((id) => task(id, { complexity: 'large' }));
    const d = selectMode({ teamsAvailable: true, maxParallelAgents: 2, plan: plan(tasks) });
    expect(d.mode).toBe('TEAM');
    expect(d.teamSize).toBe(2);
  });

  it('falls back to SUBAGENT when teams are unavailable and records the constraint', () => {
    const d = selectMode({ ...base, teamsAvailable: false, plan: plan([task('a', { complexity: 'large' }), task('b', { complexity: 'large' })]) });
    expect(d.mode).toBe('SUBAGENT');
    expect(d.constraints.join(' ')).toMatch(/unavailable/);
  });

  it('chooses SUBAGENT for parallel read-only research', () => {
    const ro = (id: string) => task(id, { role: 'researcher', taskClass: 'research', files: [], complexity: 'medium' });
    const d = selectMode({ ...base, plan: plan([ro('r1'), ro('r2'), ro('r3')]) });
    expect(d.mode).toBe('SUBAGENT');
    expect(d.teamSize).toBe(3);
  });

  it('does not form a team when concurrent writers share files', () => {
    const d = selectMode({ ...base, plan: plan([task('a', { complexity: 'large', files: ['src/x.ts'] }), task('b', { complexity: 'large', files: ['src/x.ts'] })]) });
    expect(d.mode).not.toBe('TEAM');
    expect(d.constraints.join(' ')).toMatch(/conflict/);
  });

  it('honours a forced mode but never forces TEAM when unavailable', () => {
    const p = plan([task('a'), task('b')]);
    expect(selectMode({ ...base, plan: p, forced: 'SINGLE' }).mode).toBe('SINGLE');
    const d = selectMode({ ...base, teamsAvailable: false, plan: p, forced: 'TEAM' });
    expect(d.mode).toBe('SUBAGENT');
  });

  it('is deterministic', () => {
    const p = plan([task('a', { complexity: 'large' }), task('b', { complexity: 'large' })]);
    expect(selectMode({ ...base, plan: p })).toEqual(selectMode({ ...base, plan: p }));
  });
});
