# Orchestration

## Responsibilities
Claude, guided by `skills/orchestrate`, decomposes an objective into a JSON plan. The engine (`src/orchestrator`, `src/execution`) then validates the plan, schedules it, and enforces verification. This split is ADR-001: no model call is spent on bookkeeping.

## Plan format
`kilamu plan create --file plan.json` accepts the following fields. `kilamu plan check` validates a plan without saving it.

| Field | Required | Default | Notes |
|---|---|---|---|
| `objective` | yes | — | One-sentence outcome |
| `tasks[].id` | yes | — | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`, unique |
| `title`, `description` | no | id | |
| `role` | no | developer | architect, researcher, developer, database-engineer, security-reviewer, verifier, lead |
| `taskClass` | no | implementation | Drives model policy and the read/write split |
| `complexity` | no | medium | trivial=1, small=2, medium=5, large=10 (weights) |
| `priority` | no | 3 | 1 (first) … 5 |
| `dependsOn` | no | [] | Real ordering only |
| `files` | no | [] | Owned paths. A trailing `/` owns a directory. Must be project-relative |
| `inputs` | no | [] | Paths, `artifact:<id>`, `task:<id>` |
| `acceptance` | yes (≥ 1) | — | command / file_exists / file_contains / artifact / attestation. A bare string means an attestation |
| `maxRetries` | no | config (2) | 0..5 |
| `budgetTokens` | no | — | Per-task estimate |

### Rejected plans
The engine rejects a plan that has any of these problems:
- duplicate ids;
- unknown or self dependencies;
- cycles (the cycle path is reported);
- a task with no criteria;
- a read-only role that owns files;
- absolute or `..` paths.

### Warnings
The engine warns, but still accepts the plan, in these cases:
- a task has only attestation criteria;
- a writing task declares no owned files;
- the plan's budget is below the estimate.

## Conflict control (directive §8.3)
Two tasks conflict when neither is an ancestor of the other and their owned files overlap (equal paths, or a directory prefix). `serializeConflicts` adds a dependency edge from the task that comes later in topological order to the earlier one. This keeps the graph acyclic and turns a would-be concurrent edit into an ordered one. At runtime, `startTask` refuses to start a task whose files are held by a RUNNING or VERIFYING task, and `nextTasks` defers such tasks with the reason.

## Mode selection (`src/orchestrator/mode.ts`)
The inputs are graph metrics: total weight W, critical-path weight C, parallelism bound W/C, peak concurrent writing width, peak read-only width, conflicts, and team availability.

| Rule (evaluated in order) | Mode |
|---|---|
| `execution.mode` is forced in config (TEAM falls back to SUBAGENT if teams are unavailable) | forced |
| ≤ 1 task, or W < 6 (coordination would exceed the benefit) | SINGLE |
| Max width ≤ 1 (pure chain) | SINGLE |
| Writing width ≥ 2, no concurrent conflicts, W/C ≥ 1.6, writing weight per teammate ≥ 10, teams available | TEAM (size = min(maxParallelAgents, writing width)) |
| Same as above but teams unavailable | SUBAGENT, with the constraint recorded |
| W/C ≥ 1.3 and (read-only width ≥ 2 or writing width ≥ 2) | SUBAGENT |
| Otherwise | SINGLE |

Every decision returns `reasons`, `constraints` and the raw `factors`, so the user can see why a team was or was not formed. The thresholds are ESTIMATES (ADR-007) and will be tuned with benchmark data.

## Dispatch
`kilamu next` refreshes readiness, applies the budget stop (when MEASURED usage exists), and returns READY tasks up to the parallel limit. The limit is 1 for SINGLE; otherwise it is the smaller of `maxParallelAgents` and the team size. Each ready task gets a brief (`src/orchestrator/brief.ts`). The brief contains:
- role, objective and task;
- the files the task owns;
- inputs;
- expected output;
- acceptance criteria;
- the protocol: context → work → submit → verify;
- the routed `model` and `agentType`.

The brief points to `kilamu context` rather than inlining files, which keeps the agent's context lean (§9.1, agent context).

| Mode | How Claude executes |
|---|---|
| SINGLE | The main session runs start → implement → submit → verify. |
| SUBAGENT | Parallel Agent-tool calls in one message, with `subagent_type` and `model` taken from the brief. |
| TEAM | Native teammates (`name` = `teammateName`). Shared-task subjects carry `[kilamu:<id>]`, so the TaskCompleted hook blocks completion until the task is VERIFIED. |

## Model policy
`models.<taskClass>` in `.kilamu/config.json` maps each task class to a model alias. The defaults are:

| Task classes | Model |
|---|---|
| classification, discovery, summarization | haiku |
| research, implementation, debugging, verification | sonnet |
| architecture, security | opus |

The alias is passed as the Agent tool's per-invocation `model` parameter, which is the documented highest-priority override (ADR-008). The main-session model is never changed.

## Retries and loops
Each task allows `maxRetries + 1` attempts. Every verification needs a started attempt, and each run is bound to its attempt's checkpoint, so a verify loop cannot bypass the bound. A failed verification sends the task back to READY while attempts remain. After that it goes to BLOCKED, and its dependents are blocked transitively in a single refresh. `kilamu task unblock` grants one more attempt after a human intervenes, at most twice per task. RUNNING tasks with no update for 30 minutes are flagged as possibly stale in `kilamu status`. A writing task is one that owns files or has a writing class.
