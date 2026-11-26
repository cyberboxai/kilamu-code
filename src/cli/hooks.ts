import { appendFileSync } from 'node:fs';
import { App } from '../app.ts';
import { Logger } from '../core/log.ts';
import { projectPaths } from '../core/paths.ts';
import { isInitialized } from '../core/trust.ts';
import { fenceUntrusted } from '../core/redact.ts';
import { compressAndStore, renderSummary } from '../context/compress.ts';
import { compactionInstructions, orientation, reconcileExecution, type ReconcileReport } from '../execution/recovery.ts';
import { readStdin } from './args.ts';
import { recordPluginRoot } from './statusline.ts';

/**
 * Claude Code hook handlers. Contract:
 *  - Fast and local: never call a model, never index.
 *  - No-op (exit 0, no output) unless the project's data dir was created by
 *    `kilamu init` for this user (trusted) — never act on a `.kilamu/` that
 *    arrived with a cloned repository, never create state uninvited.
 *  - Internal failures exit 0 (logged) so Kilamu can never break a session;
 *    only the TaskCompleted verification gate uses exit 2 deliberately.
 */
export interface HookOutcome {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}

type Payload = Record<string, unknown>;

function projectRoot(p: Payload): string {
  return process.env.CLAUDE_PROJECT_DIR ?? (typeof p.cwd === 'string' ? p.cwd : process.cwd());
}

function s(v: unknown): string | null {
  return typeof v === 'string' && v.length ? v : null;
}

/** `[kilamu:<exec>/<task>]` (preferred) or legacy `[kilamu:<task>]`. */
export const TASK_SUBJECT_TAG = /\[kilamu:(?:(ex_[a-z0-9]+)\/)?([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\]/;

/**
 * Export the session id to this session's Bash commands (documented
 * CLAUDE_ENV_FILE mechanism for SessionStart hooks) so `kilamu task start`
 * attributes tasks to the right session even when several sessions share a project.
 */
function exportSessionEnv(sid: string): void {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile || !/^[A-Za-z0-9_-]{1,128}$/.test(sid)) return;
  try {
    appendFileSync(envFile, `export KILAMU_SESSION_ID=${sid}\n`, { mode: 0o600 });
  } catch {
    // best effort: without it, tasks stay unattributed (safe, just less automatic recovery)
  }
}

export async function sessionStart(app: App, p: Payload): Promise<HookOutcome> {
  const sid = s(p.session_id);
  if (sid) {
    app.setSessionId(sid);
    exportSessionEnv(sid);
    app.executions.clearSessionEnd(sid);
  }
  const source = s(p.source) ?? 'startup';
  const active = app.executions.listExecutions({ status: 'ACTIVE', limit: 10 });
  if (!active.length) return { exitCode: 0 };
  // New process (startup/resume): agents from the previous process are gone → reconcile.
  // compact/clear/fork keep the process; only re-orient.
  let recon: ReconcileReport | null = null;
  if (source === 'startup' || source === 'resume') {
    // Only tasks of this session (restarted process) or of ended/silent sessions
    // are released; another live session's agents are left alone.
    for (const ex of active) {
      const r = await reconcileExecution(app.executions, app.rt.paths.root, ex.id, sid, {
        restartedSession: sid,
        endedAt: (x) => app.executions.sessionEndedAt(x),
      });
      if (ex.id === active[0]!.id) recon = r;
    }
  }
  let text = orientation(app.executions.summary(active[0]!.id), recon);
  if (active.length > 1) text += `\n(${active.length - 1} other ACTIVE execution(s): kilamu execution list)`;
  app.events.emit('hook.session_start', { source, reconciled: recon?.reconciled.length ?? 0 }, { executionId: active[0]!.id });
  return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }), exitCode: 0 };
}

export function preCompact(app: App, p: Payload): HookOutcome {
  const ex = app.executions.activeExecution();
  if (!ex) return { exitCode: 0 };
  const summary = app.executions.summary(ex.id);
  app.executions.addCheckpoint({
    executionId: ex.id, taskId: null, kind: 'pre-compact', gitHead: null,
    data: { trigger: s(p.trigger), counts: summary.counts, verified: summary.verified, total: summary.total },
  });
  // Plain stdout on exit 0 becomes compaction-summary instructions (documented, ≤ 10K chars).
  return { stdout: compactionInstructions(summary).slice(0, 9_500), exitCode: 0 };
}

/** Record that a session ended so the next SessionStart may reconcile its orphaned tasks. */
export function sessionEnd(app: App, p: Payload): HookOutcome {
  const sid = s(p.session_id);
  if (sid && /^[A-Za-z0-9_-]{1,128}$/.test(sid)) app.executions.markSessionEnded(sid, s(p.reason));
  return { exitCode: 0 };
}

export function taskCompleted(app: App, p: Payload): HookOutcome {
  const subject = s(p.task_subject) ?? '';
  const m = TASK_SUBJECT_TAG.exec(subject);
  if (!m) return { exitCode: 0 }; // not a Kilamu-tracked task
  const [, execId, taskId] = m;
  // Qualified tag → that execution only; legacy tag → every ACTIVE execution containing the task
  // (the gate holds if ANY of them is not done).
  const candidates = execId ? [execId] : app.executions.listExecutions({ status: 'ACTIVE', limit: 50 }).map((e) => e.id);
  const statuses: string[] = [];
  for (const id of candidates) {
    try {
      statuses.push(app.executions.getTask(id, taskId!).status);
    } catch {
      // task not in this execution
    }
  }
  const status = statuses.find((x) => x !== 'VERIFIED' && x !== 'CANCELLED') ?? null;
  if (status === null) return { exitCode: 0 };
  return {
    stderr: `Kilamu task ${taskId} is ${status}, not VERIFIED. Run \`kilamu task submit ${taskId}${execId ? ` --exec ${execId}` : ''} --summary "…"\` and \`kilamu verify ${taskId}${execId ? ` --exec ${execId}` : ''}\`; mark this task complete only after verification passes.`,
    exitCode: 2,
  };
}

export function postToolUse(app: App, p: Payload): HookOutcome {
  const cfg = app.rt.config.context;
  if (!cfg.compressToolOutput || p.tool_name !== 'Bash') return { exitCode: 0 };
  const resp = (typeof p.tool_response === 'object' && p.tool_response !== null ? p.tool_response : {}) as Record<string, unknown>;
  const out = [s(resp.stdout), s(resp.stderr)].filter(Boolean).join('\n');
  if (out.length < cfg.compressThresholdChars) return { exitCode: 0 };
  const input = (typeof p.tool_input === 'object' && p.tool_input !== null ? p.tool_input : {}) as Record<string, unknown>;
  const command = s(input.command) ?? 'bash';
  const summary = compressAndStore(app.artifacts, out, { source: command.slice(0, 200), command: command.slice(0, 200), kind: 'command-output' });
  const text = `${fenceUntrusted(`compressed output of ${command.slice(0, 80)}`, renderSummary(summary))}\n[Kilamu compressed ${out.length} chars of output; full text: kilamu artifact show ${summary.artifactId}]`;
  return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: text } }), exitCode: 0 };
}

const HANDLERS: Record<string, (app: App, p: Payload) => HookOutcome | Promise<HookOutcome>> = {
  'session-start': sessionStart,
  'pre-compact': preCompact,
  'task-completed': taskCompleted,
  'post-tool-use': postToolUse,
  'session-end': sessionEnd,
};

/** Entry for `kilamu hook <event>`; reads the hook JSON from stdin. */
export async function runHook(event: string, rawInput?: string): Promise<HookOutcome> {
  const handler = HANDLERS[event];
  if (!handler) return { stderr: `kilamu: unknown hook event ${event}`, exitCode: 1 };
  let payload: Payload = {};
  try {
    const raw = rawInput ?? (await readStdin(4 * 1024 * 1024));
    const parsed = raw.trim() ? (JSON.parse(raw) as unknown) : {};
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) payload = parsed as Payload;
  } catch {
    return { exitCode: 0 };
  }
  // Keep the update-safe statusline shim pointed at the installed plugin version
  // (user-scope pointer; written only when it changes; runs in every project).
  if (event === 'session-start' && process.env.CLAUDE_PLUGIN_ROOT) recordPluginRoot(process.env.CLAUDE_PLUGIN_ROOT);
  const root = projectRoot(payload);
  const paths = projectPaths(root);
  if (!isInitialized(paths)) return { exitCode: 0 };
  let app: App | null = null;
  try {
    app = App.open(root);
    return await handler(app, payload);
  } catch (e) {
    new Logger(paths.logsDir, 'hook').error('hook.failed', { event, error: (e as Error).message.slice(0, 300) });
    return { exitCode: 0 };
  } finally {
    app?.close();
  }
}
