import type { ExecutionMode, ModeDecision, ModeFactor, PlanSpec } from '../core/types.ts';
import { analyzeGraph, COMPLEXITY_WEIGHT, isWriting, type GraphAnalysis } from './graph.ts';

/**
 * Adaptive execution-mode selection (directive §3.3, §8.1).
 *
 * Deterministic and explainable: every decision lists the factors used.
 *   SINGLE   – sequential, small, or tightly coupled work. Zero coordination cost.
 *   SUBAGENT – parallelizable read-only work (research/review/analysis), or
 *              parallel writing work where a team is not justified/available.
 *   TEAM     – ≥2 independent, substantial WRITING workstreams with no file
 *              conflicts, enough parallel speedup to pay the per-teammate
 *              context cost, and Agent Teams available.
 */

export interface ModeInputs {
  plan: PlanSpec;
  /** File conflicts the planner serialized before selection (reported, and they reduce width). */
  serializedConflicts?: number;
  teamsAvailable: boolean;
  maxParallelAgents: number;
  forced?: 'auto' | ExecutionMode;
}

/** Below this total weight, coordination overhead dominates (≈ two medium tasks). */
const MIN_WEIGHT_FOR_DELEGATION = 6;
/** Minimum speedup bound (total/critical path) before parallelism is worth paying for. */
const MIN_PARALLELISM_SUBAGENT = 1.3;
const MIN_PARALLELISM_TEAM = 1.6;
/**
 * Each teammate stream must carry at least this much weight (≈ one large or two
 * medium tasks): a teammate is a full Claude instance (~20K tokens of context
 * initialization, ESTIMATED), so small streams are cheaper as subagents.
 */
const MIN_WEIGHT_PER_TEAMMATE = 10;

export function selectMode(input: ModeInputs, analysis: GraphAnalysis = analyzeGraph(input.plan)): ModeDecision {
  const { plan, teamsAvailable, maxParallelAgents } = input;
  const tasks = plan.tasks;
  const writing = tasks.filter((t) => isWriting(t));
  const readOnly = tasks.filter((t) => !isWriting(t));
  // Width of concurrent writing work: per level, count writing tasks.
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const writingWidth = Math.max(0, ...analysis.levels.map((l) => l.filter((id) => isWriting(byId.get(id)!)).length));
  const readOnlyWidth = Math.max(0, ...analysis.levels.map((l) => l.filter((id) => !isWriting(byId.get(id)!)).length));
  const writingWeight = writing.reduce((s, t) => s + COMPLEXITY_WEIGHT[t.complexity], 0);

  const factors: ModeFactor[] = [
    { name: 'tasks', value: tasks.length, effect: 'more tasks → more potential parallelism' },
    { name: 'totalWeight', value: analysis.totalWeight, effect: `delegation considered only when ≥ ${MIN_WEIGHT_FOR_DELEGATION}` },
    { name: 'criticalPathWeight', value: analysis.criticalPathWeight, effect: 'lower → more parallel' },
    { name: 'parallelism', value: Number(analysis.parallelism.toFixed(2)), effect: `team needs ≥ ${MIN_PARALLELISM_TEAM}, subagents ≥ ${MIN_PARALLELISM_SUBAGENT}` },
    { name: 'maxWidth', value: analysis.maxWidth, effect: 'peak concurrent tasks' },
    { name: 'writingWidth', value: writingWidth, effect: 'peak concurrent writing tasks' },
    { name: 'readOnlyWidth', value: readOnlyWidth, effect: 'peak concurrent read-only tasks' },
    { name: 'fileConflicts', value: analysis.conflicts.length, effect: 'conflicts serialize work and block TEAM' },
    { name: 'serializedConflicts', value: input.serializedConflicts ?? 0, effect: 'conflicting tasks were ordered by the planner' },
    { name: 'teamsAvailable', value: teamsAvailable, effect: 'TEAM requires Agent Teams' },
  ];
  const reasons: string[] = [];
  const constraints: string[] = [];
  const decide = (mode: ExecutionMode, teamSize: number): ModeDecision => ({ mode, teamSize, reasons, factors, constraints });

  if (input.forced && input.forced !== 'auto') {
    if (input.forced === 'TEAM' && !teamsAvailable) {
      constraints.push('TEAM forced by config but Agent Teams unavailable → falling back to SUBAGENT');
      reasons.push('Forced mode not available in this session');
      return decide('SUBAGENT', Math.min(maxParallelAgents, Math.max(1, analysis.maxWidth)));
    }
    reasons.push(`Mode forced by configuration (execution.mode=${input.forced})`);
    const size = input.forced === 'SINGLE' ? 1 : Math.min(maxParallelAgents, Math.max(1, analysis.maxWidth));
    return decide(input.forced, size);
  }

  if (tasks.length <= 1 || analysis.totalWeight < MIN_WEIGHT_FOR_DELEGATION) {
    reasons.push('Work is small: delegation overhead (agent context initialization) would exceed the benefit');
    return decide('SINGLE', 1);
  }
  if (analysis.maxWidth <= 1) {
    reasons.push('Every task depends on the previous one: no parallel progress is possible');
    return decide('SINGLE', 1);
  }

  const teamCandidate =
    writingWidth >= 2 &&
    analysis.conflicts.length === 0 &&
    analysis.parallelism >= MIN_PARALLELISM_TEAM &&
    writingWeight / Math.min(writingWidth, maxParallelAgents) >= MIN_WEIGHT_PER_TEAMMATE;

  if (teamCandidate) {
    const size = Math.max(2, Math.min(maxParallelAgents, writingWidth));
    if (teamsAvailable) {
      reasons.push(`${writingWidth} independent writing workstreams with no concurrent file conflicts${input.serializedConflicts ? ` (${input.serializedConflicts} conflict(s) were serialized first)` : ''}`);
      reasons.push(`Parallel speedup bound ${analysis.parallelism.toFixed(2)} ≥ ${MIN_PARALLELISM_TEAM} justifies ${size} teammates`);
      return decide('TEAM', size);
    }
    constraints.push('A team would be justified, but Agent Teams are unavailable (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS not enabled)');
    reasons.push('Falling back to parallel subagents for independent workstreams');
    return decide('SUBAGENT', size);
  }

  if (analysis.conflicts.length > 0 && writingWidth >= 2) {
    constraints.push(`${analysis.conflicts.length} file-ownership conflict(s) between concurrent writing tasks`);
  }

  if (analysis.parallelism >= MIN_PARALLELISM_SUBAGENT && (readOnlyWidth >= 2 || writingWidth >= 2)) {
    const size = Math.max(1, Math.min(maxParallelAgents, Math.max(readOnlyWidth, analysis.conflicts.length ? 1 : writingWidth)));
    if (readOnly.length > 0) reasons.push(`${readOnly.length} read-only task(s) can run as isolated subagents (research/review/analysis)`);
    if (analysis.conflicts.length) reasons.push('Writing tasks share files: they run sequentially in the main session');
    reasons.push('Subagents give isolation and parallelism without team coordination overhead');
    return decide('SUBAGENT', size);
  }

  reasons.push('Limited parallelism: main session is the cheapest correct option');
  return decide('SINGLE', 1);
}
