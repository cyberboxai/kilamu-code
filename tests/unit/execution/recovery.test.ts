import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModeDecision } from '../../../src/core/types.ts';
import { compactionInstructions, orientation, reconcileExecution, startCheckpointData } from '../../../src/execution/recovery.ts';
import { ExecutionStore } from '../../../src/execution/store.ts';
import { plan, task } from '../../helpers/plan.ts';
import { tempProject } from '../../helpers/tmp.ts';

const decision: ModeDecision = { mode: 'SUBAGENT', teamSize: 2, reasons: [], factors: [], constraints: [] };

describe('recovery', () => {
  let ctx: ReturnType<typeof tempProject>;
  let store: ExecutionStore;
  beforeEach(() => {
    ctx = tempProject();
    store = new ExecutionStore(ctx.rt.db);
    mkdirSync(join(ctx.root, 'src'));
    writeFileSync(join(ctx.root, 'src/A.ts'), 'export const a = 1;\n');
    writeFileSync(join(ctx.root, 'src/B.ts'), 'export const b = 1;\n');
  });
  afterEach(() => ctx.cleanup());

  async function startWithCheckpoint(exId: string, id: string, session: string | null = 'old'): Promise<void> {
    const t = store.getTask(exId, id);
    const cp = await startCheckpointData(ctx.root, t);
    const saved = store.addCheckpoint({ executionId: exId, taskId: id, kind: 'task-start', gitHead: cp.gitHead, data: cp.data });
    store.startTask(exId, id, 'agent', saved.id, session);
  }
  /** The previous process of session "old" was restarted (SessionStart resume). */
  const restarted = { restartedSession: 'old' };

  it('releases orphaned tasks and flags those whose owned files changed', async () => {
    const ex = store.createExecution({ plan: plan([task('A'), task('B')]), decision, budgetTokens: 1, sessionId: 'old', baseCommit: null });
    await startWithCheckpoint(ex.id, 'A');
    await startWithCheckpoint(ex.id, 'B');
    writeFileSync(join(ctx.root, 'src/A.ts'), 'export const a = 2; // edited by interrupted agent\n');

    const rep = await reconcileExecution(store, ctx.root, ex.id, 'old', restarted);
    expect(rep.reconciled).toEqual([
      { taskId: 'A', previousStatus: 'RUNNING', changedFiles: ['src/A.ts'], verifyFirst: true },
      { taskId: 'B', previousStatus: 'RUNNING', changedFiles: [], verifyFirst: false },
    ]);
    // No blind replay: attempts are preserved, tasks are READY, session updated.
    const a = store.getTask(ex.id, 'A');
    expect(a.status).toBe('READY');
    expect(a.attempts).toBe(1);
    expect(store.getExecution(ex.id).sessionId).toBe('old');
    // A reconciled task with work on disk can go straight to verification.
    expect(store.submitTask(ex.id, 'A', 'reconciler', 'recovered', []).status).toBe('VERIFYING');

    const text = orientation(store.summary(ex.id), rep);
    expect(text).toMatch(/Verify first \(owned files changed\): A/);
    expect(text.length).toBeLessThan(1600);
  });

  it('leaves tasks of another live session alone, releases them once that session ended or with --force', async () => {
    const ex = store.createExecution({ plan: plan([task('A')]), decision, budgetTokens: 1, sessionId: 's1', baseCommit: null });
    const t = store.getTask(ex.id, 'A');
    const cp = await startCheckpointData(ctx.root, t);
    const saved = store.addCheckpoint({ executionId: ex.id, taskId: 'A', kind: 'task-start', gitHead: cp.gitHead, data: cp.data });
    store.startTask(ex.id, 'A', 'agent', saved.id, 's1');

    const other = await reconcileExecution(store, ctx.root, ex.id, 's2');
    expect(other.reconciled).toEqual([]);
    expect(other.heldByOtherSessions).toEqual([{ taskId: 'A', sessionId: 's1' }]);
    expect(store.getTask(ex.id, 'A').status).toBe('RUNNING');
    expect(orientation(store.summary(ex.id), other)).toMatch(/another session may still own them/);

    store.markSessionEnded('s1', 'prompt_input_exit');
    const after = await reconcileExecution(store, ctx.root, ex.id, 's2', { endedAt: (x) => store.sessionEndedAt(x) });
    expect(after.reconciled.map((r) => r.taskId)).toEqual(['A']);
    expect(store.sessionsFor(ex.id).map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('flags directory-owned tasks verify-first (changes cannot be ruled out)', async () => {
    const ex = store.createExecution({ plan: plan([task('D', { files: ['src/'] })]), decision, budgetTokens: 1, sessionId: null, baseCommit: null });
    await startWithCheckpoint(ex.id, 'D');
    const rep = await reconcileExecution(store, ctx.root, ex.id, 'old', restarted);
    expect(rep.reconciled[0]!.verifyFirst).toBe(true);
    expect(store.getTask(ex.id, 'D').verifyFirst).toBe(true);
  });

  it('never guesses ownership: unattributed tasks are released only by force or silence', async () => {
    const ex = store.createExecution({ plan: plan([task('A')]), decision, budgetTokens: 1, sessionId: null, baseCommit: null });
    await startWithCheckpoint(ex.id, 'A', null);
    expect((await reconcileExecution(store, ctx.root, ex.id, 'any', { restartedSession: 'any' })).reconciled).toEqual([]);
    const later = Date.now() + 3 * 60 * 60_000;
    expect((await reconcileExecution(store, ctx.root, ex.id, 'any', { now: later })).reconciled.map((r) => r.taskId)).toEqual(['A']);
  });

  it('a resumed session clears its end marker; an old marker does not release newer work', async () => {
    const ex = store.createExecution({ plan: plan([task('A')]), decision, budgetTokens: 1, sessionId: 's1', baseCommit: null });
    store.markSessionEnded('s1', 'exit');
    const endedAt = store.sessionEndedAt('s1')!;
    store.clearSessionEnd('s1');
    expect(store.sessionEndedAt('s1')).toBeNull();
    await startWithCheckpoint(ex.id, 'A', 's1');
    // A stale marker older than the task's last update must not release it.
    const rep = await reconcileExecution(store, ctx.root, ex.id, 's2', { endedAt: () => endedAt });
    expect(rep.reconciled).toEqual([]);
  });

  it('is idempotent when nothing is active', async () => {
    const ex = store.createExecution({ plan: plan([task('A')]), decision, budgetTokens: 1, sessionId: 's', baseCommit: null });
    const r1 = await reconcileExecution(store, ctx.root, ex.id, 's');
    const r2 = await reconcileExecution(store, ctx.root, ex.id, 's');
    expect(r1.reconciled).toEqual([]);
    expect(r2.reconciled).toEqual([]);
    expect(store.getTask(ex.id, 'A').status).toBe('READY');
  });

  it('produces bounded compaction instructions naming the execution', () => {
    const ex = store.createExecution({ plan: plan([task('A')]), decision, budgetTokens: 1, sessionId: 's', baseCommit: null });
    const text = compactionInstructions(store.summary(ex.id));
    expect(text).toContain(ex.id);
    expect(text.length).toBeLessThan(10_000);
  });
});
