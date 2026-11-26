# Roadmap

Priorities are ordered by expected verified-output-per-token impact.

## 0.2 — Precision and measurement
1. Tree-sitter (WASM) parsers for TS/JS and Python, replacing the heuristic extractors for call and reference edges. Confidence is reported per parser.
2. Live A/B benchmark runs: the harness in `scripts/bench.ts` with Claude Code headless runs, repeated trials, and published medians and variance.
3. Live validation of the PostToolUse `updatedToolOutput` compression for Bash, then a decision on whether to enable it by default.
4. A stable statusline shim that survives plugin updates.

## 0.3 — Orchestration depth
1. Worktree isolation (`isolation: worktree`) for TEAM writers, with an explicit integration and merge step.
2. Re-planning: amend an active execution (add, split or cancel tasks) without starting over.
3. Mode-threshold tuning from benchmark data.
4. Per-task budget enforcement from SubagentStop timing where the platform exposes it.

## 0.4 — Knowledge
1. ORM mappers for Prisma, TypeORM, ActiveRecord and Hibernate. API contract ingestion (OpenAPI/GraphQL). Infrastructure graphs (Terraform, Kubernetes).
2. Optional semantic retrieval, only where it is measured to beat deterministic retrieval.
3. Memory: automatic proposals of execution memories from verified runs, with human confirmation.

## Later
- Optional external providers, explicitly configured and authorised by the user.
- CI on Windows/WSL. Linux and macOS already run in CI.
