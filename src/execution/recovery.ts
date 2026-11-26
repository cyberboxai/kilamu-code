import { oneLine } from '../core/redact.ts';
import type { TaskRecord } from '../core/types.ts';
import { changedSince, gitHead, hashFiles } from './git.ts';
import { ACTIVE_STATES, type ExecutionStore, type ExecutionSummary } from './store.ts';

/**
 * Session recovery and reconciliation (directive §13).
 *
 * Native subagents/teammates do not survive a process restart (documented
 * limitation), so on a new or resumed session every RUNNING/VERIFYING task is
 * orphaned. We never replay blindly: each orphan is released to READY and
 * tagged with what changed in its owned files since its start checkpoint, so
 * the resume flow can verify first and only re-run work that is still needed.
 */

export interface ReconciledTask {
  taskId: string;
  previousStatus: string;
  changedFiles: string[];
  /** Verification may already pass (or changes cannot be ruled out): verify before re-running. */
  verifyFirst: boolean;
}

export interface ReconcileReport {
  executionId: string;
  reconciled: ReconciledTask[];
  /** Active tasks left alone because another, possibly live, session owns them. */
  heldByOtherSessions: Array<{ taskId: string; sessionId: string }>;
  headMoved: boolean;
}

/** An active task from another session is presumed orphaned after this long without updates. */
export const ORPHAN_AFTER_MS = 2 * 60 * 60_000;

export interface ReconcileOptions {
  /** Release every active task regardless of owning session (`kilamu recover --force`). */
  force?: boolean;
  /**
   * The session whose PROCESS just (re)started (SessionStart startup/resume):
   * its own agents died with the old process, so its tasks are orphaned.
   * Never set for a plain `kilamu recover` (the caller's agents may be live).
   */
  restartedSession?: string | null;
  /** When a session last ended (SessionEnd hook), or null. */
  endedAt?: (sessionId: string) => string | null;
  now?: number;
}

/**
 * A task is orphaned when: forced; its session is the one whose process just
 * restarted; its session ended AFTER the task's last update; or it has been
 * silent for ORPHAN_AFTER_MS. Tasks with no recorded session are only released
 * by force or silence — ownership is never guessed.
 */
function isOrphaned(t: TaskRecord, opts: ReconcileOptions): boolean {
  if (opts.force) return true;
  const owner = t.sessionId ?? null;
  if (owner && opts.restartedSession && owner === opts.restartedSession) return true;
  const ended = owner ? opts.endedAt?.(owner) ?? null : null;
  if (ended && ended >= t.updatedAt) return true;
  return (opts.now ?? Date.now()) - Date.parse(t.updatedAt) > ORPHAN_AFTER_MS;
}

export async function reconcileExecution(store: ExecutionStore, root: string, executionId: string, sessionId: string | null, opts: ReconcileOptions = {}): Promise<ReconcileReport> {
  const tasks = store.listTasks(executionId).filter((t) => ACTIVE_STATES.has(t.status));
  const ex = store.getExecution(executionId);
  const head = await gitHead(root);
  const reconciled: ReconciledTask[] = [];
  const held: Array<{ taskId: string; sessionId: string }> = [];
  for (const t of tasks) {
    if (!isOrphaned(t, opts)) {
      held.push({ taskId: t.id, sessionId: t.sessionId ?? 'unknown' });
      continue;
    }
    const cp = t.checkpointId ? store.getCheckpoint(t.checkpointId) : null;
    const snapshot = (cp?.data.files ?? null) as Record<string, string | null> | null;
    const changedFiles = snapshot ? changedSince(root, snapshot) : [];
    // Conservative: without a snapshot, or with owned directories (not hashed),
    // we cannot prove nothing changed — so verify before any re-run.
    const unprovable = !snapshot || t.files.some((f) => f.endsWith('/'));
    const verifyFirst = changedFiles.length > 0 || unprovable || t.status === 'VERIFYING';
    const reason = verifyFirst
      ? `interrupted; ${unprovable ? 'owned-file changes cannot be ruled out' : `${changedFiles.length} owned file(s) changed since start`} — verify before re-running`
      : 'interrupted; no owned-file changes since start — safe to re-run';
    store.releaseTask(executionId, t.id, 'reconciler', reason, verifyFirst);
    reconciled.push({ taskId: t.id, previousStatus: t.status, changedFiles, verifyFirst });
  }
  if (sessionId) store.touchSession(executionId, sessionId);
  store.refreshReadiness(executionId, 'reconciler');
  return { executionId, reconciled, heldByOtherSessions: held, headMoved: !!(ex.baseCommit && head && head !== ex.baseCommit) };
}

/** Snapshot owned-file hashes for a task start checkpoint. */
export async function startCheckpointData(root: string, t: TaskRecord): Promise<{ gitHead: string | null; data: Record<string, unknown> }> {
  return { gitHead: await gitHead(root), data: { files: hashFiles(root, t.files), attempt: t.attempts + 1 } };
}

function list(ids: string[], max = 8): string {
  if (!ids.length) return '-';
  return ids.length > max ? `${ids.slice(0, max).join(', ')} (+${ids.length - max})` : ids.join(', ');
}

/**
 * Compact orientation text (≤ ~1.5K chars) injected at SessionStart. It points
 * to durable state rather than copying it, to keep context small.
 */
export function orientation(s: ExecutionSummary, recon: ReconcileReport | null): string {
  const by = (st: string) => s.tasks.filter((t) => t.status === st).map((t) => t.id);
  const lines = [
    `[Kilamu Code] Active execution ${s.execution.id}: ${JSON.stringify(oneLine(s.execution.objective, 120))}`,
    `mode=${s.execution.mode} progress=${s.verified}/${s.total} VERIFIED (${s.progressPct}%)${s.stalled ? ' STALLED' : ''}`,
    `ready: ${list(by('READY'))} | running: ${list(by('RUNNING'))} | verifying: ${list(by('VERIFYING'))} | waiting: ${list(by('WAITING'))} | blocked: ${list(by('BLOCKED'))}`,
  ];
  if (recon?.reconciled.length) {
    const vf = recon.reconciled.filter((r) => r.verifyFirst).map((r) => r.taskId);
    lines.push(`Reconciled ${recon.reconciled.length} interrupted task(s) to READY. Verify first (owned files changed): ${list(vf)}.`);
  }
  if (recon?.heldByOtherSessions.length) {
    lines.push(`Left running (another session may still own them): ${list(recon.heldByOtherSessions.map((h) => h.taskId))}. If no other Claude session is working in this project: kilamu recover --force.`);
  }
  if (recon?.headMoved) lines.push('Git HEAD moved since the plan was created — re-check assumptions before continuing.');
  lines.push('To continue, use the kilamu-code:resume skill, or run `kilamu status` then `kilamu next`. Task state lives in .kilamu; do not re-plan completed (VERIFIED) work.');
  return lines.join('\n');
}

/** Instructions for the compaction summarizer (PreCompact stdout; capped by Claude Code at 10K chars). */
export function compactionInstructions(s: ExecutionSummary): string {
  const by = (st: string) => s.tasks.filter((t) => t.status === st).map((t) => `${t.id} (${oneLine(t.title, 60)})`);
  return [
    `Preserve Kilamu Code execution state in the summary:`,
    `- Execution ${s.execution.id}, objective (user/model-authored data): ${JSON.stringify(oneLine(s.execution.objective, 200))}`,
    `- Mode ${s.execution.mode}; ${s.verified}/${s.total} tasks VERIFIED.`,
    `- Verified: ${list(by('VERIFIED'), 20)}`,
    `- In progress: ${list([...by('RUNNING'), ...by('VERIFYING')], 20)}`,
    `- Ready next: ${list(by('READY'), 20)}`,
    `- Blocked: ${list(by('BLOCKED'), 20)}`,
    `- Keep decisions, unresolved blockers and artifact ids (a_...) mentioned in the conversation.`,
    `- After compaction, authoritative state is available via \`kilamu status ${s.execution.id}\`.`,
  ].join('\n');
}
