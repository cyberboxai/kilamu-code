import { KilamuError } from '../core/errors.ts';
import { TASK_ID_PATTERN } from '../core/ids.ts';
import type { AcceptanceCriterion, AgentRole, Complexity, PlanSpec, TaskClass, TaskSpec } from '../core/types.ts';

/**
 * Plan validation and DAG analysis (directive §8.2, §8.3).
 * Pure functions: no I/O, fully unit-testable.
 */

export const ROLES: readonly AgentRole[] = ['lead', 'architect', 'researcher', 'developer', 'database-engineer', 'security-reviewer', 'verifier'];
export const TASK_CLASSES: readonly TaskClass[] = ['classification', 'discovery', 'summarization', 'research', 'implementation', 'debugging', 'architecture', 'security', 'verification'];
export const COMPLEXITIES: readonly Complexity[] = ['trivial', 'small', 'medium', 'large'];

/** Relative effort weights used for critical-path and speedup estimates. */
export const COMPLEXITY_WEIGHT: Record<Complexity, number> = { trivial: 1, small: 2, medium: 5, large: 10 };

/** Classes that change files. Read-only classes can always run in parallel. */
export const WRITING_CLASSES = new Set<TaskClass>(['implementation', 'debugging']);

/** A task writes if it owns files or its class is a writing class. */
export function isWriting(t: Pick<TaskSpec, 'files' | 'taskClass'>): boolean {
  return t.files.length > 0 || WRITING_CLASSES.has(t.taskClass);
}

export interface PlanIssue {
  severity: 'error' | 'warning';
  taskId?: string;
  message: string;
}

export interface FileConflict {
  a: string;
  b: string;
  files: string[];
}

export interface GraphAnalysis {
  order: string[];
  levels: string[][];
  maxWidth: number;
  criticalPathWeight: number;
  totalWeight: number;
  /** totalWeight / criticalPathWeight — upper bound on parallel speedup. */
  parallelism: number;
  /** Pairs of tasks that may run concurrently AND share owned files. */
  conflicts: FileConflict[];
}

function str(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Normalize a raw (model-authored) plan object, applying safe defaults. */
export function normalizePlan(raw: unknown, defaults: { maxRetries: number }): PlanSpec {
  if (typeof raw !== 'object' || raw === null) throw new KilamuError('PLAN_INVALID', 'Plan must be a JSON object');
  const r = raw as Record<string, unknown>;
  if (!str(r.objective)) throw new KilamuError('PLAN_INVALID', 'Plan.objective is required');
  if (!Array.isArray(r.tasks) || r.tasks.length === 0) throw new KilamuError('PLAN_INVALID', 'Plan.tasks must be a non-empty array');
  if (r.tasks.length > 200) throw new KilamuError('PLAN_INVALID', 'Plan has more than 200 tasks; split the objective');
  const tasks: TaskSpec[] = r.tasks.map((t, i) => {
    if (typeof t !== 'object' || t === null) throw new KilamuError('PLAN_INVALID', `tasks[${i}] must be an object`);
    const o = t as Record<string, unknown>;
    const id = o.id;
    if (!str(id) || !TASK_ID_PATTERN.test(id)) throw new KilamuError('PLAN_INVALID', `tasks[${i}].id must match ${TASK_ID_PATTERN}`);
    const role = (o.role ?? 'developer') as AgentRole;
    if (!ROLES.includes(role)) throw new KilamuError('PLAN_INVALID', `Task ${id}: unknown role "${String(role)}"`);
    const taskClass = (o.taskClass ?? o.class ?? 'implementation') as TaskClass;
    if (!TASK_CLASSES.includes(taskClass)) throw new KilamuError('PLAN_INVALID', `Task ${id}: unknown taskClass "${String(taskClass)}"`);
    const complexity = (o.complexity ?? 'medium') as Complexity;
    if (!COMPLEXITIES.includes(complexity)) throw new KilamuError('PLAN_INVALID', `Task ${id}: unknown complexity "${String(complexity)}"`);
    const arr = (v: unknown, name: string): string[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new KilamuError('PLAN_INVALID', `Task ${id}: ${name} must be a string array`);
      return v as string[];
    };
    const acceptanceRaw = o.acceptance ?? [];
    if (!Array.isArray(acceptanceRaw)) throw new KilamuError('PLAN_INVALID', `Task ${id}: acceptance must be an array`);
    const acceptance = acceptanceRaw.map((c, j) => normalizeCriterion(c, id, j));
    const priority = o.priority === undefined ? 3 : Number(o.priority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 5) throw new KilamuError('PLAN_INVALID', `Task ${id}: priority must be 1..5`);
    const maxRetries = o.maxRetries === undefined ? defaults.maxRetries : Number(o.maxRetries);
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new KilamuError('PLAN_INVALID', `Task ${id}: maxRetries must be 0..5`);
    const budget = o.budgetTokens === undefined ? undefined : { maxTokens: Number(o.budgetTokens) };
    if (budget && (!Number.isInteger(budget.maxTokens) || budget.maxTokens < 1_000 || budget.maxTokens > 10_000_000)) {
      throw new KilamuError('PLAN_INVALID', `Task ${id}: budgetTokens must be an integer in 1000..10000000`);
    }
    return {
      id,
      title: str(o.title) ? o.title : id,
      description: str(o.description) ? o.description : (str(o.title) ? o.title : id),
      role,
      taskClass,
      complexity,
      priority,
      dependsOn: arr(o.dependsOn, 'dependsOn'),
      files: arr(o.files, 'files').map(normalizeFilePath),
      inputs: arr(o.inputs, 'inputs'),
      expectedOutput: str(o.expectedOutput) ? o.expectedOutput : '',
      acceptance,
      maxRetries,
      ...(budget ? { budget } : {}),
    };
  });
  const budgetTokens = r.budgetTokens === undefined ? undefined : Number(r.budgetTokens);
  if (budgetTokens !== undefined && (!Number.isInteger(budgetTokens) || budgetTokens < 1_000 || budgetTokens > 50_000_000)) {
    throw new KilamuError('PLAN_INVALID', 'Plan.budgetTokens must be an integer in 1000..50000000');
  }
  return { objective: r.objective, tasks, ...(budgetTokens !== undefined ? { budgetTokens } : {}) };
}

function normalizeFilePath(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (n.startsWith('/') || n.split('/').includes('..')) throw new KilamuError('PLAN_INVALID', `Owned file path must be project-relative: ${p}`);
  return n;
}

function intIn(v: unknown, min: number, max: number, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new KilamuError('PLAN_INVALID', `${what} must be an integer in ${min}..${max}`);
  return n;
}

function normalizeCriterion(c: unknown, taskId: string, j: number): AcceptanceCriterion {
  if (typeof c === 'string') return { id: `${taskId}.c${j + 1}`, kind: 'attestation', description: c };
  if (typeof c !== 'object' || c === null) throw new KilamuError('PLAN_INVALID', `Task ${taskId}: acceptance[${j}] invalid`);
  const o = c as Record<string, unknown>;
  const id = str(o.id) ? o.id : `${taskId}.c${j + 1}`;
  const description = str(o.description) ? o.description : undefined;
  switch (o.kind) {
    case 'command':
      if (!str(o.command)) throw new KilamuError('PLAN_INVALID', `Task ${taskId}: command criterion needs "command"`);
      return {
        id, kind: 'command', command: o.command,
        ...(str(o.cwd) ? { cwd: normalizeFilePath(o.cwd) } : {}),
        ...(o.timeoutSec !== undefined ? { timeoutSec: intIn(o.timeoutSec, 1, 7200, `Task ${taskId}: timeoutSec`) } : {}),
        ...(description ? { description } : {}),
      };
    case 'file_exists':
      if (!str(o.path)) throw new KilamuError('PLAN_INVALID', `Task ${taskId}: file_exists needs "path"`);
      return { id, kind: 'file_exists', path: normalizeFilePath(o.path), ...(description ? { description } : {}) };
    case 'file_contains':
      if (!str(o.path) || !str(o.pattern)) throw new KilamuError('PLAN_INVALID', `Task ${taskId}: file_contains needs "path" and "pattern"`);
      return { id, kind: 'file_contains', path: normalizeFilePath(o.path), pattern: o.pattern, regex: o.regex === true, ...(description ? { description } : {}) };
    case 'artifact':
      return { id, kind: 'artifact', ...(description ? { description } : {}) };
    case 'attestation':
      if (!description) throw new KilamuError('PLAN_INVALID', `Task ${taskId}: attestation needs "description"`);
      return { id, kind: 'attestation', description };
    default:
      throw new KilamuError('PLAN_INVALID', `Task ${taskId}: unknown criterion kind "${String(o.kind)}"`);
  }
}

/** Structural validation: duplicates, unknown deps, cycles, missing criteria. */
export function validatePlan(plan: PlanSpec): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (ids.has(t.id)) issues.push({ severity: 'error', taskId: t.id, message: `Duplicate task id "${t.id}"` });
    ids.add(t.id);
  }
  for (const t of plan.tasks) {
    for (const d of t.dependsOn) {
      if (d === t.id) issues.push({ severity: 'error', taskId: t.id, message: 'Task depends on itself' });
      else if (!ids.has(d)) issues.push({ severity: 'error', taskId: t.id, message: `Unknown dependency "${d}"` });
    }
    if (t.acceptance.length === 0) {
      issues.push({ severity: 'error', taskId: t.id, message: 'Task has no acceptance criteria; it could never be VERIFIED' });
    } else if (t.acceptance.every((c) => c.kind === 'attestation')) {
      issues.push({ severity: 'warning', taskId: t.id, message: 'Only attestation criteria: result will be ATTESTED, not machine-verified' });
    }
    if (WRITING_CLASSES.has(t.taskClass) && t.files.length === 0) {
      issues.push({ severity: 'warning', taskId: t.id, message: 'Writing task declares no owned files; conflict detection cannot protect it' });
    }
    const critIds = new Set<string>();
    for (const c of t.acceptance) {
      if (critIds.has(c.id)) issues.push({ severity: 'error', taskId: t.id, message: `Duplicate criterion id "${c.id}"` });
      critIds.add(c.id);
    }
  }
  if (!issues.some((i) => i.severity === 'error')) {
    const cycle = findCycle(plan.tasks);
    if (cycle) issues.push({ severity: 'error', message: `Dependency cycle: ${cycle.join(' → ')}` });
  }
  return issues;
}

/** Return one cycle as a list of ids, or null if the graph is acyclic. */
export function findCycle(tasks: TaskSpec[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      const s = state.get(d) ?? 0;
      if (s === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (s === 0 && byId.has(d)) {
        const c = visit(d);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const t of tasks) {
    if ((state.get(t.id) ?? 0) === 0) {
      const c = visit(t.id);
      if (c) return c;
    }
  }
  return null;
}

/** Transitive dependency closure per task (ancestors). */
function ancestors(tasks: TaskSpec[]): Map<string, Set<string>> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, Set<string>>();
  const get = (id: string): Set<string> => {
    const m = memo.get(id);
    if (m) return m;
    const s = new Set<string>();
    memo.set(id, s);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      s.add(d);
      for (const a of get(d)) s.add(a);
    }
    return s;
  };
  for (const t of tasks) get(t.id);
  return memo;
}

/** Two files overlap if equal, or one is a directory prefix ("src/auth/") of the other. */
export function filesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const da = a.endsWith('/') ? a : null;
  const dbp = b.endsWith('/') ? b : null;
  return (da !== null && b.startsWith(da)) || (dbp !== null && a.startsWith(dbp));
}

/** Analyze an ACYCLIC plan. Call validatePlan first. */
export function analyzeGraph(plan: PlanSpec): GraphAnalysis {
  const tasks = plan.tasks;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // Kahn levels (stable by priority then id).
  const indeg = new Map(tasks.map((t) => [t.id, t.dependsOn.length]));
  const children = new Map<string, string[]>(tasks.map((t) => [t.id, []]));
  for (const t of tasks) for (const d of t.dependsOn) children.get(d)?.push(t.id);
  const levels: string[][] = [];
  let frontier = tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.id);
  const order: string[] = [];
  const sortIds = (ids: string[]) =>
    ids.sort((x, y) => (byId.get(x)!.priority - byId.get(y)!.priority) || x.localeCompare(y));
  while (frontier.length) {
    sortIds(frontier);
    levels.push(frontier);
    order.push(...frontier);
    const next: string[] = [];
    for (const id of frontier) {
      for (const c of children.get(id) ?? []) {
        const n = (indeg.get(c) ?? 0) - 1;
        indeg.set(c, n);
        if (n === 0) next.push(c);
      }
    }
    frontier = next;
  }
  if (order.length !== tasks.length) throw new KilamuError('PLAN_INVALID', 'Plan graph is cyclic');
  // Critical path by weight.
  const finish = new Map<string, number>();
  for (const id of order) {
    const t = byId.get(id)!;
    const start = Math.max(0, ...t.dependsOn.map((d) => finish.get(d) ?? 0));
    finish.set(id, start + COMPLEXITY_WEIGHT[t.complexity]);
  }
  const criticalPathWeight = Math.max(0, ...finish.values());
  const totalWeight = tasks.reduce((s, t) => s + COMPLEXITY_WEIGHT[t.complexity], 0);
  // Conflicts: concurrent-capable pairs (neither is an ancestor of the other) sharing files.
  const anc = ancestors(tasks);
  const conflicts: FileConflict[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      if (anc.get(a.id)!.has(b.id) || anc.get(b.id)!.has(a.id)) continue;
      const shared = a.files.filter((fa) => b.files.some((fb) => filesOverlap(fa, fb)));
      if (shared.length) conflicts.push({ a: a.id, b: b.id, files: shared });
    }
  }
  return {
    order,
    levels,
    maxWidth: Math.max(0, ...levels.map((l) => l.length)),
    criticalPathWeight,
    totalWeight,
    parallelism: criticalPathWeight > 0 ? totalWeight / criticalPathWeight : 1,
    conflicts,
  };
}

/**
 * Serialize conflicting concurrent tasks by adding a dependency edge from the
 * later (lower priority / later id) task to the earlier one. Returns the edges
 * added. Keeps the plan acyclic because edges always point "backwards" in the
 * topological order.
 */
export function serializeConflicts(plan: PlanSpec, analysis: GraphAnalysis): Array<{ from: string; to: string; files: string[] }> {
  const pos = new Map(analysis.order.map((id, i) => [id, i]));
  const added: Array<{ from: string; to: string; files: string[] }> = [];
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  for (const c of analysis.conflicts) {
    const [first, second] = (pos.get(c.a)! <= pos.get(c.b)!) ? [c.a, c.b] : [c.b, c.a];
    const t = byId.get(second)!;
    if (!t.dependsOn.includes(first)) {
      t.dependsOn.push(first);
      added.push({ from: second, to: first, files: c.files });
    }
  }
  return added;
}
