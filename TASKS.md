# Kilamu Code — Task Backlog

Status values: ✅ done and verified · 🟡 done, not fully verified · ⏳ planned · ⛔ blocked.

## Phase 0: Discovery and architecture ✅
- ✅ Repository and environment assessment (empty repository; Node 22.23, Claude Code 2.1.332, Agent Teams flag set)
- ✅ Platform research: `docs/PLATFORM_RESEARCH.md`
- ✅ Architecture and module contracts: `docs/ARCHITECTURE.md`, `src/core/types.ts`
- ✅ ADRs (`docs/TECHNICAL_DECISIONS.md`), risks (`docs/RISK_REGISTER.md`), threat model (`SECURITY.md`)

## Phase 1: Functional MVP ✅
- ✅ Plugin manifest and marketplace; `claude plugin validate` passes; loaded through `--plugin-dir`
- ✅ Six specialist agents and six skills (orchestrate, understand-codebase, investigate, review, resume, setup)
- ✅ Plan intake: normalisation, validation, DAG analysis, conflict serialisation
- ✅ Adaptive mode selection: SINGLE / SUBAGENT / TEAM with rationale
- ✅ Task state machine with VERIFIED reachable only through the engine
- ✅ Verification engine: policy-checked commands, file checks, artifacts, attestations
- ✅ CLI (`bin/kilamu`), diagnostics (`doctor`), init with trust
- 🟡 Natural-language orchestration through the skill. CLI path verified; autonomous model-driven run not executed.

## Phase 2: Context intelligence ✅ / 🟡
- ✅ Incremental project index (files, symbols, edges, FTS5)
- ✅ Selective retrieval and budgeted context packs
- ✅ Artifacts, output compression, line-range retrieval
- ✅ Persistent memory with validation, staleness and promotion
- 🟡 Duplicate-read tracking: API only, no hook feeds it
- 🟡 PostToolUse automatic compression: opt-in, not exercised live

## Phase 3: Cost intelligence 🟡
- ✅ Usage samples from the statusline (MEASURED); labels everywhere
- ✅ Budget estimates, budget stop, model policy, cost per verified task
- ✅ Local deterministic benchmarks (`npm run bench`)
- ✅ A/B benchmark harness (`scripts/ab-bench.ts`). First run on 2026-11-26: 3 tasks × 3 runs, 18/18 verified, overhead measured. Results are in `docs/COST_ENGINE.md`.
- ⏳ A/B benchmark at full protocol scale: remaining task kinds, a task large enough for SUBAGENT mode, N ≥ 5, randomised arm order, isolated user config.

## Phase 4: Persistent execution ✅
- ✅ Durable state, checkpoints, bounded retries, attempt-bound verification
- ✅ Session-scoped reconciliation, verify-first, SessionEnd marker, `recover --force`
- ✅ PreCompact preservation instructions and SessionStart orientation (orientation verified live)

## Phase 5: Knowledge graph 🟡
- ✅ Heuristic extractors for TS/JS, Python, Go, Rust, JVM, C-family, C#, SQL, Markdown, config
- ✅ SQL schema intelligence, cross-layer impact (customer_id fixture across 6 layers)
- ✅ PDF text via `pdftotext`
- ⏳ Tree-sitter parsers, call graphs, ORM mappers beyond Django and SQLAlchemy

## Phase 6: Production readiness 🟡
- ✅ Security review, with HIGH and MEDIUM findings fixed and regression-tested
- ✅ Architecture and code reviews, with must-fix items fixed and regression-tested
- ⏳ Cross-platform CI (macOS, WSL)
- ✅ Plugin icon (`.claude-plugin/icon.png`)
- ✅ Update-safe statusline shim (R-07)

## Next up (priority order)
1. Extend the A/B fixtures (schema, security, log triage, one multi-file task that triggers SUBAGENT) and re-run at N ≥ 5. Tune mode thresholds from the data.
2. Live TEAM-mode execution test with Agent Teams in an interactive session.
3. Live validation of PostToolUse compression and SessionEnd.
4. Tree-sitter extractors for TS/JS and Python.
