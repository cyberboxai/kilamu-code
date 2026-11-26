# Testing

```bash
npm run typecheck     # tsc --noEmit, strict, erasableSyntaxOnly
npm test              # all vitest suites
npm run test:unit | test:integration | test:e2e
npm run bench         # local deterministic benchmarks (no model calls)
claude plugin validate .
```

## Layers
| Layer | Location | What it proves |
|---|---|---|
| Unit | `tests/unit/<module>/` | Each module in isolation. Temporary projects through `tests/helpers/tmp.ts`. Never the repository's own `.kilamu/`. |
| Integration | `tests/unit/execution/recovery.test.ts`, `tests/unit/knowledge/indexer.test.ts`, `tests/unit/context/pack.test.ts` and the verification engine tests | Store ↔ checkpoints ↔ git, indexer ↔ DB ↔ query, pack ↔ knowledge ↔ memory, verification ↔ artifacts ↔ runs |
| E2E | `tests/e2e/cli-workflow.test.ts` | The real `bin/kilamu` launcher driving a throwaway git project through doctor, init, index (secret not indexed), plan, next, a failed verification with retry, VERIFIED, report, the TaskCompleted gate, interruption recovery, compression and artifact range reads, the statusline, and pre-compact |
| Live | Manual: `claude -p --plugin-dir . …` | The plugin loads, the SessionStart orientation is injected, and `kilamu` is on the Bash PATH (see PROGRESS.md) |

## Directive E2E scenarios (§22) and coverage
| # | Scenario | Covered by |
|---|---|---|
| 1 | Simple feature implementation | e2e: multiply function with a failing test, then a fix, then VERIFIED |
| 2 | Multi-file refactoring | Partial: conflict serialisation and ownership tests (graph/store). No live agent refactor. |
| 3 | Debugging with competing hypotheses | Not automated. This is a skill workflow (`investigate`) that requires a model. |
| 4 | Database schema investigation | `tests/unit/knowledge/query.test.ts` customer_id impact across 6 layers |
| 5 | Security review | Not automated. Skill and agent workflow. |
| 6 | Large build output compression | e2e plus compress tests (failure in the middle of a 5,000-line log, with the line range) |
| 7 | Persistent execution recovery | e2e session-start reconcile, plus recovery unit tests |
| 8 | Agent failure and retry | store tests: bounded retries leading to BLOCKED, then unblock. e2e: failed verification, then retry. |
| 9 | Agent Teams unavailable | mode tests: TEAM → SUBAGENT fallback with the constraint recorded |
| 10 | Installation and plugin validation | `claude plugin validate .`, `--plugin-dir` load, live smoke test (manual) |

Acceptance gate for a change: typecheck clean, all tests pass, and no `.skip` or `.only`.
