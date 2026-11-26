# Kilamu Code — Architecture

Kilamu Code has two layers. The model reasons and the engine keeps the books. The two talk through one narrow, auditable interface: the `kilamu` CLI, which is on the Bash tool's PATH by way of the plugin's `bin/` directory.

```
┌──────────────────────────── Claude Code session ─────────────────────────────┐
│  User: "Build JWT auth with tests"                                            │
│        │                                                                      │
│        ▼                                                                      │
│  PLUGIN SURFACE (markdown, no code)                                           │
│   skills/orchestrate · understand-codebase · investigate · review · resume    │
│   agents/architect · researcher · developer · database-engineer ·             │
│          security-reviewer · verifier                                         │
│   hooks/hooks.json → SessionStart · PreCompact · TaskCompleted · PostToolUse  │
│        │  Bash: kilamu …                    ▲ additionalContext / exit 2      │
└────────┼────────────────────────────────────┼─────────────────────────────────┘
         ▼                                    │
┌──────────────────────── KILAMU ENGINE (Node ≥22.18, zero deps) ──────────────┐
│ cli.ts ─► app.ts (composition root, lazy services)                           │
│                                                                              │
│  orchestrator/   graph (validate, DAG, conflicts) · mode (SINGLE/SUBAGENT/   │
│                  TEAM) · planner (intake) · brief (agent context)            │
│  execution/      store (state machine, checkpoints) · recovery · git         │
│  verification/   detect checks · engine (allowlisted, no shell, evidence)    │
│  knowledge/      walker · extractors · indexer (incremental) · query/impact  │
│  context/        artifacts (content-addressed) · compress · pack · dedup     │
│  memory/         store (validation, staleness, promotion, export)            │
│  cost/           usage (statusline, MEASURED) · policy (ESTIMATED) · report  │
│  tools/          MCP discovery · tool selection · result cache               │
│  observability/  events · statusline HUD · doctor                            │
│  core/           types (contracts) · config · paths · redact · exec · log    │
│  persistence/    node:sqlite · versioned migrations · tx · backup            │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                ▼
            <project>/.kilamu/  state/execution.db (WAL) · artifacts/ · memory/
                                index/ · cache/ · logs/   (.gitignore = *)
```

## Module map

| Module (directive §7.1) | Path | Responsibility | Owns tables |
|---|---|---|---|
| A. Plugin interface | `.claude-plugin/`, `skills/`, `agents/`, `hooks/`, `bin/` | Natural-language entry points, specialist definitions, lifecycle hooks | — |
| B. Orchestration engine | `src/orchestrator/` | Plan normalisation and validation, DAG analysis, conflict serialisation, mode selection, dispatch briefs | — (pure) |
| C. Agent management | `src/agents/roles.ts`, `agents/*.md` | Role → agent type, write permission, model default | — |
| D. Context intelligence | `src/context/` | Artifacts, output compression, budgeted context packs, read dedup | `artifacts`, `file_reads` |
| E. Knowledge graph | `src/knowledge/` | File walk, per-language extraction, incremental index, FTS, impact | `files`, `symbols`, `edges`, `chunks_fts` |
| F. Persistent memory | `src/memory/` | Validated knowledge, invalidation, promotion | `memory_items` |
| G. Cost intelligence | `src/cost/` | Usage samples, budgets, model policy, reports | `usage_samples` |
| H. Execution persistence | `src/execution/`, `src/persistence/` | Executions, tasks, state machine, checkpoints, recovery | `executions`, `tasks`, `task_events`, `checkpoints` |
| I. Verification engine | `src/verification/` | Check detection, criterion evaluation, evidence | `verification_runs` |
| J. Tool intelligence | `src/tools/` | MCP discovery (names only), recommendations, cache | `tool_cache` |
| K. Observability | `src/observability/`, `src/core/log.ts` | Events, HUD rendering, doctor, JSONL logs | `events` |

**Dependency rule.** Modules depend on `core/`, `persistence/`, and the narrow interfaces in `core/types.ts` (`KnowledgeQuery`, `ArtifactSink`, `HudState`). They do not import each other's internals. The exceptions are composition points:
- `app.ts`;
- `cli/*`;
- `orchestrator/planner.ts` → `cost/policy.ts` (budget estimate);
- `orchestrator/brief.ts` → `agents/roles.ts`.

Each table has exactly one owning module (see `src/persistence/migrations.ts`). Every other module reads a table only through its owner's API. For example, the execution store validates verification runs through an injected `RunLookup`, and it emits events through an injected sink. A review found direct cross-table SQL in the CLI and the store, and both were removed. The remaining shared read is `meta`, through `persistence/db.ts` helpers.

## Primary data flow: one objective

1. **Orient.** The `orchestrate` skill runs:
   - `kilamu status`, which detects an existing execution and routes to resume;
   - `kilamu index`, which is incremental;
   - `kilamu context "<objective>"`, which returns a ranked pack within its token budget.
2. **Plan.** Claude writes a JSON plan. `kilamu plan create` then runs this pipeline: `normalizePlan` → `validatePlan` (duplicates, unknown deps, cycles, missing criteria, read-only roles owning files) → `serializeConflicts` (adds dependency edges between concurrent tasks that own the same file) → `selectMode` → `estimateBudget`. The result is persisted as an execution and its task rows.
3. **Dispatch.** `kilamu next` refreshes readiness from dependency state. It returns READY tasks that hold no files claimed by an active task, up to the parallel limit, each with a brief: role, owned files, inputs, acceptance criteria, protocol, model.
4. **Execute.** The steps depend on the selected mode:
   - SINGLE: the main session does the work.
   - SUBAGENT: Agent-tool calls run in parallel.
   - TEAM: native teammates do the work, with shared-task subjects tagged `[kilamu:<id>]`.

   Every task follows the same sequence: `task start` writes a checkpoint (git HEAD plus owned-file hashes), and `task submit` moves the task RUNNING → VERIFYING.
5. **Verify.** `kilamu verify` runs the criteria:
   - commands: allowlisted, no shell, output stored as an artifact;
   - file checks;
   - artifact presence;
   - attestations.

   It persists a run. `applyVerification` cross-checks that run before it sets VERIFIED. On failure the task goes back to READY while retries remain, otherwise to BLOCKED, and dependents become BLOCKED.
6. **Close.** `kilamu report` produces the per-criterion table, then cost and token labels (MEASURED / ESTIMATED / UNAVAILABLE), then the final status. Validated findings go to memory, with evidence.

## Task lifecycle

```
CREATED ─► WAITING ─► READY ─► RUNNING ─► VERIFYING ─► VERIFIED (engine only)
              ▲          ▲  ▲      │            │
              │          │  └──────┘ release    ├─► FAILED ─► READY (retry left)
              │          └── reconcile ◄────────┘        └─► BLOCKED (exhausted)
              └────────── unblock ◄── BLOCKED ◄── dependency blocked/cancelled
any non-terminal ─► CANCELLED
```

## Lifecycle hooks

| Hook | Behaviour | Cost when unused |
|---|---|---|
| SessionStart | On startup or resume, reconciles RUNNING/VERIFYING tasks that are orphaned: owned by this restarting session, by an ended session, or silent for 2 h. They are released to READY, and flagged *verify first* when their owned files changed or changes cannot be ruled out. Tasks of other live sessions are left alone. Then injects orientation text of about 1.5 K characters or less | Node start; no output when there is no active execution or no trusted `.kilamu/` |
| PreCompact | Writes a checkpoint and prints compaction instructions that preserve execution state | Same |
| TaskCompleted | Exit 2 keeps a `[kilamu:<id>]` team task open until it is VERIFIED (searched across all ACTIVE executions) | Same |
| SessionEnd | Records that the session ended, so its orphaned tasks can be reconciled next time | Same |
| PostToolUse (Bash) | Opt-in: replaces Bash output over the threshold with a compressed summary plus an artifact ref | A shell `grep` gate; Node never starts unless enabled |

## Storage

All data lives in `<project>/.kilamu/`, or `$KILAMU_DATA_DIR` when set. It is used only after `kilamu init` registers it in the user-scope trust file (ADR-013). Directories are created with mode 0700 and files with 0600.

SQLite runs in WAL mode with `foreign_keys=ON` and `busy_timeout=5000`. Migrations are versioned and append-only, recorded in `meta.schema_version`. On open the engine runs `quick_check`; a corrupt file is quarantined as `execution.db.corrupt-<ts>`, never deleted, and a fresh database is created. `kilamu export` makes a consistent `VACUUM INTO` snapshot along with memory JSON. Details are in `docs/PERSISTENCE.md`.

## Security boundaries

See `SECURITY.md`.
- Indexed and retrieved content is fenced as untrusted, and injection-like lines are flagged.
- Secrets are redacted before anything is persisted.
- Sensitive paths are never indexed.
- Verification commands run without a shell and only from an allowlist.
- Plugin agents cannot carry `permissionMode`, `hooks` or `mcpServers` (the platform ignores them).
- No network calls, no telemetry.
