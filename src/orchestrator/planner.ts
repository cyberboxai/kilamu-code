import { KilamuError } from '../core/errors.ts';
import type { KilamuConfig } from '../core/config.ts';
import type { ModeDecision, PlanSpec } from '../core/types.ts';
import { roleOwnershipIssues } from '../agents/roles.ts';
import { estimateBudget } from '../cost/policy.ts';
import { analyzeGraph, normalizePlan, serializeConflicts, validatePlan, type GraphAnalysis, type PlanIssue } from './graph.ts';
import { selectMode } from './mode.ts';

/**
 * Plan intake: the model drafts a plan (it is good at decomposition); the
 * engine normalizes, validates, de-conflicts, chooses the execution mode and
 * budgets it deterministically (it is good at bookkeeping). See ADR-001.
 */
export interface PreparedPlan {
  plan: PlanSpec;
  issues: PlanIssue[];
  analysis: GraphAnalysis;
  decision: ModeDecision;
  /** Dependency edges added to serialize file-ownership conflicts. */
  serialized: Array<{ from: string; to: string; files: string[] }>;
  budget: ReturnType<typeof estimateBudget>;
  budgetTokens: number;
}

export function preparePlan(raw: unknown, config: KilamuConfig, caps: { teamsAvailable: boolean }): PreparedPlan {
  const plan = normalizePlan(raw, { maxRetries: config.execution.maxRetries });
  const issues = validatePlan(plan);
  for (const t of plan.tasks) {
    const own = roleOwnershipIssues(t);
    if (own) issues.push({ severity: 'error', taskId: t.id, message: own });
  }
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    throw new KilamuError('PLAN_INVALID', `Plan rejected:\n${errors.map((e) => `  - ${e.taskId ? `[${e.taskId}] ` : ''}${e.message}`).join('\n')}`, { issues });
  }
  const first = analyzeGraph(plan);
  const serialized = serializeConflicts(plan, first);
  for (const s of serialized) {
    issues.push({ severity: 'warning', taskId: s.from, message: `Serialized after ${s.to}: both own ${s.files.join(', ')}` });
  }
  const analysis = serialized.length ? analyzeGraph(plan) : first;
  const decision = selectMode({
    plan,
    serializedConflicts: serialized.length,
    teamsAvailable: caps.teamsAvailable,
    maxParallelAgents: config.execution.maxParallelAgents,
    forced: config.execution.mode,
  }, analysis);
  if (serialized.length) decision.constraints.push(`${serialized.length} file-ownership conflict(s) serialized into dependencies`);
  const budget = estimateBudget(plan, decision.mode, decision.teamSize);
  const budgetTokens = plan.budgetTokens ?? Math.max(config.execution.defaultBudgetTokens, budget.total);
  if (plan.budgetTokens !== undefined && plan.budgetTokens < budget.total) {
    issues.push({ severity: 'warning', message: `Plan budget ${plan.budgetTokens} is below the estimate ${budget.total} (ESTIMATED); expect a budget stop` });
  }
  return { plan, issues, analysis, decision, serialized, budget, budgetTokens };
}
