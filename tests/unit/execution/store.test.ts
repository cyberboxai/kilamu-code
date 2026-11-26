import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId, nowIso } from '../../../src/core/ids.ts';
import type { ModeDecision, VerificationReport } from '../../../src/core/types.ts';
import { canTransition, ExecutionStore, MAX_UNBLOCKS, type RunLookup } from '../../../src/execution/store.ts';
import { getRun } from '../../../src/verification/engine.ts';
import { plan, task } from '../../helpers/plan.ts';
import { tempProject } from '../../helpers/tmp.ts';

const decision: ModeDecision = { mode: 'SINGLE', teamSize: 1, reasons: ['test'], factors: [], constraints: [] };

describe('ExecutionStore', () => {
  let ctx: ReturnType<typeof tempProject>;
  let store: ExecutionStore;
  beforeEach(() => {
    ctx = tempProject();
    store = new ExecutionStore(ctx.rt.db);
  });
  afterEach(() => ctx.cleanup());

  const create = (tasks = [task('A'), task('B', { dependsOn: ['A'] })]) =>
    store.createExecution({ plan: plan(tasks), decision, budgetTokens: 1000, sessionId: 's1', baseCommit: null });

  /** Persist a verification run row the way the verification engine does (bound to the current attempt). */
  const report = (executionId: string, taskId: string, verdict: 'VERIFIED' | 'FAILED', checkpointId?: string | null): VerificationReport => {
    const runId = newId('vr');
    const cp = checkpointId === undefined ? store.getTask(executionId, taskId).checkpointId : checkpointId;
    const results = [{ criterionId: `${taskId}.c1`, kind: 'file_exists' as const, status: verdict === 'VERIFIED' ? 'PASS' as const : 'FAIL' as const, detail: 'x' }];
    ctx.rt.db.prepare('INSERT INTO verification_runs(id, execution_id, task_id, verdict, results_json, checkpoint_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, executionId, taskId, verdict, JSON.stringify(results), cp, nowIso());
    return { executionId, taskId, results, verdict, runId };
  };
  const lookup: RunLookup = (id) => getRun(ctx.rt.db, id);

  it('creates tasks and computes readiness from dependencies', () => {
    const ex = create();
    const tasks = store.listTasks(ex.id);
    expect(tasks.find((t) => t.id === 'A')!.status).toBe('READY');
    expect(tasks.find((t) => t.id === 'B')!.status).toBe('WAITING');
    expect(ex.status).toBe('ACTIVE');
  });

  it('refuses direct VERIFIED transitions', () => {
    const ex = create();
    expect(() => store.transition(ex.id, 'A', 'VERIFIED', 'agent', 'I am done')).toThrow(/kilamu verify/);
  });

  it('rejects invalid transitions', () => {
    const ex = create();
    expect(() => store.transition(ex.id, 'B', 'VERIFYING', 'x', 'y')).toThrow(/not allowed/);
    expect(canTransition('VERIFIED', 'READY')).toBe(false);
  });

  it('only accepts verification reports backed by a persisted run', () => {
    const ex = create();
    store.startTask(ex.id, 'A', 'dev', 'cp1');
    store.submitTask(ex.id, 'A', 'dev', 'done', []);
    const forged: VerificationReport = { executionId: ex.id, taskId: 'A', results: [], verdict: 'VERIFIED', runId: 'vr_fake' };
    expect(() => store.applyVerification(forged, lookup)).toThrow(/not found/);
    const fail = report(ex.id, 'A', 'FAILED');
    expect(() => store.applyVerification({ ...fail, verdict: 'VERIFIED' }, lookup)).toThrow(/does not match/);
  });

  it('runs the full lifecycle and completes the execution', () => {
    const ex = create();
    store.startTask(ex.id, 'A', 'dev', 'cp1');
    store.submitTask(ex.id, 'A', 'dev', 'did A', ['a_0000000000000000']);
    expect(store.applyVerification(report(ex.id, 'A', 'VERIFIED'), lookup).status).toBe('VERIFIED');
    expect(store.getTask(ex.id, 'B').status).toBe('READY');
    store.startTask(ex.id, 'B', 'dev', 'cp2');
    store.submitTask(ex.id, 'B', 'dev', 'did B', []);
    store.applyVerification(report(ex.id, 'B', 'VERIFIED'), lookup);
    expect(store.getExecution(ex.id).status).toBe('COMPLETED');
    expect(store.summary(ex.id).progressPct).toBe(100);
    const events = store.taskEvents(ex.id, 'A').map((e) => e.to).reverse();
    expect(events).toEqual(['CREATED', 'READY', 'RUNNING', 'VERIFYING', 'VERIFIED']);
  });

  it('bounds retries: failed verification returns to READY until attempts are exhausted, then BLOCKED', () => {
    const ex = create([task('A', { maxRetries: 1 }), task('B', { dependsOn: ['A'] })]);
    store.startTask(ex.id, 'A', 'dev', 'cp');
    store.submitTask(ex.id, 'A', 'dev', 'try 1', []);
    expect(store.applyVerification(report(ex.id, 'A', 'FAILED'), lookup).status).toBe('READY');
    store.startTask(ex.id, 'A', 'dev', 'cp');
    store.submitTask(ex.id, 'A', 'dev', 'try 2', []);
    expect(store.applyVerification(report(ex.id, 'A', 'FAILED'), lookup).status).toBe('BLOCKED');
    expect(store.getTask(ex.id, 'B').status).toBe('BLOCKED');
    expect(store.summary(ex.id).stalled).toBe(true);
    // A human unblock grants one more attempt and dependents go back to waiting.
    expect(store.unblockTask(ex.id, 'A', 'user', 'fixed env').status).toBe('READY');
    expect(store.getTask(ex.id, 'B').status).toBe('WAITING');
  });

  it('prevents two active tasks from owning the same file', () => {
    const ex = create([task('A', { files: ['src/x.ts'] }), task('B', { files: ['src/x.ts'] })]);
    store.startTask(ex.id, 'A', 'dev1', 'cp');
    expect(() => store.startTask(ex.id, 'B', 'dev2', 'cp')).toThrow(/owned by active task A/);
    const next = store.nextTasks(ex.id, 3);
    expect(next.ready).toHaveLength(0);
    expect(next.deferred[0]!.reason).toMatch(/held by an active task/);
  });

  it('nextTasks respects the parallel limit and priority', () => {
    const ex = create([task('A', { priority: 2 }), task('B', { priority: 1 }), task('C', { priority: 3 })]);
    const next = store.nextTasks(ex.id, 2);
    expect(next.ready.map((t) => t.id)).toEqual(['B', 'A']);
    expect(next.deferred.map((d) => d.task.id)).toEqual(['C']);
  });

  it('cancels an execution and all non-terminal tasks', () => {
    const ex = create();
    store.cancelExecution(ex.id, 'user changed mind');
    expect(store.getExecution(ex.id).status).toBe('CANCELLED');
    expect(store.listTasks(ex.id).every((t) => t.status === 'CANCELLED')).toBe(true);
  });

  it('rejects a verification run bound to a different attempt (stale verdict)', () => {
    const ex = create([task('A', { maxRetries: 2 })]);
    store.startTask(ex.id, 'A', 'dev', 'cp-attempt-1');
    const stale = report(ex.id, 'A', 'VERIFIED', 'cp-attempt-1');
    store.submitTask(ex.id, 'A', 'dev', 'try 1', []);
    store.applyVerification(report(ex.id, 'A', 'FAILED'), lookup); // → READY
    store.startTask(ex.id, 'A', 'dev', 'cp-attempt-2');
    store.submitTask(ex.id, 'A', 'dev', 'try 2', []);
    expect(() => store.applyVerification(stale, lookup)).toThrow(/different attempt/);
  });

  it('does not allow verifying a READY task without a new attempt (retry bound holds)', () => {
    const ex = create([task('A', { maxRetries: 1 })]);
    store.startTask(ex.id, 'A', 'dev', 'cp1');
    store.submitTask(ex.id, 'A', 'dev', 'x', []);
    store.applyVerification(report(ex.id, 'A', 'FAILED'), lookup);
    expect(store.getTask(ex.id, 'A').status).toBe('READY');
    expect(() => store.submitTask(ex.id, 'A', 'dev', 'again', [])).toThrow(/task start/);
    expect(() => store.applyVerification(report(ex.id, 'A', 'VERIFIED'), lookup)).toThrow(/cannot apply/);
  });

  it('allows verify-first on reconciled tasks only', () => {
    const ex = create([task('A')]);
    store.startTask(ex.id, 'A', 'dev', 'cp1', 's-old');
    store.releaseTask(ex.id, 'A', 'reconciler', 'interrupted', true);
    expect(store.getTask(ex.id, 'A').verifyFirst).toBe(true);
    expect(store.nextTasks(ex.id, 3).ready).toHaveLength(0);
    expect(store.submitTask(ex.id, 'A', 'reconciler', 'recovered', []).status).toBe('VERIFYING');
    expect(store.applyVerification(report(ex.id, 'A', 'VERIFIED'), lookup).status).toBe('VERIFIED');
  });

  it('propagates blocking through long dependency chains in one refresh', () => {
    const ex = create([task('A'), task('B', { dependsOn: ['A'] }), task('C', { dependsOn: ['B'] }), task('D', { dependsOn: ['C'] }), task('E', { dependsOn: ['D'] })]);
    store.transition(ex.id, 'A', 'CANCELLED', 'user', 'not needed');
    expect(store.listTasks(ex.id).filter((t) => t.id !== 'A').every((t) => t.status === 'BLOCKED')).toBe(true);
    expect(store.summary(ex.id).stalled).toBe(true);
  });

  it('marks the execution CANCELLED when every task is cancelled', () => {
    const ex = create([task('A')]);
    store.transition(ex.id, 'A', 'CANCELLED', 'user', 'drop');
    expect(store.getExecution(ex.id).status).toBe('CANCELLED');
  });

  it('refuses to cancel a finished execution', () => {
    const ex = create([task('A')]);
    store.startTask(ex.id, 'A', 'dev', 'cp1');
    store.submitTask(ex.id, 'A', 'dev', 'x', []);
    store.applyVerification(report(ex.id, 'A', 'VERIFIED'), lookup);
    expect(() => store.cancelExecution(ex.id, 'oops')).toThrow(/only ACTIVE/);
    expect(store.getExecution(ex.id).status).toBe('COMPLETED');
  });

  it('caps human unblocks', () => {
    const ex = create([task('A', { maxRetries: 0 })]);
    for (let i = 0; i < MAX_UNBLOCKS; i++) {
      store.startTask(ex.id, 'A', 'dev', `cp${i}`);
      store.submitTask(ex.id, 'A', 'dev', 'x', []);
      store.applyVerification(report(ex.id, 'A', 'FAILED'), lookup);
      expect(store.getTask(ex.id, 'A').status).toBe('BLOCKED');
      store.unblockTask(ex.id, 'A', 'user', 'retry');
    }
    store.startTask(ex.id, 'A', 'dev', 'cpX');
    store.submitTask(ex.id, 'A', 'dev', 'x', []);
    store.applyVerification(report(ex.id, 'A', 'FAILED'), lookup);
    expect(() => store.unblockTask(ex.id, 'A', 'user', 'again')).toThrow(/replan/);
  });

  it('records who started each attempt (self-attestation guard input)', () => {
    const ex = create([task('A')]);
    store.startTask(ex.id, 'A', 'dev1', 'cp1');
    store.releaseTask(ex.id, 'A', 'lead', 'stalled');
    expect(store.getTask(ex.id, 'A').owner).toBeNull();
    expect(store.starters(ex.id, 'A')).toEqual(['dev1']);
  });

  it('redacts secrets in stored plan text and summaries', () => {
    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const ex = create([task('A', { description: `use ${secret}` })]);
    store.startTask(ex.id, 'A', 'dev', 'cp1');
    store.submitTask(ex.id, 'A', 'dev', `done with ${secret}`, []);
    const t = store.getTask(ex.id, 'A');
    expect(t.description).not.toContain(secret);
    expect(t.resultSummary).not.toContain(secret);
    expect(JSON.stringify(store.planJson(ex.id))).not.toContain(secret);
  });

  it('persists across reopen (durable state)', () => {
    const ex = create();
    store.startTask(ex.id, 'A', 'dev', 'cp');
    const file = ctx.rt.paths.dbFile;
    ctx.rt.close();
    const { openDb } = require('../../../src/persistence/db.ts') as typeof import('../../../src/persistence/db.ts');
    const { db } = openDb(file);
    const again = new ExecutionStore(db);
    expect(again.getTask(ex.id, 'A').status).toBe('RUNNING');
    expect(again.getTask(ex.id, 'A').attempts).toBe(1);
    db.close();
  });
});
