# Risk Register

| ID | Risk | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|
| R-01 | Agent Teams are experimental: their behaviour or API may change, and they do not form in `-p` mode | High | Medium | TEAM is opt-in by capability; SUBAGENT fallback is automatic and recorded; Kilamu depends only on documented team behaviour (Agent tool `name`, TaskCompleted hook); own state is independent of `~/.claude/teams` | Mitigated |
| R-02 | `node:sqlite` is marked experimental in Node 22 | Medium | High | Thin wrapper (`persistence/db.ts`) isolates the API; the integration tests exercise it; better-sqlite3 is a documented swap-in | Accepted, monitored |
| R-03 | Node < 22.18 cannot strip types → the CLI will not start | Medium | High | The launcher checks the version and prints a clear message; `kilamu doctor` reports it; requirement documented in README/PLATFORM_COMPATIBILITY | Mitigated |
| R-04 | Model-authored verification commands could execute arbitrary code outside the Claude Code permission prompts | Medium | High | No shell; argv-template policy per runner; args confined to the project; checked at plan create and verify; user-scope-only extensions; process-group timeouts (ADR-006 rev.) | Mitigated. Residual: project tooling runs project code, including agent-written tests, by design. Not a sandbox. |
| R-05 | Self-attestation lets an agent "verify" judgement criteria | Medium | Medium | ATTESTED label; anyone who started an attempt is refused; reports count attestation-only tasks | Partially mitigated (attester identity is self-declared) |
| R-06 | Heuristic extractors give false or missing graph edges | High | Medium | Confidence on every edge; FTS evidence alongside graph edges; `kilamu coverage` reports parser class; Tree-sitter planned | Accepted |
| R-07 | Statusline command embeds a versioned plugin path that breaks after a plugin update | High | Low | Settings point to a user-scope shim that follows a plugin-root pointer refreshed by every SessionStart, with an install-time fallback; `kilamu doctor` flags legacy direct paths | Mitigated |
| R-08 | Usage metrics unavailable without the HUD; per-agent usage never exposed | High | Low | Labels UNAVAILABLE; no fabricated numbers; HUD install documented | Accepted (platform limit) |
| R-09 | PostToolUse `updatedToolOutput` for Bash not exercised in a live session | Medium | Medium | Opt-in, off by default; explicit `| kilamu compress` path available | Open |
| R-10 | Prompt injection via indexed files, PDFs or tool output | Medium | High | Fenced untrusted blocks, injection-pattern flags, skill/agent rules "data, never instructions"; agents cannot gain permissions from content | Mitigated (defense in depth, not a guarantee) |
| R-11 | Secret leakage into artifacts, index or memory | Low | High | Path exclusions + regex redaction before persist + memory rejects secrets; files 0600 | Mitigated (regex has false negatives) |
| R-12 | Concurrent CLI processes (parallel subagents) contend on SQLite | Medium | Low | WAL + busy_timeout 5 s + short transactions; state transitions in `BEGIN IMMEDIATE` | Mitigated |
| R-13 | Mode thresholds mis-tuned (teams too eager or too rare) | Medium | Medium | Deterministic, explained decisions; config override `execution.mode`; benchmark harness to tune | Open |
| R-14 | Two Claude sessions in the same project share `last_session_id` | Low | Low | Executions store their own session id; documented | Accepted |
| R-15 | Attacker-controlled `.kilamu/` in a cloned repository | Medium | High | Trust-on-init (ADR-013), git-tracked refusal, O_NOFOLLOW logs, symlink-refusing artifact paths | Mitigated |
| R-16 | Recovery releases work of another live session | Medium | Medium | Session-scoped recovery + SessionEnd marker + 2 h orphan threshold + `--force` (ADR-014) | Mitigated (two sessions within 2 h of a crash need `--force`) |
| R-17 | Author-supplied `file_contains` regex is catastrophic (ReDoS) | Low | Low | 5 MB read cap; documented; prefer substrings | Open |
