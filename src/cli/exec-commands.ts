import type { App } from '../app.ts';
import { KilamuError } from '../core/errors.ts';
import { parseCommand } from '../core/exec.ts';
import { parseJsonStrict, readProjectFile, safeResolve } from '../core/paths.ts';
import { oneLine } from '../core/redact.ts';
import { formatTokens } from '../core/tokens.ts';
import type { ExecutionRecord, PlanSpec, TaskRecord } from '../core/types.ts';
import { assertArtifactId } from '../context/artifacts.ts';
import { shouldStop } from '../cost/policy.ts';
import { costReport, renderCostReport } from '../cost/report.ts';
import { gitHead } from '../execution/git.ts';
import { reconcileExecution, startCheckpointData } from '../execution/recovery.ts';
import type { ExecutionSummary } from '../execution/store.ts';
import { buildBrief } from '../orchestrator/brief.ts';
import { preparePlan, type PreparedPlan } from '../orchestrator/planner.ts';
import { detectTeams } from '../observability/doctor.ts';
import { commandPolicyError, getRun, latestRun, renderReport } from '../verification/engine.ts';
import { flag, int, list, parse, parseSub, pos, readStdin, req, str } from './args.ts';
import type { CommandResult } from './output.ts';

const STALE_MS = 30 * 60_000;

function planText(p: PreparedPlan): string {
  const lines = [
    `Objective: ${oneLine(p.plan.objective)}`,
    `Mode: ${p.decision.mode}${p.decision.mode !== 'SINGLE' ? ` (${p.decision.teamSize} agents)` : ''}`,
    ...p.decision.reasons.map((r) => `  - ${r}`),
    ...p.decision.constraints.map((c) => `  ! ${c}`),
    `Graph: ${p.plan.tasks.length} tasks, ${p.analysis.levels.length} levels, max width ${p.analysis.maxWidth}, parallelism bound ${p.analysis.parallelism.toFixed(2)}`,
    `Budget: ${formatTokens(p.budget.total)} tokens (ESTIMATED) → execution budget ${formatTokens(p.budgetTokens)}`,
    ...p.budget.components.map((c) => `  - ${c.name}: ${formatTokens(c.tokens)} (${c.note})`),
  ];
  if (p.issues.length) lines.push('Issues:', ...p.issues.map((i) => `  [${i.severity}]${i.taskId ? ` ${i.taskId}:` : ''} ${i.message}`));
  lines.push('Tasks:');
  for (const level of p.analysis.levels) {
    for (const id of level) {
      const t = p.plan.tasks.find((x) => x.id === id)!;
      lines.push(`  ${t.id.padEnd(12)} ${t.role.padEnd(18)} ${t.complexity.padEnd(7)} ${t.dependsOn.length ? `after ${t.dependsOn.join(',')}` : 'start'} — ${oneLine(t.title, 120)}`);
    }
  }
  const commands = p.plan.tasks.flatMap((t) => t.acceptance.filter((c) => c.kind === 'command').map((c) => `  ${t.id}: ${(c as { command: string }).command}`));
  if (commands.length) lines.push('Verification commands (run by `kilamu verify` without a shell, policy-checked):', ...commands);
  return lines.join('\n');
}

/** Reject plans whose acceptance commands the verification policy would refuse — fail early, at planning time. */
function checkPlanCommands(app: App, plan: PlanSpec): void {
  const errors: string[] = [];
  for (const t of plan.tasks) {
    for (const c of t.acceptance) {
      if (c.kind !== 'command') continue;
      try {
        const argv = parseCommand(c.command);
        const denied = commandPolicyError(argv, app.rt.paths.root, safeResolve(app.rt.paths.root, c.cwd ?? '.'));
        if (denied) errors.push(`[${t.id}] ${c.id}: ${denied}`);
      } catch (e) {
        errors.push(`[${t.id}] ${c.id}: ${(e as Error).message}`);
      }
    }
  }
  if (errors.length) throw new KilamuError('PLAN_INVALID', `Plan rejected — verification commands not allowed:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
}

export async function cmdPlan(app: App, argv: string[]): Promise<CommandResult> {
  const { sub, p } = parseSub(argv, { file: { type: 'string', short: 'f' }, stdin: { type: 'boolean' }, 'dry-run': { type: 'boolean' } });
  if (sub === 'show') {
    const ex = app.executions.resolveExecution(p.positionals[0]);
    const plan = app.executions.planJson(ex.id);
    return { data: { execution: ex, plan }, text: `${ex.id} ${ex.status} mode=${ex.mode}\n${ex.modeRationale.reasons.map((r) => `  - ${r}`).join('\n')}\n${JSON.stringify(plan, null, 2)}` };
  }
  if (sub !== 'create' && sub !== 'check') throw new KilamuError('USAGE', 'usage: kilamu plan create|check --file plan.json | --stdin ; kilamu plan show [exec]');
  const raw = flag(p, 'stdin') ? await readStdin(2 * 1024 * 1024) : readProjectFile(app.rt.paths.root, req(p, 'file', 'path to plan JSON inside the project'), 2 * 1024 * 1024);
  const json = parseJsonStrict(raw, 'Plan');
  const teams = detectTeams(app.rt.paths.root);
  const prepared = preparePlan(json, app.rt.config, { teamsAvailable: teams.available });
  checkPlanCommands(app, prepared.plan);
  if (sub === 'check' || flag(p, 'dry-run')) {
    return { data: { dryRun: true, ...prepared }, text: `${planText(prepared)}\n\n(dry run: nothing was saved)` };
  }
  const active = app.executions.activeExecution();
  if (active && active.objective.trim().toLowerCase() === prepared.plan.objective.trim().toLowerCase()) {
    throw new KilamuError('DUPLICATE_EXECUTION', `Execution ${active.id} with the same objective is already ACTIVE — resume it (kilamu status) or cancel it first`);
  }
  const ex = app.executions.createExecution({
    plan: prepared.plan,
    decision: prepared.decision,
    budgetTokens: prepared.budgetTokens,
    sessionId: app.sessionId ?? app.lastSeenSessionId,
    baseCommit: await gitHead(app.rt.paths.root),
  });
  app.events.emit('plan.created', { mode: ex.mode, tasks: prepared.plan.tasks.length, budget: prepared.budgetTokens }, { executionId: ex.id });
  const warn = active ? `\nNote: execution ${active.id} is also ACTIVE.` : '';
  return {
    data: { execution: ex, ...prepared },
    text: `Created execution ${ex.id}\n${planText(prepared)}${warn}\n\nNext: kilamu next   (dispatch ready tasks)`,
  };
}

/** MEASURED tokens since the execution started, summed over every session linked to it. */
function measuredUsage(app: App, ex: ExecutionRecord): number | null {
  const sessions = app.executions.sessionsFor(ex.id);
  const ids = sessions.length ? sessions : ex.sessionId ? [{ sessionId: ex.sessionId, firstSeen: ex.createdAt }] : [];
  let total: number | null = null;
  for (const s of ids) {
    const since = s.firstSeen > ex.createdAt ? s.firstSeen : ex.createdAt;
    const d = app.usage.deltaSince(s.sessionId, since);
    if (d && (d.inputTokens !== null || d.outputTokens !== null)) total = (total ?? 0) + (d.inputTokens ?? 0) + (d.outputTokens ?? 0);
  }
  return total;
}

function budgetLine(app: App, ex: ExecutionRecord): { text: string; usedTokens: number | null; stop: ReturnType<typeof shouldStop> | null } {
  const used = measuredUsage(app, ex);
  if (used === null) return { text: `budget ${formatTokens(ex.budgetTokens)} (usage UNAVAILABLE — install the statusline HUD to measure)`, usedTokens: null, stop: null };
  const stop = shouldStop({ usedTokens: used, budgetTokens: ex.budgetTokens, verificationReserve: app.rt.config.execution.verificationReserve });
  return { text: `budget ${formatTokens(used)} / ${formatTokens(ex.budgetTokens)} tokens used (MEASURED, all linked sessions)${stop.warn || stop.stop ? ` — ${stop.reason}` : ''}`, usedTokens: used, stop };
}

function statusText(app: App, s: ExecutionSummary): string {
  const ex = s.execution;
  const now = Date.now();
  const lines = [
    `${ex.id}  ${ex.status}  mode=${ex.mode}  ${s.verified}/${s.total} VERIFIED (${s.progressPct}%)${s.cancelled ? `  ${s.cancelled} cancelled` : ''}${s.stalled ? '  STALLED' : ''}`,
    `objective: ${oneLine(ex.objective)}`,
    budgetLine(app, ex).text,
  ];
  for (const t of s.tasks) {
    const stale = (t.status === 'RUNNING' || t.status === 'VERIFYING') && now - Date.parse(t.updatedAt) > STALE_MS ? '  (stale? no update for 30m)' : '';
    const vf = t.verifyFirst ? '  (verify first)' : '';
    const last = app.executions.taskEvents(ex.id, t.id, 1)[0];
    lines.push(`  ${t.id.padEnd(12)} ${t.status.padEnd(9)} ${t.role.padEnd(18)} ${oneLine(t.title, 100)}${stale}${vf}`);
    if (last && ['BLOCKED', 'READY', 'FAILED'].includes(t.status) && last.actor !== 'planner') lines.push(`  ${''.padEnd(12)} └ ${oneLine(last.reason, 200)}`);
  }
  return lines.join('\n');
}

export function cmdStatus(app: App, argv: string[]): CommandResult {
  const p = parse(argv, {});
  const ex = app.executions.activeExecution();
  if (!p.positionals[0] && !ex) {
    const recent = app.executions.listExecutions({ limit: 5 });
    return { data: { active: null, recent }, text: recent.length ? `No ACTIVE execution. Recent:\n${recent.map((r) => `  ${r.id} ${r.status} ${oneLine(r.objective, 100)}`).join('\n')}` : 'No Kilamu executions yet. Use the orchestrate skill or `kilamu plan create`.' };
  }
  const s = app.executions.summary(app.executions.resolveExecution(p.positionals[0]).id);
  return { data: s, text: statusText(app, s) };
}

export function cmdNext(app: App, argv: string[]): CommandResult {
  const p = parse(argv, { exec: { type: 'string' } });
  const ex = app.executions.resolveExecution(str(p, 'exec'));
  if (ex.status !== 'ACTIVE') return { data: { execution: ex.id, status: ex.status, ready: [] }, text: `Execution ${ex.id} is ${ex.status}; nothing to dispatch.` };
  app.executions.refreshReadiness(ex.id);
  const budget = budgetLine(app, ex);
  if (budget.stop?.stop) {
    return { data: { execution: ex.id, ready: [], budgetStop: budget.stop }, text: `Budget stop: ${budget.stop.reason}. Finish in-flight tasks, then run \`kilamu report\`.` };
  }
  const maxParallel = ex.mode === 'SINGLE' ? 1 : Math.min(app.rt.config.execution.maxParallelAgents, Math.max(1, ex.modeRationale.teamSize));
  const n = app.executions.nextTasks(ex.id, maxParallel);
  const briefs = n.ready.map((t) => buildBrief(ex, t, app.rt.config));
  const s = app.executions.summary(ex.id);
  const lines = [`${ex.id} mode=${ex.mode} — ${n.ready.length} task(s) ready, ${n.activeCount} active, ${s.verified}/${s.total} VERIFIED`];
  if (budget.stop?.warn) lines.push(`! ${budget.stop.reason}`);
  for (const b of briefs) lines.push(`\n### ${b.taskId} → ${b.agentType ?? 'main session (lead does it)'} (model ${b.model})\n${b.prompt}`);
  for (const d of n.deferred) lines.push(`deferred ${d.task.id}: ${d.reason}`);
  if (!n.ready.length && !n.activeCount && !n.deferred.length) {
    lines.push(s.execution.status === 'COMPLETED' ? 'All tasks VERIFIED. Run `kilamu report`.' : s.stalled ? `Stalled: blocked tasks ${s.blocked.join(', ')} need attention (kilamu task unblock <id> --reason ...).` : 'Nothing ready.');
  }
  return { data: { execution: ex.id, mode: ex.mode, ready: briefs, deferred: n.deferred.map((d) => ({ id: d.task.id, reason: d.reason })), active: n.activeCount, budget: budget.text }, text: lines.join('\n') };
}

export function cmdBrief(app: App, argv: string[]): CommandResult {
  const p = parse(argv, { exec: { type: 'string' } });
  const ex = app.executions.resolveExecution(str(p, 'exec'));
  const b = buildBrief(ex, app.executions.getTask(ex.id, pos(p, 0, 'task-id')), app.rt.config);
  return { data: b, text: b.prompt };
}

function taskLine(t: TaskRecord): string {
  return `${t.id} ${t.status} (attempt ${t.attempts}/${t.maxRetries + 1})${t.verifyFirst ? ' [verify first]' : ''}`;
}

export async function cmdTask(app: App, argv: string[]): Promise<CommandResult> {
  const { sub, p } = parseSub(argv, {
    exec: { type: 'string' }, owner: { type: 'string' }, summary: { type: 'string' }, artifact: { type: 'string', multiple: true }, reason: { type: 'string' }, as: { type: 'string' },
  });
  const ex = app.executions.resolveExecution(str(p, 'exec'));
  const store = app.executions;
  const id = () => pos(p, 0, 'task-id');
  switch (sub) {
    case 'show': {
      const t = store.getTask(ex.id, id());
      const run = latestRun(app.rt.db, ex.id, t.id);
      return { data: { task: t, events: store.taskEvents(ex.id, t.id, 50), latestRun: run }, text: `${JSON.stringify(t, null, 2)}${run ? `\n\n${renderReport(run)}` : ''}` };
    }
    case 'events': {
      const evs = store.taskEvents(ex.id, id());
      return { data: evs, text: [...evs].reverse().map((e) => `${e.at} ${e.from ?? '-'} → ${e.to} [${oneLine(e.actor, 60)}] ${oneLine(e.reason, 300)}`).join('\n') };
    }
    case 'start': {
      store.refreshReadiness(ex.id);
      const t = store.getTask(ex.id, id());
      if (t.status !== 'READY') throw new KilamuError('INVALID_TRANSITION', `Task ${t.id} is ${t.status}; only READY tasks can start`);
      const cp = await startCheckpointData(app.rt.paths.root, t);
      const saved = store.addCheckpoint({ executionId: ex.id, taskId: t.id, kind: 'task-start', gitHead: cp.gitHead, data: cp.data });
      const started = store.startTask(ex.id, t.id, str(p, 'owner') ?? 'lead', saved.id, app.sessionId);
      app.events.emit('task.started', { owner: started.owner, attempt: started.attempts }, { executionId: ex.id, taskId: t.id });
      return { data: started, text: `${taskLine(started)} — checkpoint ${saved.id}\nOwned files: ${started.files.join(', ') || '(none)'}` };
    }
    case 'submit': {
      const arts = list(p, 'artifact');
      for (const a of arts) {
        assertArtifactId(a);
        app.artifacts.read(a, 1, 1); // throws if missing
      }
      const t = store.submitTask(ex.id, id(), str(p, 'owner') ?? 'agent', req(p, 'summary', 'what changed, where, open issues'), arts);
      return { data: t, text: `${taskLine(t)} — next: kilamu verify ${t.id}` };
    }
    case 'block': {
      const t = store.blockTask(ex.id, id(), str(p, 'owner') ?? 'agent', req(p, 'reason', 'why the task cannot proceed'));
      return { data: t, text: taskLine(t) };
    }
    case 'unblock': {
      const t = store.unblockTask(ex.id, id(), str(p, 'as') ?? 'user', req(p, 'reason', 'what changed'));
      return { data: t, text: taskLine(t) };
    }
    case 'release': {
      const t = store.releaseTask(ex.id, id(), 'lead', req(p, 'reason', 'why the agent stopped'));
      return { data: t, text: taskLine(t) };
    }
    case 'cancel': {
      const t = store.transition(ex.id, id(), 'CANCELLED', str(p, 'as') ?? 'user', req(p, 'reason', 'why'));
      return { data: t, text: taskLine(t) };
    }
    default:
      throw new KilamuError('USAGE', 'usage: kilamu task show|events|start|submit|block|unblock|release|cancel <task-id> [--exec id]');
  }
}

export async function cmdVerify(app: App, argv: string[]): Promise<CommandResult> {
  const p = parse(argv, { exec: { type: 'string' }, attest: { type: 'string', multiple: true }, as: { type: 'string' }, 'dry-run': { type: 'boolean' } });
  const ex = app.executions.resolveExecution(str(p, 'exec'));
  const t = app.executions.getTask(ex.id, pos(p, 0, 'task-id'));
  if (t.status === 'VERIFIED') {
    // Idempotent: the lead re-checking a task an agent already verified is not an error.
    const run = latestRun(app.rt.db, ex.id, t.id);
    return { data: { report: run, task: t, alreadyVerified: true }, text: `${run ? `${renderReport(run)}\n` : ''}Task ${t.id} is already VERIFIED.` };
  }
  const attestations: Record<string, string> = {};
  const attests = list(p, 'attest');
  if (attests.length) {
    const who = req(p, 'as', 'name of the reviewer making the attestation').trim().toLowerCase();
    const authors = [...app.executions.starters(ex.id, t.id), ...(t.owner ? [t.owner] : [])].map((a) => a.trim().toLowerCase());
    if (authors.includes(who)) {
      throw new KilamuError('SELF_ATTESTATION', `"${who}" worked on task ${t.id} and cannot attest its own work`);
    }
    for (const a of attests) {
      const i = a.indexOf('=');
      if (i <= 0) throw new KilamuError('USAGE', '--attest must look like <criterion-id>="what was checked"');
      attestations[a.slice(0, i)] = `${a.slice(i + 1)} (attested by ${who})`;
    }
  }
  const verifiable = t.status === 'RUNNING' || t.status === 'VERIFYING' || (t.status === 'READY' && t.verifyFirst);
  if (!verifiable) {
    throw new KilamuError('INVALID_TRANSITION', `Task ${t.id} is ${t.status}; verify needs a started attempt (run \`kilamu task start ${t.id}\`)`);
  }
  const dryRun = flag(p, 'dry-run');
  const report = await app.verifier.verifyTask(t, { attestations, dryRun });
  if (dryRun) return { data: report, text: `${renderReport(report)}\n(dry run: no state changed)` };
  const after = app.executions.applyVerification(report, (runId) => getRun(app.rt.db, runId));
  app.events.emit('task.verified', { verdict: report.verdict, runId: report.runId }, { executionId: ex.id, taskId: t.id });
  const s = app.executions.summary(ex.id);
  const tail = after.status === 'VERIFIED'
    ? `Task ${t.id} VERIFIED. Execution ${s.verified}/${s.total} (${s.progressPct}%)${s.execution.status === 'COMPLETED' ? ' — COMPLETED' : ''}.`
    : `Task ${t.id} → ${after.status} (attempt ${after.attempts}/${after.maxRetries + 1}). Inspect evidence with kilamu artifact show <id> --lines A-B.`;
  return { data: { report, task: after }, text: `${renderReport(report)}\n${tail}`, exitCode: report.verdict === 'VERIFIED' ? 0 : 1 };
}

export function cmdExecution(app: App, argv: string[]): CommandResult {
  const { sub, p } = parseSub(argv, { reason: { type: 'string' }, limit: { type: 'string' } });
  if (sub === 'list' || sub === undefined) {
    const rows = app.executions.listExecutions({ limit: int(p, 'limit', 20, 1, 500) });
    return { data: rows, text: rows.map((r) => `${r.id} ${r.status.padEnd(9)} ${r.mode.padEnd(8)} ${r.updatedAt} ${oneLine(r.objective, 100)}`).join('\n') || 'No executions.' };
  }
  if (sub === 'cancel') {
    const ex = app.executions.resolveExecution(pos(p, 0, 'execution-id'));
    app.executions.cancelExecution(ex.id, req(p, 'reason', 'why'));
    return { data: { cancelled: ex.id }, text: `Cancelled ${ex.id}` };
  }
  throw new KilamuError('USAGE', 'usage: kilamu execution list | cancel <id> --reason "..."');
}

export async function cmdRecover(app: App, argv: string[]): Promise<CommandResult> {
  const p = parse(argv, { force: { type: 'boolean' } });
  const active = app.executions.listExecutions({ status: 'ACTIVE', limit: 50 });
  const reports = [];
  for (const ex of active) {
    reports.push(await reconcileExecution(app.executions, app.rt.paths.root, ex.id, app.sessionId, {
      force: flag(p, 'force'),
      endedAt: (sid) => app.executions.sessionEndedAt(sid),
    }));
  }
  const lines = reports.map((r) => {
    const rec = r.reconciled.length ? r.reconciled.map((x) => `${x.taskId}${x.verifyFirst ? ' (verify first)' : ''}`).join(', ') : 'nothing to reconcile';
    const held = r.heldByOtherSessions.length ? `; left running (other live session?): ${r.heldByOtherSessions.map((h) => h.taskId).join(', ')} — use --force if that session is gone` : '';
    return `${r.executionId}: ${rec}${held}`;
  });
  return { data: reports, text: lines.join('\n') || 'No ACTIVE executions.' };
}

export function cmdReport(app: App, argv: string[]): CommandResult {
  const p = parse(argv, {});
  const ex = app.executions.resolveExecution(p.positionals[0]);
  const s = app.executions.summary(ex.id);
  const lines = [`KILAMU CODE — EXECUTION REPORT`, `${ex.id}: ${oneLine(ex.objective)}`, `mode ${ex.mode} · status ${ex.status} · ${s.verified}/${s.total} VERIFIED${s.cancelled ? ` · ${s.cancelled} cancelled` : ''}`, ''];
  let attestedOnly = 0;
  for (const t of s.tasks) {
    const run = latestRun(app.rt.db, ex.id, t.id);
    const attested = run?.results.some((r) => r.status === 'ATTESTED') ?? false;
    if (t.status === 'VERIFIED' && attested && run!.results.every((r) => r.status === 'ATTESTED')) attestedOnly++;
    lines.push(`${t.id.padEnd(12)} ${t.status.padEnd(9)}${attested ? ' (includes ATTESTED criteria)' : ''} ${oneLine(t.title, 100)}`);
    for (const r of run?.results ?? []) lines.push(`    ${r.criterionId.padEnd(16)} ${r.status.padEnd(8)} ${r.status === 'PASS' ? '' : oneLine(r.detail, 200)}`.trimEnd());
  }
  const usage = measuredUsage(app, ex);
  const cost = costReport({ usage: app.usage, sessionId: ex.sessionId ?? app.lastSeenSessionId, executionStartedAt: ex.createdAt, verifiedTasks: s.verified, totalTasks: s.total });
  lines.push('', renderCostReport(cost));
  if (usage !== null) lines.push(`Tokens across all sessions linked to this execution: ${formatTokens(usage)} (MEASURED)`);
  if (attestedOnly) lines.push(`Note: ${attestedOnly} task(s) were VERIFIED only through attestations (human/reviewer judgement), not machine checks.`);
  const final = ex.status === 'COMPLETED' ? (s.cancelled ? `PARTIAL — ${s.verified} VERIFIED, ${s.cancelled} CANCELLED` : 'VERIFIED') : ex.status;
  lines.push('', `FINAL STATUS: ${final}`);
  return { data: { summary: s, cost, measuredTokens: usage }, text: lines.join('\n') };
}
