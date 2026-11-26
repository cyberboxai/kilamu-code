# Known Issues and Limitations (0.1.0)

## Platform limits (not fixable in Kilamu)
- **Per-agent token usage is not exposed** by Claude Code. Kilamu reports it as UNAVAILABLE. Session usage is MEASURED only when the statusline HUD is installed.
- **Agent Teams are experimental.** They do not form in `-p` (headless) mode, and in-process teammates cannot be resumed. Kilamu falls back to SUBAGENT mode. A TEAM-mode execution has not been run end-to-end in a live session for this release; the selection logic and the TaskCompleted gate are tested in isolation.
- **A plugin cannot set the statusline.** `kilamu statusline install` writes user or project settings explicitly. The settings run a small shim (`~/.config/kilamu-code/statusline.sh`), which follows the plugin root recorded by each SessionStart, so plugin updates do not break the HUD. Until the first session after an update, the shim falls back to the install-time path.

## Not yet verified live
- The PostToolUse `updatedToolOutput` compression for Bash is opt-in (`context.compressToolOutput`) and has not been exercised in a live session. The explicit `<cmd> | kilamu compress` path is tested.
- The SessionEnd hook is implemented and unit-tested, but its live firing has not been observed.
- **Session attribution.** The SessionStart hook exports `KILAMU_SESSION_ID` through `CLAUDE_ENV_FILE`, so `kilamu task start` can record the owning session. That live export was not observed (the live check was not run in this environment). Without it, tasks are recorded **unattributed**. Kilamu never guesses ownership, so unattributed tasks are only released by `kilamu recover --force` or after 2 h without updates. The resume skill tells the model to confirm that no other session is active before forcing.
- **No heartbeat.** The 2-hour orphan rule reads the task's last state change. A legitimately long-running task (more than 2 h) with no transitions can be released by another session. Use `kilamu task show` to check before forcing.
- One transient failure (`engine.test.ts › rejects shell metacharacters`) was seen under heavy parallel load. It did not reproduce in 3 later full runs or in isolation.
- Live headless validation covered plugin load, SessionStart orientation injection, and `kilamu` on the Bash PATH. Full skill-driven orchestration by a model (the orchestrate skill end-to-end) was exercised through the CLI, not through an autonomous model run.

## Functional limitations
- **Heuristic parsing.** Extractors are regex and line scanners (no Tree-sitter), and every edge has confidence < 1. Call edges are not extracted. Kotlin bases are always EXTENDS, and C# interfaces are recognised only by the `I` prefix convention. The JS lexer ignores regex literals. YAML, TOML and JSON extraction covers top-level keys and dependency lists only.
- **Impact tracing** depends on those heuristics. SQL embedded in strings (for example in TypeScript template literals) is found only through full-text evidence at confidence 0.2.
- **Directory ownership** requires a trailing `/` (`src/auth/`). `src/auth` without the slash does not overlap `src/auth/x.ts`.
- **Duplicate-read tracking** (`ReadTracker`) exists as an API, but no hook feeds it yet.
- **Memory status reason.** There is no dedicated `statusReason` field. Why an item became STALE or INVALIDATED is appended to `invalidationConditions`.
- **Context packs** rank candidates heuristically. Pack sufficiency is not measured automatically (see COST_ENGINE.md).
- **Compression format detection** is first-match. A combined log, such as npm wrapping tsc, reports only the first format.
- **`file_contains` regexes** are author-supplied and capped at 5 MB, but they are not protected against ReDoS.
- **Attester identity** (`--as`) is self-declared. See SECURITY.md.
- **Two sessions in one project** share `meta.last_session_id`, but it is used only for HUD and usage display, never for task ownership. Execution budgets sum all linked sessions, which are linked at plan creation and at session start or resume.
- **Ambiguity.** With more than one ACTIVE execution, commands without `--exec` are refused. Briefs always include `--exec`.
- **`kilamu --json <cmd>`.** A global flag placed before the command is not supported. Put `--json` after the command.
- **Artifact evidence.** The `artifact` criterion passes once the task has submitted any artifact. It proves an output was recorded, not that the output is correct. Memory validation requires a VERIFIED verification run.

## Environment
- Node ≥ 22.18 is required. Linux is tested. macOS is expected to work but is untested. Windows needs WSL.
- On rotational disks under load, first-time indexing of thousands of files is dominated by fsync (about 17 s for 2,000 files in one measurement).
