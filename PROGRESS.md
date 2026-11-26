# Kilamu Code — Progress Report (0.1.0)

Last updated: 2026-11-25 · Lead: Claude (founding engineering team) · Founder: Wilker Flores

## Verification evidence (fresh runs)
| Check | Result |
|---|---|
| `npm run typecheck` (tsc strict, erasableSyntaxOnly) | clean, 0 errors |
| `npm test` (vitest: unit, integration, e2e) | **391/391 passed** in 25 files (latest full run; no `.skip`/`.only`) |
| `claude plugin validate .` | ✔ Validation passed |
| `claude --plugin-dir . plugin list` / `plugin details` | ✔ loaded. 6 skills, 6 agents, 5 hooks; ~1,085 always-on tokens (Claude Code's estimate) |
| Live headless session (`claude -p --model haiku --plugin-dir .`) | SessionStart injected `[Kilamu Code] Active execution …`; `kilamu version` ran as a bare command through the plugin's `bin/` |
| Local benchmarks (`npm run bench`) | see `docs/COST_ENGINE.md` |
| Dogfood execution on this repo | `ex_0mwwme603e99d9f7829`: SINGLE mode, task B1 VERIFIED on 4/4 criteria (`npm run typecheck`, 2× file_contains, the benchmark run); evidence artifacts recorded |

## Feature classification

### IMPLEMENTED AND VERIFIED
These have automated tests, and where noted, live or dogfood evidence.
- **Plugin.** Manifest, single-plugin marketplace, 6 agents, 6 skills, 5 hooks. It validates and loads, and its orientation hook was verified live.
- **`kilamu` CLI.** Runs through Node type stripping with zero runtime dependencies. On the Bash PATH (verified live).
- **Plan intake.** Normalisation, validation (cycles, dependencies, criteria, read-only roles owning files, paths, numeric ranges), file-conflict serialisation, and policy rejection of unsafe verification commands at plan time.
- **Mode selection.** Deterministic SINGLE/SUBAGENT/TEAM with factors, reasons and constraints. TEAM falls back to SUBAGENT when teams are unavailable.
- **Task state machine.**
  - Guarded, atomic transitions.
  - VERIFIED only through a persisted, attempt-bound verification run.
  - Bounded retries; human unblock capped at two.
  - Blocking propagates through dependency chains to a fixpoint.
  - An execution becomes COMPLETED, CANCELLED, or reports PARTIAL.
- **Verification engine.** Argv-template command policy, no shell, process-group timeouts, file and artifact checks, attestations with a self-attestation guard, and evidence artifacts.
- **Durable state.** SQLite through `node:sqlite`; migrations v1 → v2; WAL; corruption quarantine; export, import, cleanup.
- **Recovery.** Session-scoped reconciliation, verify-first for changed or unprovable work, `recover --force`, and the SessionStart orientation (verified live).
- **Compaction.** PreCompact preservation instructions (output tested; live compaction not exercised).
- **Knowledge.** Incremental index, heuristic extractors for 10 language families, FTS5 search (ranking fixed after dogfooding), and cross-layer impact (customer_id fixture traced across 6 layers).
- **Context.** Budgeted, fenced, redacted context packs. Content-addressed artifacts with line-range retrieval. Log compression (e2e: a failure in the middle of a 4,000-line log found with its range).
- **Memory.** Validation with resolvable evidence, staleness detection, promotion rules, Markdown and JSON export, and secret rejection.
- **Cost.** Statusline usage samples labelled MEASURED, budget estimates labelled ESTIMATED, budget stop, cost per verified task with UNAVAILABLE when unknown, and a model policy passed per Agent call.
- **Security.**
  - Trust-on-init for data dirs, with a secret token and refusal of git-tracked dirs.
  - Sensitive-path exclusion; redaction at every persistence boundary.
  - O_NOFOLLOW logs, `umask 077`.
  - Shell-safe briefs; sanitised fences.
- **HUD.** Statusline rendering from real payloads (e2e). Install and uninstall with backup, refusal, and preservation of the original on reinstall. An update-safe shim follows plugin updates (tested with a simulated new version path).
- **Diagnostics.** `kilamu doctor` covers capabilities, storage, schema, integrity and statusline, and exits non-zero on failure.

### IMPLEMENTED BUT NOT FULLY VERIFIED
- **The orchestrate skill driven autonomously by a model end-to-end.** The CLI workflow it uses is verified, and the skill text was checked against the CLI by the reviewers, but no autonomous model run of the full skill was executed.
- **TEAM mode in a live interactive Agent Teams session.** Selection logic and the TaskCompleted gate are tested; live teammates were not spawned under Kilamu.
- **SessionEnd hook.** Unit-tested; live firing not observed.
- **Per-session task attribution through `CLAUDE_ENV_FILE`.** Implemented and safe when absent (tasks stay unattributed and ownership is never guessed). The live export was not observed: the live check was not run in this environment.
- **PostToolUse automatic compression of Bash output.** Opt-in and off by default. Unit-level only; `updatedToolOutput` not exercised live.
- **Statusline in a live interactive session.** Tested with real payload shapes, not installed in a live UI.
- **macOS/WSL.** Linux only.

### PARTIALLY IMPLEMENTED
- **Duplicate-read tracking.** The API exists and is tested; no hook feeds it.
- **Knowledge graph depth.** No call graph, no Tree-sitter, and ORM mapping only for Django and SQLAlchemy. YAML, TOML and JSON cover top-level keys and dependencies only.
- **Tool intelligence.** Discovery covers project `.mcp.json` only, by name and transport. Recommendations come from keyword heuristics. A result cache API exists but is unused by commands.

### PLANNED
- A/B model benchmark against plain Claude Code (protocol in `docs/COST_ENGINE.md`; needs consent because it spends usage).
- Tree-sitter parsers.
- Worktree isolation for TEAM writers.
- Re-planning of active executions.
- Cross-platform CI.

### BLOCKED (platform)
- Per-agent token or cost attribution: not exposed by Claude Code.
- Agent Teams in headless `-p` mode: teams do not form there.

## Security findings
- **Round 1:** an independent security review found 2 HIGH, 6 MEDIUM and 4 LOW issues. The architecture review found D1–D11; the code review found 4 HIGH and 13 MEDIUM issues. All HIGH and MEDIUM items were fixed with regression tests (`tests/e2e/review-regressions.test.ts`, `tests/unit/verification/policy.test.ts`, `tests/unit/core/*`, new cases in `tests/unit/execution/*`). A flaky trust test then revealed that inode identity is reusable, so trust is now bound to a secret token (ADR-013).
- **Round 2:** an independent security and architecture re-review confirmed the round-1 fixes and found more issues:
  - **Security:**
    - inline code through `node --test --test-reporter=data:…`, plus plugin/reporter flags and remote Maven goals;
    - symlink-following temp writes during `init` adoption and statusline install;
    - an unredacted owner field;
    - symlinks bypassing the sensitive-path check.
  - **Architecture:**
    - tasks attributed to the wrong session through shared state;
    - an end marker that was never cleared;
    - ambiguous execution resolution with several ACTIVE executions;
    - verify-first work not holding its files;
    - memory evidence that accepted any artifact;
    - doc overclaims.

  All are fixed and regression-tested. The changes: URL/specifier and code-loading-flag bans; symlink-safe `fsx` writes; explicit `KILAMU_SESSION_ID` exported through `CLAUDE_ENV_FILE`; never guessing ownership; execution-qualified briefs and tags; refusal of implicit resolution when ambiguous.
- **Documented residual risks:**
  - Verification runners execute project code, which is not a sandbox.
  - Attester identity is self-declared.
  - Regex redaction and injection detection are heuristic.
  - `file_contains` ReDoS is possible.

## Benchmarks (local, no model calls)
Median of 5 runs on this repository:
- **Incremental re-index:** about 0.3 s.
- **Context packs:** a 6K-token pack carries about 25% of the tokens of the naive "read every contributing file" baseline (ESTIMATED). Sufficiency was not measured.
- **Log compression:** 3/3 synthetic failure logs had the failure extracted, at ratios from 0.003 to 0.066.

No savings percentage versus plain Claude Code is claimed. See `docs/COST_ENGINE.md`.

## Prioritised remaining work
See `TASKS.md` → "Next up".
