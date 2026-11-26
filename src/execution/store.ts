import { KilamuError } from '../core/errors.ts';
import { newId, nowIso } from '../core/ids.ts';
import { redact } from '../core/redact.ts';
import type {
  AcceptanceCriterion, AgentRole, Complexity, ExecutionMode, ExecutionRecord, ExecutionStatus,
  ModeDecision, PlanSpec, TaskClass, TaskRecord, TaskStatus, VerificationReport,
} from '../core/types.ts';
import { parseJson, tx, type Db } from '../persistence/db.ts';
import { filesOverlap } from '../orchestrator/graph.ts';

/**
 * Durable execution state and the task state machine (directive §8.2, §13).
 *
 * Invariants:
 *  - A task reaches VERIFIED only through `applyVerification` with a persisted
 *    VERIFIED run bound to the task's CURRENT attempt (checkpoint).
 *  - READY → VERIFYING (verifying work without a new attempt) is only allowed
 *    for tasks reconciliation flagged verify-first; otherwise every
 *    verification consumes an attempt, so retries stay bounded.
 *  - Every mutation re-reads and updates inside one transaction, guarded on
 *    the expected from-status (no lost updates between concurrent processes).
 *  - Free text (objective, plan, summaries, reasons) is redacted before storage.
 */

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  CREATED: ['WAITING', 'READY', 'BLOCKED', 'CANCELLED'],
  WAITING: ['READY', 'BLOCKED', 'CANCELLED'],
  READY: ['RUNNING', 'WAITING', 'VERIFYING', 'BLOCKED', 'CANCELLED'],
  RUNNING: ['VERIFYING', 'FAILED', 'BLOCKED', 'READY', 'CANCELLED'],
  VERIFYING: ['VERIFIED', 'FAILED', 'READY', 'RUNNING', 'CANCELLED'],
  VERIFIED: [],
  FAILED: ['READY', 'BLOCKED', 'CANCELLED'],
  BLOCKED: ['READY', 'WAITING', 'CANCELLED'],
  CANCELLED: [],
};

export const ACTIVE_STATES: ReadonlySet<TaskStatus> = new Set(['RUNNING', 'VERIFYING']);
export const TERMINAL_STATES: ReadonlySet<TaskStatus> = new Set(['VERIFIED', 'CANCELLED']);
/** A human may unblock a task this many times (each grants one more attempt). */
export const MAX_UNBLOCKS = 2;

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

const clean = (s: string, max = 4000): string => redact(s).text.slice(0, max);

interface TaskRow {
  execution_id: string; id: string; title: string; description: string; role: string; task_class: string;
  complexity: string; priority: number; status: string; owner: string | null; depends_on_json: string;
  files_json: string; inputs_json: string; expected_output: string; acceptance_json: string; max_retries: number;
  budget_tokens: number | null; attempts: number; checkpoint_id: string | null; result_summary: string | null;
  output_artifacts_json: string; created_at: string; updated_at: string;
  session_id: string | null; verify_first: number; unblocks: number;
}

interface ExecRow {
  id: string; objective: string; status: string; mode: string; mode_rationale_json: string; budget_tokens: number;
  plan_json: string; session_id: string | null; base_commit: string | null; created_at: string; updated_at: string;
}

function toTask(r: TaskRow): TaskRecord {
  return {
    executionId: r.execution_id,
    id: r.id,
    title: r.title,
    description: r.description,
    role: r.role as AgentRole,
    taskClass: r.task_class as TaskClass,
    complexity: r.complexity as Complexity,
    priority: r.priority,
    status: r.status as TaskStatus,
    owner: r.owner,
    dependsOn: parseJson<string[]>(r.depends_on_json, []),
    files: parseJson<string[]>(r.files_json, []),
    inputs: parseJson<string[]>(r.inputs_json, []),
    expectedOutput: r.expected_output,
    acceptance: parseJson<AcceptanceCriterion[]>(r.acceptance_json, []),
    maxRetries: r.max_retries,
    ...(r.budget_tokens !== null ? { budget: { maxTokens: r.budget_tokens } } : {}),
    attempts: r.attempts,
    checkpointId: r.checkpoint_id,
    resultSummary: r.result_summary,
    outputArtifacts: parseJson<string[]>(r.output_artifacts_json, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sessionId: r.session_id,
    verifyFirst: r.verify_first === 1,
  };
}

function toExec(r: ExecRow): ExecutionRecord {
  return {
    id: r.id,
    objective: r.objective,
    status: r.status as ExecutionStatus,
    mode: r.mode as ExecutionMode,
    modeRationale: parseJson<ModeDecision>(r.mode_rationale_json, { mode: r.mode as ExecutionMode, teamSize: 1, reasons: [], factors: [], constraints: [] }),
    budgetTokens: r.budget_tokens,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sessionId: r.session_id,
    baseCommit: r.base_commit,
  };
}

export interface TaskEvent {
  id: number; taskId: string; from: TaskStatus | null; to: TaskStatus; actor: string; reason: string; at: string;
}

export interface Checkpoint {
  id: string; executionId: string; taskId: string | null; kind: string; gitHead: string | null;
  data: Record<string, unknown>; createdAt: string;
}

/** Minimal view of a persisted verification run (owned by the verification module). */
export interface RunRecord {
  verdict: 'VERIFIED' | 'FAILED';
  executionId: string;
  taskId: string;
  checkpointId: string | null;
}

export type RunLookup = (runId: string) => RunRecord | null;
export type EventSink = (type: string, data: Record<string, unknown>, executionId: string) => void;

interface TransitionExtra {
  owner?: string | null;
  attempts?: number;
  checkpointId?: string;
  resultSummary?: string;
  outputArtifacts?: string[];
  sessionId?: string | null;
  verifyFirst?: boolean;
  unblocks?: number;
}

export class ExecutionStore {
  private readonly db: Db;
  private readonly onEvent: EventSink | null;

  constructor(db: Db, onEvent: EventSink | null = null) {
    this.db = db;
    this.onEvent = onEvent;
  }

  // ---------------------------------------------------------------- executions

  createExecution(input: {
    plan: PlanSpec; decision: ModeDecision; budgetTokens: number; sessionId: string | null; baseCommit: string | null;
  }): ExecutionRecord {
    const id = newId('ex');
    const at = nowIso();
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO executions(id, objective, status, mode, mode_rationale_json, budget_tokens, plan_json, session_id, base_commit, created_at, updated_at)
        VALUES (?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, clean(input.plan.objective, 1000), input.decision.mode, JSON.stringify(input.decision), input.budgetTokens,
        redact(JSON.stringify(input.plan)).text, input.sessionId, input.baseCommit, at, at,
      );
      if (input.sessionId) this.linkSession(id, input.sessionId, at);
      const ins = this.db.prepare(`INSERT INTO tasks(execution_id, id, title, description, role, task_class, complexity, priority, status, owner,
        depends_on_json, files_json, inputs_json, expected_output, acceptance_json, max_retries, budget_tokens, attempts, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`);
      const ev = this.db.prepare(`INSERT INTO task_events(execution_id, task_id, from_status, to_status, actor, reason, at) VALUES (?, ?, NULL, 'CREATED', 'planner', 'task created from plan', ?)`);
      for (const t of input.plan.tasks) {
        ins.run(id, t.id, clean(t.title, 300), clean(t.description), t.role, t.taskClass, t.complexity, t.priority,
          JSON.stringify(t.dependsOn), JSON.stringify(t.files), JSON.stringify(t.inputs), clean(t.expectedOutput),
          redact(JSON.stringify(t.acceptance)).text, t.maxRetries, t.budget?.maxTokens ?? null, at, at);
        ev.run(id, t.id, at);
      }
    });
    this.refreshReadiness(id, 'planner');
    return this.getExecution(id);
  }

  getExecution(id: string): ExecutionRecord {
    const r = this.db.prepare('SELECT * FROM executions WHERE id = ?').get(id) as ExecRow | undefined;
    if (!r) throw new KilamuError('NOT_FOUND', `Execution not found: ${id}`);
    return toExec(r);
  }

  /** The stored (redacted) plan JSON. */
  planJson(id: string): unknown {
    const r = this.db.prepare('SELECT plan_json FROM executions WHERE id = ?').get(id) as { plan_json: string } | undefined;
    if (!r) throw new KilamuError('NOT_FOUND', `Execution not found: ${id}`);
    return parseJson<unknown>(r.plan_json, null);
  }

  listExecutions(filter: { status?: ExecutionStatus; limit?: number } = {}): ExecutionRecord[] {
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 500);
    const rows = filter.status
      ? this.db.prepare('SELECT * FROM executions WHERE status = ? ORDER BY updated_at DESC, id DESC LIMIT ?').all(filter.status, limit)
      : this.db.prepare('SELECT * FROM executions ORDER BY updated_at DESC, id DESC LIMIT ?').all(limit);
    return (rows as unknown as ExecRow[]).map(toExec);
  }

  /** Most recently updated ACTIVE execution, if any. */
  activeExecution(): ExecutionRecord | null {
    return this.listExecutions({ status: 'ACTIVE', limit: 1 })[0] ?? null;
  }

  /** Resolve "latest"/undefined to the active execution; otherwise validate the id. */
  resolveExecution(idOrLatest?: string): ExecutionRecord {
    if (!idOrLatest || idOrLatest === 'latest') {
      const active = this.listExecutions({ status: 'ACTIVE', limit: 10 });
      if (active.length > 1) {
        throw new KilamuError('AMBIGUOUS_EXECUTION', `${active.length} executions are ACTIVE (${active.map((e) => e.id).join(', ')}); pass --exec <id>`);
      }
      const a = active[0] ?? this.listExecutions({ limit: 1 })[0] ?? null;
      if (!a) throw new KilamuError('NOT_FOUND', 'No Kilamu executions yet. Create one with `kilamu plan create`.');
      return a;
    }
    return this.getExecution(idOrLatest);
  }

  private setExecutionStatus(id: string, status: ExecutionStatus, reason: string): void {
    this.db.prepare('UPDATE executions SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
    this.onEvent?.('execution.status', { status, reason }, id);
  }

  private linkSession(executionId: string, sessionId: string, at: string): void {
    this.db.prepare('INSERT OR IGNORE INTO execution_sessions(execution_id, session_id, first_seen) VALUES (?, ?, ?)').run(executionId, sessionId, at);
  }

  /** Associate a (new) Claude Code session with the execution. Budget tracking sums all linked sessions. */
  touchSession(id: string, sessionId: string | null): void {
    const at = nowIso();
    tx(this.db, () => {
      this.db.prepare('UPDATE executions SET session_id = COALESCE(?, session_id), updated_at = ? WHERE id = ?').run(sessionId, at, id);
      if (sessionId) this.linkSession(id, sessionId, at);
    });
  }

  sessionsFor(executionId: string): Array<{ sessionId: string; firstSeen: string }> {
    const rows = this.db.prepare('SELECT session_id, first_seen FROM execution_sessions WHERE execution_id = ? ORDER BY first_seen, session_id').all(executionId) as Array<{ session_id: string; first_seen: string }>;
    return rows.map((r) => ({ sessionId: r.session_id, firstSeen: r.first_seen }));
  }

  markSessionEnded(sessionId: string, reason: string | null): void {
    this.db.prepare('INSERT INTO session_ends(session_id, ended_at, reason) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET ended_at = excluded.ended_at, reason = excluded.reason')
      .run(sessionId, nowIso(), reason);
  }

  /** When the session last ended (null if it never ended or was resumed since). */
  sessionEndedAt(sessionId: string): string | null {
    const r = this.db.prepare('SELECT ended_at FROM session_ends WHERE session_id = ?').get(sessionId) as { ended_at: string } | undefined;
    return r?.ended_at ?? null;
  }

  /** A (re)started session is alive again: forget its end marker. */
  clearSessionEnd(sessionId: string): void {
    this.db.prepare('DELETE FROM session_ends WHERE session_id = ?').run(sessionId);
  }

  /** Cancel an ACTIVE execution and all of its non-terminal tasks. */
  cancelExecution(id: string, reason: string): void {
    tx(this.db, () => {
      const ex = this.getExecution(id);
      if (ex.status !== 'ACTIVE') throw new KilamuError('INVALID_TRANSITION', `Execution ${id} is ${ex.status}; only ACTIVE executions can be cancelled`);
      for (const t of this.listTasks(id)) {
        if (!TERMINAL_STATES.has(t.status)) this.writeTransition(t, 'CANCELLED', 'user', clean(reason, 500));
      }
      this.setExecutionStatus(id, 'CANCELLED', clean(reason, 500));
    });
  }

  // --------------------------------------------------------------------- tasks

  listTasks(executionId: string): TaskRecord[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE execution_id = ? ORDER BY priority, id').all(executionId) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  getTask(executionId: string, taskId: string): TaskRecord {
    const r = this.db.prepare('SELECT * FROM tasks WHERE execution_id = ? AND id = ?').get(executionId, taskId) as TaskRow | undefined;
    if (!r) throw new KilamuError('NOT_FOUND', `Task ${taskId} not found in execution ${executionId}`);
    return toTask(r);
  }

  private unblockCount(executionId: string, taskId: string): number {
    const r = this.db.prepare('SELECT unblocks FROM tasks WHERE execution_id = ? AND id = ?').get(executionId, taskId) as { unblocks: number } | undefined;
    return r?.unblocks ?? 0;
  }

  taskEvents(executionId: string, taskId?: string, limit = 200): TaskEvent[] {
    const rows = (taskId
      ? this.db.prepare('SELECT * FROM task_events WHERE execution_id = ? AND task_id = ? ORDER BY id DESC LIMIT ?').all(executionId, taskId, limit)
      : this.db.prepare('SELECT * FROM task_events WHERE execution_id = ? ORDER BY id DESC LIMIT ?').all(executionId, limit)) as unknown as Array<{
      id: number; task_id: string; from_status: string | null; to_status: string; actor: string; reason: string; at: string;
    }>;
    return rows.map((r) => ({ id: r.id, taskId: r.task_id, from: r.from_status as TaskStatus | null, to: r.to_status as TaskStatus, actor: r.actor, reason: r.reason, at: r.at }));
  }

  /** Every actor that ever started an attempt of the task (for the self-attestation guard). */
  starters(executionId: string, taskId: string): string[] {
    const rows = this.db.prepare("SELECT DISTINCT actor FROM task_events WHERE execution_id = ? AND task_id = ? AND to_status = 'RUNNING'").all(executionId, taskId) as Array<{ actor: string }>;
    return rows.map((r) => r.actor);
  }

  /** Low-level guarded transition. VERIFIED is rejected here by design. */
  transition(executionId: string, taskId: string, to: TaskStatus, actor: string, reason: string): TaskRecord {
    if (to === 'VERIFIED') {
      throw new KilamuError('VERIFICATION_REQUIRED', 'A task can only become VERIFIED through `kilamu verify` with passing evidence');
    }
    const t = tx(this.db, () => {
      this.writeTransition(this.getTask(executionId, taskId), to, actor, reason);
      return this.getTask(executionId, taskId);
    });
    this.refreshReadiness(executionId);
    return t;
  }

  /** Must run inside a transaction. Guarded on the expected from-status. */
  private writeTransition(t: TaskRecord, to: TaskStatus, actor: string, reason: string, extra: TransitionExtra = {}): void {
    if (t.status === to && Object.keys(extra).length === 0) return;
    if (t.status !== to && !canTransition(t.status, to)) {
      throw new KilamuError('INVALID_TRANSITION', `Task ${t.id}: ${t.status} → ${to} is not allowed`, { from: t.status, to });
    }
    if (!reason.trim()) throw new KilamuError('INVALID_TRANSITION', 'A transition reason is required');
    const at = nowIso();
    const res = this.db.prepare(`UPDATE tasks SET status = ?, owner = ?, attempts = ?, checkpoint_id = ?, result_summary = ?, output_artifacts_json = ?,
        session_id = ?, verify_first = ?, unblocks = ?, updated_at = ?
      WHERE execution_id = ? AND id = ? AND status = ?`).run(
      to,
      extra.owner !== undefined ? (extra.owner === null ? null : clean(extra.owner, 200)) : t.owner,
      extra.attempts ?? t.attempts,
      extra.checkpointId ?? t.checkpointId,
      extra.resultSummary !== undefined ? clean(extra.resultSummary) : t.resultSummary,
      JSON.stringify(extra.outputArtifacts ?? t.outputArtifacts),
      extra.sessionId !== undefined ? extra.sessionId : (t.sessionId ?? null),
      (extra.verifyFirst ?? t.verifyFirst ?? false) ? 1 : 0,
      extra.unblocks ?? this.unblockCount(t.executionId, t.id),
      at, t.executionId, t.id, t.status,
    );
    if (Number(res.changes) !== 1) {
      throw new KilamuError('CONCURRENT_UPDATE', `Task ${t.id} changed concurrently (expected ${t.status}); re-run the command`);
    }
    if (t.status !== to) {
      this.db.prepare('INSERT INTO task_events(execution_id, task_id, from_status, to_status, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(t.executionId, t.id, t.status, to, clean(actor, 200), clean(reason, 2000), at);
    }
    this.db.prepare('UPDATE executions SET updated_at = ? WHERE id = ?').run(at, t.executionId);
  }

  /**
   * Recompute CREATED/WAITING/BLOCKED(dependency) tasks from dependency state,
   * iterating to a fixpoint (propagation through arbitrarily long chains):
   *   all deps VERIFIED            → READY
   *   any dep CANCELLED or BLOCKED → BLOCKED
   *   otherwise                    → WAITING
   */
  refreshReadiness(executionId: string, actor = 'scheduler'): void {
    tx(this.db, () => {
      const tasks = this.listTasks(executionId);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      for (let pass = 0; pass <= tasks.length; pass++) {
        let changed = false;
        for (const id of [...byId.keys()]) {
          const t = byId.get(id)!;
          if (!['CREATED', 'WAITING', 'BLOCKED'].includes(t.status)) continue;
          // Blocked for non-dependency reasons stays blocked until explicitly unblocked.
          if (t.status === 'BLOCKED' && !this.blockedByDependency(t)) continue;
          const deps = t.dependsOn.map((d) => byId.get(d)).filter((d): d is TaskRecord => !!d);
          const badDep = deps.find((d) => d.status === 'CANCELLED' || d.status === 'BLOCKED');
          let target: TaskStatus;
          let reason: string;
          if (badDep) {
            target = 'BLOCKED';
            reason = `dependency ${badDep.id} is ${badDep.status}`;
          } else if (deps.every((d) => d.status === 'VERIFIED')) {
            target = 'READY';
            reason = deps.length ? 'all dependencies VERIFIED' : 'no dependencies';
          } else {
            target = 'WAITING';
            reason = `waiting on ${deps.filter((d) => d.status !== 'VERIFIED').map((d) => d.id).join(', ')}`;
          }
          if (target !== t.status && canTransition(t.status, target)) {
            this.writeTransition(t, target, actor, reason);
            byId.set(id, this.getTask(executionId, id));
            changed = true;
          }
        }
        if (!changed) break;
      }
      this.refreshExecutionStatus(executionId);
    });
  }

  private blockedByDependency(t: TaskRecord): boolean {
    const last = this.taskEvents(t.executionId, t.id, 1)[0];
    return !!last && last.to === 'BLOCKED' && last.reason.startsWith('dependency ');
  }

  /** Must run inside a transaction. */
  private refreshExecutionStatus(executionId: string): void {
    const ex = this.getExecution(executionId);
    if (ex.status !== 'ACTIVE') return;
    const tasks = this.listTasks(executionId);
    if (tasks.length > 0 && tasks.every((t) => t.status === 'CANCELLED')) {
      this.setExecutionStatus(executionId, 'CANCELLED', 'all tasks cancelled');
      return;
    }
    const live = tasks.filter((t) => t.status !== 'CANCELLED');
    if (live.length > 0 && live.every((t) => t.status === 'VERIFIED')) {
      const cancelled = tasks.length - live.length;
      this.setExecutionStatus(executionId, 'COMPLETED', cancelled ? `all remaining tasks VERIFIED (${cancelled} cancelled)` : 'all tasks VERIFIED');
    }
  }

  /**
   * READY tasks that can start now: ordered by priority, excluding tasks whose
   * owned files overlap a RUNNING/VERIFYING task, capped by free slots.
   */
  nextTasks(executionId: string, maxParallel: number): { ready: TaskRecord[]; deferred: Array<{ task: TaskRecord; reason: string }>; activeCount: number } {
    const tasks = this.listTasks(executionId);
    const active = tasks.filter((t) => ACTIVE_STATES.has(t.status));
    // Recovered-but-unverified work also holds its files until it is verified.
    const claimed = [...active, ...tasks.filter((t) => t.status === 'READY' && t.verifyFirst)].flatMap((t) => t.files);
    const ready: TaskRecord[] = [];
    const deferred: Array<{ task: TaskRecord; reason: string }> = [];
    let slots = Math.max(0, maxParallel - active.length);
    for (const t of tasks.filter((x) => x.status === 'READY').sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (t.verifyFirst) {
        deferred.push({ task: t, reason: 'interrupted with changes on disk: run `kilamu task submit` + `kilamu verify` before re-dispatching' });
        continue;
      }
      const clash = t.files.find((f) => claimed.some((c) => filesOverlap(f, c)));
      if (clash) {
        deferred.push({ task: t, reason: `owned file ${clash} is held by an active task` });
        continue;
      }
      if (slots <= 0) {
        deferred.push({ task: t, reason: `parallel limit (${maxParallel}) reached` });
        continue;
      }
      ready.push(t);
      claimed.push(...t.files);
      slots--;
    }
    return { ready, deferred, activeCount: active.length };
  }

  /** READY → RUNNING. Enforces ownership exclusivity and the retry ceiling. */
  startTask(executionId: string, taskId: string, owner: string, checkpointId: string, sessionId: string | null = null): TaskRecord {
    let exhausted: TaskRecord | null = null;
    const started = tx(this.db, () => {
      const t = this.getTask(executionId, taskId);
      if (t.status !== 'READY') throw new KilamuError('INVALID_TRANSITION', `Task ${taskId} is ${t.status}; only READY tasks can start`);
      if (t.attempts >= t.maxRetries + 1) {
        this.writeTransition(t, 'BLOCKED', 'scheduler', `retry limit reached (${t.attempts}/${t.maxRetries + 1} attempts)`);
        exhausted = t;
        return null;
      }
      const others = this.listTasks(executionId).filter((x) => x.id !== taskId && ACTIVE_STATES.has(x.status));
      for (const o of others) {
        const shared = t.files.filter((f) => o.files.some((g) => filesOverlap(f, g)));
        if (shared.length) {
          throw new KilamuError('FILE_CONFLICT', `Task ${taskId} cannot start: ${shared.join(', ')} owned by active task ${o.id}`, { holder: o.id, files: shared });
        }
      }
      this.writeTransition(t, 'RUNNING', owner, `started (attempt ${t.attempts + 1}/${t.maxRetries + 1})`, {
        owner, attempts: t.attempts + 1, checkpointId, sessionId, verifyFirst: false,
      });
      return this.getTask(executionId, taskId);
    });
    if (exhausted) {
      this.refreshReadiness(executionId);
      throw new KilamuError('RETRY_LIMIT', `Task ${taskId} exhausted its attempts and is now BLOCKED`);
    }
    return started!;
  }

  /** RUNNING → VERIFYING (or READY → VERIFYING for reconciled verify-first tasks). */
  submitTask(executionId: string, taskId: string, actor: string, summary: string, artifacts: string[]): TaskRecord {
    return tx(this.db, () => {
      const t = this.getTask(executionId, taskId);
      if (t.status === 'READY' && !t.verifyFirst) {
        throw new KilamuError('INVALID_TRANSITION', `Task ${taskId} is READY; run \`kilamu task start ${taskId}\` first (each verification needs an attempt)`);
      }
      if (t.status !== 'RUNNING' && t.status !== 'READY') {
        throw new KilamuError('INVALID_TRANSITION', `Task ${taskId} is ${t.status}; submit requires RUNNING`);
      }
      const merged = [...new Set([...t.outputArtifacts, ...artifacts])];
      this.writeTransition(t, 'VERIFYING', actor, t.status === 'READY' ? 'recovered work submitted for verification' : 'submitted for verification', {
        resultSummary: summary, outputArtifacts: merged,
      });
      return this.getTask(executionId, taskId);
    });
  }

  /**
   * Apply a verification report. The run must exist (looked up through the
   * verification module), match the report, and be bound to the task's
   * current attempt. FAILED tasks with attempts left return to READY;
   * otherwise BLOCKED.
   */
  applyVerification(report: VerificationReport, lookup: RunLookup): TaskRecord {
    const run = lookup(report.runId);
    if (!run || run.verdict !== report.verdict || run.executionId !== report.executionId || run.taskId !== report.taskId) {
      throw new KilamuError('VERIFICATION_REQUIRED', `Verification run ${report.runId} not found or does not match the report`);
    }
    const result = tx(this.db, () => {
      let t = this.getTask(report.executionId, report.taskId);
      if (run.checkpointId !== t.checkpointId) {
        throw new KilamuError('STALE_VERIFICATION', `Run ${report.runId} verified a different attempt of ${t.id}; re-run kilamu verify`);
      }
      if (t.status === 'RUNNING' || (t.status === 'READY' && t.verifyFirst)) {
        this.writeTransition(t, 'VERIFYING', 'verification-engine', 'verification started');
        t = this.getTask(report.executionId, report.taskId);
      }
      if (t.status !== 'VERIFYING') throw new KilamuError('INVALID_TRANSITION', `Task ${t.id} is ${t.status}; cannot apply verification`);
      if (report.verdict === 'VERIFIED') {
        this.writeTransition(t, 'VERIFIED', 'verification-engine', `all ${report.results.length} criteria satisfied (run ${report.runId})`, { verifyFirst: false });
      } else {
        const failed = report.results.filter((r) => r.status !== 'PASS' && r.status !== 'ATTESTED').map((r) => r.criterionId);
        this.writeTransition(t, 'FAILED', 'verification-engine', `criteria not satisfied: ${failed.join(', ')} (run ${report.runId})`, { verifyFirst: false });
        const after = this.getTask(report.executionId, report.taskId);
        if (after.attempts < after.maxRetries + 1) {
          this.writeTransition(after, 'READY', 'scheduler', `retry available (${after.attempts}/${after.maxRetries + 1} attempts used)`, { owner: null });
        } else {
          this.writeTransition(after, 'BLOCKED', 'scheduler', `retries exhausted after ${after.attempts} attempts; needs human or replanning`);
        }
      }
      return this.getTask(report.executionId, report.taskId);
    });
    this.refreshReadiness(report.executionId);
    return result;
  }

  blockTask(executionId: string, taskId: string, actor: string, reason: string): TaskRecord {
    return this.transition(executionId, taskId, 'BLOCKED', actor, `blocker: ${reason}`);
  }

  /** Human unblock: grants one more attempt, at most MAX_UNBLOCKS times per task. */
  unblockTask(executionId: string, taskId: string, actor: string, reason: string): TaskRecord {
    tx(this.db, () => {
      const t = this.getTask(executionId, taskId);
      if (t.status !== 'BLOCKED') throw new KilamuError('INVALID_TRANSITION', `Task ${taskId} is not BLOCKED`);
      const used = this.unblockCount(executionId, taskId);
      if (used >= MAX_UNBLOCKS) {
        throw new KilamuError('UNBLOCK_LIMIT', `Task ${taskId} was already unblocked ${used} times; replan it (cancel and create a new task) instead`);
      }
      this.writeTransition(t, 'WAITING', actor, `unblocked: ${reason}`, { attempts: Math.min(t.attempts, t.maxRetries), unblocks: used + 1 });
    });
    this.refreshReadiness(executionId, actor);
    return this.getTask(executionId, taskId);
  }

  /** RUNNING/VERIFYING → READY: the agent is gone (interruption, stall). Keeps attempts. */
  releaseTask(executionId: string, taskId: string, actor: string, reason: string, verifyFirst = false): TaskRecord {
    return tx(this.db, () => {
      const t = this.getTask(executionId, taskId);
      if (!ACTIVE_STATES.has(t.status)) throw new KilamuError('INVALID_TRANSITION', `Task ${taskId} is ${t.status}; only active tasks can be released`);
      this.writeTransition(t, 'READY', actor, reason, { owner: null, verifyFirst });
      return this.getTask(executionId, taskId);
    });
  }

  // --------------------------------------------------------------- checkpoints

  addCheckpoint(input: { executionId: string; taskId: string | null; kind: string; gitHead: string | null; data: Record<string, unknown> }): Checkpoint {
    const id = newId('cp');
    const at = nowIso();
    this.db.prepare('INSERT INTO checkpoints(id, execution_id, task_id, kind, git_head, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.executionId, input.taskId, input.kind, input.gitHead, JSON.stringify(input.data), at);
    return { id, executionId: input.executionId, taskId: input.taskId, kind: input.kind, gitHead: input.gitHead, data: input.data, createdAt: at };
  }

  getCheckpoint(id: string): Checkpoint | null {
    const r = this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as
      | { id: string; execution_id: string; task_id: string | null; kind: string; git_head: string | null; data_json: string; created_at: string } | undefined;
    if (!r) return null;
    return { id: r.id, executionId: r.execution_id, taskId: r.task_id, kind: r.kind, gitHead: r.git_head, data: parseJson(r.data_json, {}), createdAt: r.created_at };
  }

  // ------------------------------------------------------------------ summary

  summary(executionId: string): ExecutionSummary {
    const ex = this.getExecution(executionId);
    const tasks = this.listTasks(executionId);
    const counts: Partial<Record<TaskStatus, number>> = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
    const live = tasks.filter((t) => t.status !== 'CANCELLED');
    const verified = counts.VERIFIED ?? 0;
    const blocked = tasks.filter((t) => t.status === 'BLOCKED');
    const canProgress = tasks.some((t) => ['READY', 'RUNNING', 'VERIFYING', 'FAILED'].includes(t.status));
    return {
      execution: ex,
      tasks,
      counts,
      total: live.length,
      verified,
      cancelled: counts.CANCELLED ?? 0,
      progressPct: live.length ? Math.round((verified / live.length) * 100) : 0,
      stalled: ex.status === 'ACTIVE' && !canProgress && blocked.length > 0,
      blocked: blocked.map((t) => t.id),
    };
  }
}

export interface ExecutionSummary {
  execution: ExecutionRecord;
  tasks: TaskRecord[];
  counts: Partial<Record<TaskStatus, number>>;
  total: number;
  verified: number;
  cancelled: number;
  progressPct: number;
  stalled: boolean;
  blocked: string[];
}
