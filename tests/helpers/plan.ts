import type { PlanSpec, TaskSpec } from '../../src/core/types.ts';

/** Build a TaskSpec with sane defaults for tests. */
export function task(id: string, over: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    title: id,
    description: `do ${id}`,
    role: 'developer',
    taskClass: 'implementation',
    complexity: 'medium',
    priority: 3,
    dependsOn: [],
    files: [`src/${id}.ts`],
    inputs: [],
    expectedOutput: '',
    acceptance: [{ id: `${id}.c1`, kind: 'file_exists', path: `src/${id}.ts` }],
    maxRetries: 1,
    ...over,
  };
}

export function plan(tasks: TaskSpec[], objective = 'test objective'): PlanSpec {
  return { objective, tasks };
}
