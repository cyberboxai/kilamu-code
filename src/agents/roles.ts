import type { KilamuConfig } from '../core/config.ts';
import type { AgentRole, ModelAlias, TaskClass, TaskSpec } from '../core/types.ts';

/**
 * Specialist role registry (directive §7.1-C). Each role maps to a plugin
 * agent definition in agents/<file>.md, referenced as `kilamu-code:<name>`.
 */
export interface RoleDefinition {
  role: AgentRole;
  /** Subagent type to pass to the Agent tool (plugin-namespaced). */
  agentType: string | null;
  summary: string;
  /** Whether the role is allowed to modify files. */
  writes: boolean;
  defaultModel: ModelAlias;
}

export const ROLE_DEFINITIONS: Record<AgentRole, RoleDefinition> = {
  lead: { role: 'lead', agentType: null, summary: 'Main session: plans, integrates, owns shared contracts', writes: true, defaultModel: 'inherit' },
  architect: { role: 'architect', agentType: 'kilamu-code:architect', summary: 'Designs module boundaries and interfaces; read-only', writes: false, defaultModel: 'opus' },
  researcher: { role: 'researcher', agentType: 'kilamu-code:researcher', summary: 'Finds facts in code/docs; returns cited summaries; read-only', writes: false, defaultModel: 'haiku' },
  developer: { role: 'developer', agentType: 'kilamu-code:developer', summary: 'Implements a scoped task inside its owned files', writes: true, defaultModel: 'sonnet' },
  'database-engineer': { role: 'database-engineer', agentType: 'kilamu-code:database-engineer', summary: 'Schemas, migrations, queries; owns DB files', writes: true, defaultModel: 'sonnet' },
  'security-reviewer': { role: 'security-reviewer', agentType: 'kilamu-code:security-reviewer', summary: 'Threat-focused review; read-only', writes: false, defaultModel: 'opus' },
  verifier: { role: 'verifier', agentType: 'kilamu-code:verifier', summary: 'Runs and interprets verification; read-only', writes: false, defaultModel: 'sonnet' },
};

/**
 * Model for a task: explicit task-class policy from config wins (that is the
 * user-tunable knob); role default is the fallback. The returned alias is
 * passed as the Agent tool `model` parameter — the documented per-invocation
 * override — so routing works without touching user settings.
 */
export function modelForTask(task: Pick<TaskSpec, 'role' | 'taskClass'>, config: KilamuConfig): ModelAlias {
  const byClass = config.models[task.taskClass as TaskClass];
  return byClass ?? ROLE_DEFINITIONS[task.role].defaultModel;
}

/** Sanity check: read-only roles must not own files. */
export function roleOwnershipIssues(task: TaskSpec): string | null {
  const def = ROLE_DEFINITIONS[task.role];
  if (!def.writes && task.files.length > 0) {
    return `Role "${task.role}" is read-only but task ${task.id} declares owned files`;
  }
  return null;
}
