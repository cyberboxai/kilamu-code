# Technical Decisions (ADRs)

Each decision is listed with its context, choice, rationale and consequences. Superseded decisions stay in the log and are marked as superseded.

## ADR-001: The model plans, the engine decides
- **Context.** Natural-language decomposition needs a model. Bookkeeping, scheduling and verification do not. A model-based classifier on every message would waste tokens (§8.4).
- **Decision.** Claude, guided by the `orchestrate` skill, drafts a JSON plan. The deterministic engine (`kilamu plan create`) then normalises it, validates it, removes conflicts, selects the mode, budgets it, owns task state, and runs verification.
- **Rationale.** Each layer does what it is best at. The engine is unit-testable and explainable, and it costs zero tokens.
- **Consequences.** The quality of a plan depends on the model. The engine rejects structurally bad plans: cycles, missing criteria, unknown roles, read-only roles that own files.

## ADR-002: Built-in `node:sqlite` instead of better-sqlite3
- **Context.** Durable state and FTS5 search are required (§13, §9.2). Native addons need compilation, which breaks plugin installs that run from a git clone with no `npm install`.
- **Decision.** Use Node's built-in `node:sqlite` (`DatabaseSync`). It has FTS5 compiled in and has been unflagged since Node 22.13.
- **Rationale.** Zero runtime dependencies and nothing to compile.
- **Consequences.** The API is marked experimental and emits an ExperimentalWarning, which the launcher suppresses. This is tracked as risk R-02.

## ADR-003: Run TypeScript sources directly (no build step)
- **Context.** A plugin installed from a marketplace is a git checkout. It has no build hook.
- **Decision.** Write erasable-syntax TypeScript (no enums, namespaces or parameter properties; `.ts` import specifiers). Node ≥ 22.18 runs it natively. `tsc --noEmit` is used for type-checking only.
- **Consequences.** Node ≥ 22.18 is required, and the launcher enforces this. No `dist/` directory exists to drift out of sync with `src/`.

## ADR-004: Project-local state in `.kilamu/`
- **Decision.** All state lives under `<project>/.kilamu/` (overridable with `KILAMU_DATA_DIR`). That directory contains its own `.gitignore` with `*`, so it is never committed. Kilamu never edits the project's `.gitignore`.
- **Rationale.** Local-first storage (§18). State is easy to inspect, back up (`kilamu export`) and delete. Execution state follows the project.
- **Consequences.** Hooks are no-ops in projects without `.kilamu/`. Kilamu does not create state in every directory the user opens.

## ADR-005: VERIFIED is unforgeable through the CLI
- **Decision.** `ExecutionStore.transition()` rejects `VERIFIED`. Only `applyVerification()` can set it, and it cross-checks a persisted `verification_runs` row with a matching verdict, execution and task. Verification commands run in the engine, which captures their output as evidence artifacts.
- **Revision.** Runs are bound to the attempt they verified (`verification_runs.checkpoint_id`). READY → VERIFYING is allowed only for reconciled verify-first tasks, which closes an unbounded retry loop found in review. Attesters are checked against everyone who started an attempt, not only the current owner.
- **Consequences.** An agent cannot mark itself done. Attestation criteria are the honest escape hatch for judgement calls. They are reported as ATTESTED rather than verified.

## ADR-006: Verification commands run without a shell, behind an argv-template policy (revised)
- **Context.** Plans are written by the model. When `kilamu verify` runs their commands, Claude Code's per-command permission prompt never sees them. Without limits this would be a silent permission escalation (§17).
- **Original decision (superseded).** A program allowlist plus a few inline-code flag checks. The security review showed that this does not confine anything: `node -pe`, `npx pkg`, `npm exec -c`, `git -c alias.x=!cmd` and `docker run` all passed. The model could also widen the allowlist through `kilamu config set`.
- **Decision.** Commands must match an argv template per runner (see SECURITY.md and `src/verification/policy.ts`). No argument may point outside the project. The policy is enforced both at plan creation and at verify time. Extensions live only in user-scope config.
- **Consequences.** Some legitimate pipelines must be wrapped in a package script. The policy is explicit that project tooling executes project code; it is not a sandbox.

## ADR-007: Adaptive mode selection with explicit thresholds
- **Decision.** A pure function maps graph metrics to SINGLE, SUBAGENT or TEAM, and returns every factor it used. The metrics are: total weight, critical path, parallelism bound, writing width, conflicts, and team availability.
  - **TEAM** requires all of the following:
    - at least 2 concurrent writing streams (a task writes if it owns files or has a writing class);
    - no concurrent file conflicts;
    - a parallelism bound of at least 1.6;
    - at least 10 weight per teammate stream (one large or two medium tasks; raised from 5 after review showed two default tasks forming a team);
    - Agent Teams available.
  - Read-only parallel work → **SUBAGENT**.
  - Small or sequential work → **SINGLE**.
- **Rationale.** "Team-first, not team-everywhere" (§3.3). Every teammate is a full Claude instance, so its context initialisation must be paid for by real parallelism.
- **Consequences.** The thresholds are estimates. They are documented in `docs/ORCHESTRATION.md` and will be tuned against benchmark data.

## ADR-008: Model routing through the per-invocation `model` parameter
- **Decision.** Map task class to a model alias. The mapping is configurable in `models.*`. It is emitted in each dispatch brief and passed as the Agent tool's `model` parameter. Each agent definition carries a sensible default `model`.
- **Rationale.** The Agent tool's `model` parameter is the documented highest-priority override. It requires no settings mutation and never touches the main-session model.

## ADR-009: Heuristic extractors before Tree-sitter
- **Decision.** Version 0.1.0 ships regex and line-scanner extractors per language family. Every heuristic edge carries a confidence below 1, and `kilamu coverage` reports each parser's class honestly. Tree-sitter (WASM) is planned for a later release.
- **Rationale.** Zero native dependencies, fast incremental indexing, and enough structure for impact tracing and retrieval. Precision limits are stated, not hidden.

## ADR-010: Do not parse transcripts. Usage comes only from the statusline
- **Decision.** Usage samples are recorded only from the documented statusline payload, labelled MEASURED. Budgets and estimates are labelled ESTIMATED. Per-agent usage is labelled UNAVAILABLE.
- **Rationale.** The transcript format is undocumented (§6.2), and the honesty rules apply (§3.6).
- **Consequences.** Without the HUD installed there are no MEASURED tokens, and cost reports show UNAVAILABLE.

## ADR-011: PostToolUse compression is opt-in and gated in shell
- **Decision.** `context.compressToolOutput` defaults to false. When it is off, the hook script exits before Node starts, using a `grep` on the project config, so normal Bash calls pay roughly 2 ms.
- **Rationale.** Rewriting tool output changes what Claude sees. That should be a deliberate choice, and the live behaviour of `updatedToolOutput` for Bash has not yet been exercised. Agents get the same benefit explicitly through `<cmd> | kilamu compress`.

## ADR-012: Development team shape
- **Decision.**
  - One lead owns the contracts in `src/core/types.ts`, the schema, orchestration, execution, the CLI, hooks and the plugin surface.
  - Three parallel engineers own disjoint directories:
    - knowledge;
    - context + memory;
    - verification + cost + tools + observability.
  - Shared contracts were frozen before they started.
- **Rationale.** This is the smallest team that parallelises the independent subsystems without concurrent edits to shared files (§4, §26).

## ADR-013: Trust-on-init for project data directories
- **Context.** The security review (H2) showed that a `.kilamu/` committed to a repository is attacker-controlled. A planted DB injected SessionStart text, a planted config widened the policy, and a planted symlinked log redirected writes outside the directory, all with zero clicks.
- **Decision.** A data directory is used only if `kilamu init` registered it in a user-scope trust file. The record binds the realpath to the hash of a random secret token stored in `.kilamu/.trust-token`. Inode identity was tried first and rejected: inode numbers are reused, so a re-created directory could inherit trust. A `.kilamu/` tracked by git, or a non-empty untrusted one, is refused. No command except `init` creates state. All Kilamu writes use symlink-safe temp files.
- **Consequences.** Users run `kilamu init` once per project. Hooks are silent elsewhere.

## ADR-014: Session-scoped recovery
- **Context.** Reconciling every ACTIVE task at any SessionStart released tasks that were still running in another live session (reproduced in review), which led to duplicate dispatch.
- **Decision.** Tasks record the session that started them. SessionStart releases a task only when one of the following holds:
  - it belongs to the restarting session;
  - its session ended (new SessionEnd hook);
  - it has been silent for 2 hours.

  `kilamu recover --force` covers crashes. Release is conservative: a task without a snapshot, or one that owns a directory, is marked *verify first*.

## ADR-015: Search ranking for natural-language queries
- **Context.** Dogfooding showed natural-language queries surfacing docs and stopword matches instead of the relevant source files.
- **Decision.** Drop English stopwords, OR the remaining terms, and apply Porter stemming. Index the file path with a bm25 weight of 3. Boost paths that name a query term and down-weight prose by 0.75.
- **Consequences.** This is a heuristic. A regression test pins the motivating case.
