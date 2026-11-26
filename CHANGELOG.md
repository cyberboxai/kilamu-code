# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/) and SemVer.

## [0.1.0] — 2026-11-25
### Fixed before release (independent architecture, security and code reviews)
- **Verification command policy.** The program allowlist became argv templates per runner. Arguments are confined to the project, plans are checked at creation, and the policy can only be widened from user scope. Timeouts kill the whole process group.
- **Trust-on-init for `.kilamu/`.** A shipped or git-tracked data dir is ignored or refused. Logs are written with O_NOFOLLOW, symlinked artifact paths are refused, and no command creates state uninvited.
- **Execution integrity.**
  - Verification runs are bound to an attempt, and every verify consumes an attempt (bounded retries).
  - The self-attestation guard now covers everyone who started an attempt.
  - Transitions are atomic and guarded on their expected status.
  - Readiness is computed to a fixpoint.
  - Executions whose tasks are all cancelled become CANCELLED; executions completed with cancellations report PARTIAL.
  - Unblocks are capped, and finished executions can no longer be cancelled.
- **Session-scoped recovery** plus a SessionEnd hook. Verify-first applies to unprovable changes and is never re-dispatched blindly.
- **Redaction and input safety.**
  - Plan, summary, reason and verification text are redacted at storage.
  - More secret formats and sensitive paths are recognised.
  - Sensitive `--file` arguments are refused, and parse errors no longer echo input.
  - Brief commands are shell-quoted, fence labels sanitised, and repo-derived CLI output stripped of control characters.
- **CLI.**
  - `--help` never executes a command.
  - `--json` and subcommands parse in any order.
  - `kilamu config` runs before the app opens; `config reset` repairs a broken config (with a backup).
  - `doctor` exits non-zero on failure.
  - `verify` on a VERIFIED task is idempotent.
  - Memory evidence must resolve to a real VERIFIED run or artifact.
- **Search ranking** for natural-language queries: stopwords, stemming, indexed and weighted path, prose down-weighting.
- **Mode selection.** The TEAM gate rose to ≥ 10 weight per teammate, conflicts are reported after serialisation, and "writing" is decided by owned files or class.
- **DB.** `busy_timeout` is set before WAL, migrations re-check under the write lock, and the full integrity check moved to `doctor`.

### Added
- Plugin icon (`.claude-plugin/icon.png`).
- Update-safe statusline: settings point to a user-scope shim that follows the plugin root refreshed by each SessionStart.
- Claude Code plugin with a manifest, a single-plugin marketplace, 6 specialist agents, 6 skills (orchestrate, understand-codebase, investigate, review, resume, setup), and 5 lifecycle hooks.
- `kilamu` CLI that runs TypeScript directly on Node ≥ 22.18 with zero runtime dependencies.
- Orchestration engine:
  - plan normalisation and validation, DAG analysis, and serialisation of file-ownership conflicts;
  - deterministic SINGLE/SUBAGENT/TEAM mode selection that explains its choice;
  - dispatch briefs with model routing.
- Execution persistence:
  - SQLite (`node:sqlite`) with versioned migrations and a guarded task state machine (VERIFIED only through the verification engine);
  - checkpoints, bounded retries, session-start reconciliation, and compaction preservation.
- Verification engine:
  - detection of project checks;
  - acceptance criteria of five kinds: command, file_exists, file_contains, artifact, and attestation;
  - no-shell, allowlisted execution with evidence artifacts.
- Knowledge graph:
  - incremental indexing with gitignore and sensitive-file exclusion;
  - heuristic extractors for TS/JS, Python, Go, Rust, Java/Kotlin, C/C++, C#, SQL, Markdown and config files;
  - FTS5 search, cross-layer impact tracing, and PDF text extraction via `pdftotext`.
- Context engine:
  - content-addressed artifacts with redaction;
  - log compression for vitest/jest, pytest, go, cargo, tsc, eslint, npm and tracebacks;
  - budgeted context packs and read-dedup tracking.
- Persistent memory with validation, staleness detection, promotion rules and Markdown/JSON export.
- Cost intelligence:
  - statusline usage samples (MEASURED);
  - budget estimates (ESTIMATED);
  - model policy, and cost per verified task.
- Observability: events, the statusline HUD with install and rollback, and `kilamu doctor`.
