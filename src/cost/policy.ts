import type { KilamuConfig } from '../core/config.ts';
import type { Complexity, ExecutionMode, ModelAlias, PlanSpec, TaskClass } from '../core/types.ts';

/** Planning constants for ESTIMATED budgets. These are heuristics, not measurements. */
export const WORK_TOKENS: Record<Complexity, number> = { trivial: 8_000, small: 20_000, medium: 50_000, large: 120_000 };
/** Context initialisation per agent (system prompt, tool schemas, project instructions). */
export const AGENT_INIT_TOKENS = 20_000;
/** Coordination overhead: 10% of work tokens per extra teammate, capped at 40%. */
export const TEAM_OVERHEAD_PER_EXTRA = 0.1;
export const TEAM_OVERHEAD_CAP = 0.4;
/** Share of the total reserved for verification. */
export const VERIFICATION_RESERVE = 0.15;
const WARN_AT = 0.8;

export function modelFor(taskClass: TaskClass, config: KilamuConfig): ModelAlias {
  return config.models[taskClass];
}

export interface BudgetComponent {
  name: string;
  tokens: number;
  note: string;
}

export interface BudgetEstimate {
  total: number;
  components: BudgetComponent[];
  label: 'ESTIMATED';
}

export function estimateBudget(plan: PlanSpec, mode: ExecutionMode, teamSize: number): BudgetEstimate {
  const work = plan.tasks.reduce((sum, t) => sum + WORK_TOKENS[t.complexity], 0);
  const agents = mode === 'SINGLE' ? 0 : Math.max(1, Math.floor(teamSize));
  const init = agents * AGENT_INIT_TOKENS;
  const overheadRate = mode === 'TEAM' ? Math.min(TEAM_OVERHEAD_CAP, TEAM_OVERHEAD_PER_EXTRA * Math.max(0, agents - 1)) : 0;
  const coordination = Math.round(work * overheadRate);
  const subtotal = work + init + coordination;
  const reserve = Math.round(subtotal * VERIFICATION_RESERVE);
  return {
    total: subtotal + reserve,
    label: 'ESTIMATED',
    components: [
      { name: 'work', tokens: work, note: `${plan.tasks.length} task(s) by complexity (trivial 8k, small 20k, medium 50k, large 120k)` },
      { name: 'agent-init', tokens: init, note: `${agents} agent(s) x ${AGENT_INIT_TOKENS} tokens context initialisation` },
      { name: 'coordination', tokens: coordination, note: `${Math.round(overheadRate * 100)}% of work (10% per extra teammate, cap 40%)` },
      { name: 'verification-reserve', tokens: reserve, note: `${VERIFICATION_RESERVE * 100}% of subtotal` },
    ],
  };
}

export interface StopDecision {
  stop: boolean;
  warn: boolean;
  reason: string;
}

/** `verificationReserve` is a fraction (0..1) of the budget held back for verification. */
export function shouldStop(input: { usedTokens: number; budgetTokens: number; verificationReserve: number }): StopDecision {
  const usable = input.budgetTokens * (1 - input.verificationReserve);
  if (usable <= 0) return { stop: true, warn: true, reason: 'no non-reserve budget available' };
  const ratio = input.usedTokens / usable;
  const pct = Math.round(ratio * 100);
  if (ratio >= 1) return { stop: true, warn: true, reason: `used ${pct}% of the non-reserve budget; stop and verify` };
  if (ratio >= WARN_AT) return { stop: false, warn: true, reason: `used ${pct}% of the non-reserve budget` };
  return { stop: false, warn: false, reason: `used ${pct}% of the non-reserve budget` };
}
