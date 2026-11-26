# Persistence

## Engine
Kilamu uses the built-in `node:sqlite` (`DatabaseSync`), so there are no native dependencies (ADR-002). The database lives at `.kilamu/state/execution.db`.

Every connection runs these pragmas:
- `journal_mode=WAL`
- `synchronous=NORMAL`
- `foreign_keys=ON`
- `busy_timeout=5000`

State transitions run in `BEGIN IMMEDIATE` transactions, so parallel CLI processes started by concurrent subagents serialise their writes safely.

## Schema (v2)
`src/persistence/migrations.ts` is the source of truth. Each table has exactly one owner.

| Table | Owner | Purpose |
|---|---|---|
| meta | persistence | `schema_version`, `last_session_id` |
| events | observability | Structured event log (redacted) |
| executions | execution | Objective, mode plus rationale JSON, budget, plan JSON, session, base commit |
| tasks | execution | Every task field from the directive §8.2, plus attempts, owner, checkpoint, result summary and output artifacts |
| task_events | execution | Append-only transition log: from, to, actor, reason |
| checkpoints | execution | `task-start` (git HEAD and owned-file hashes) and `pre-compact` snapshots |
| verification_runs | verification | Verdict and per-criterion results with evidence artifact ids |
| artifacts | context | Content-addressed index of the files under `.kilamu/artifacts/` |
| files, symbols, edges, chunks_fts | knowledge | Index, graph and FTS5 |
| memory_items | memory | Validated knowledge |
| usage_samples | cost | Statusline measurements |
| file_reads, tool_cache | context, tools | Duplicate-read tracking and deterministic result cache |
| execution_sessions, session_ends (v2) | execution | Sessions linked to an execution (budget summed across them); ended sessions (recovery scoping) |

v2 also adds these columns:
- `tasks.session_id`: the session that started the current attempt.
- `tasks.verify_first`: set when reconciliation finds work that may already be on disk.
- `tasks.unblocks`: human unblocks, capped at 2.
- `verification_runs.checkpoint_id`: binds a run to the attempt it verified.

## Migrations
Migrations are append-only and versioned. Each one runs in a transaction and records `meta.schema_version`. If the database is newer than the build, Kilamu refuses to touch it (`SCHEMA_TOO_NEW`) rather than risk a downgrade.

## Recovery
1. **Corruption.** Every open runs a cheap probe; `kilamu doctor` runs the full `PRAGMA quick_check`. A file that fails to open as a database is renamed to `execution.db.corrupt-<ts>`, together with its WAL and SHM files, and a fresh database is created. `kilamu doctor` reports the quarantine. Nothing is ever deleted.
2. **Interrupted sessions.** On SessionStart with source `startup` or `resume`, `reconcileExecution` does three things for each ACTIVE execution:
   - releases **orphaned** RUNNING or VERIFYING tasks to READY, keeping their attempt count. A task is orphaned if any of these holds:
     - it belongs to the restarting session;
     - its session ended (SessionEnd hook);
     - it has been silent for 2 h.

     Tasks of another, possibly live, session are left alone and reported; `kilamu recover --force` releases everything.
   - compares the task's owned-file hashes with its start checkpoint;
   - flags tasks *verify first* when files changed, when no snapshot exists, or when the task owns a directory. `kilamu next` does not dispatch verify-first tasks. They go straight to `task submit` + `verify`, which is the only READY → VERIFYING path, so there is no blind replay.

   It also notes when git HEAD has moved since planning, then injects a short orientation. Native teammates and subagents are assumed gone, because the platform does not resume in-process teammates.
3. **Compaction.** PreCompact writes a `pre-compact` checkpoint and prints instructions that tell the summariser to keep the execution id, task states and blockers. SessionStart with source `compact` re-orients from durable state. Kilamu never edits transcripts.

## Export, import and cleanup
- `kilamu export <new-dir>` writes a consistent `VACUUM INTO` snapshot of the database, plus `memory.json` and the config.
- `kilamu import <memory.json>` re-imports memory. Every item is re-validated, and secrets and sensitive sources are rejected.
- `kilamu cleanup [--artifacts-older-than 30] [--usage-rows 2000] [--dry-run]` prunes artifacts and usage samples.
