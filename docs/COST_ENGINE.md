# Cost Engine

## Principle
Optimise **resource cost per verified task**. A workflow that uses fewer tokens but produces unverifiable work is not an improvement. Every number Kilamu reports carries one of three labels:

| Label | Meaning | Sources in 0.1.0 |
|---|---|---|
| MEASURED | Observed from a documented platform surface | Statusline payload: `context_window.total_input_tokens/total_output_tokens`, `used_percentage`, `cost.total_cost_usd`, `cost.total_duration_ms`, `prompt_cache.hit_ratio` |
| ESTIMATED | Computed heuristically | chars/4 token estimates; plan budget estimates |
| UNAVAILABLE | Not exposed or not recorded | Per-agent usage (the platform does not expose it); any metric without statusline samples |

`cost.total_cost_usd` is computed client-side at list price. On subscription plans it is **not your bill**, and Kilamu says so in every cost report.

## Usage tracking
The optional HUD statusline records one sample per refresh into `usage_samples`, throttled: a sample is skipped when nothing changed and the previous one is under 5 s old. Execution usage is the session delta between the first sample at or after the execution's start and the latest sample. Tokens spent before that first sample are not counted, and the report notes this.

## Budgets (`src/cost/policy.ts`, all ESTIMATED)
| Component | Constant |
|---|---|
| Work per task | trivial 8K · small 20K · medium 50K · large 120K tokens |
| Agent context initialisation | 20K per agent in SUBAGENT/TEAM modes; 0 in SINGLE |
| Team coordination | +10% of work per extra teammate, capped at 40% |
| Verification reserve | 15% |

The execution budget is `max(execution.defaultBudgetTokens, estimate)`, or the plan's own `budgetTokens`. `kilamu next` warns at 80% of the non-reserve budget and refuses to dispatch at 100%, based on MEASURED usage only. Without measurements it never blocks; it shows the budget as unmeasured.

## Model policy
`models.<taskClass>` maps each task class to a model alias (see ORCHESTRATION.md). Cheap models handle discovery and summarisation. Opus is reserved for architecture and security. The alias is passed per Agent invocation.

## Platform overhead (MEASURED by Claude Code itself)
`claude plugin details kilamu-code` reports about **1,085 always-on tokens** per session for the plugin's skill and agent descriptions. Hooks cost nothing in model context. The orchestrate skill adds about 1.8K tokens when invoked. Claude Code labels these figures as its own estimates.

## Local benchmarks (`npm run bench`, no model calls)
Run on 2026-11-25 against this repository (Node 22.23.2, Linux, a loaded 4-core machine with a rotational disk):

```
## Indexing (this repository, 140 files, 5 runs, MEASURED wall time)
cold        median 2048 ms (min 1322 / max 2597)
incremental median 160 ms (min 150 / max 265)

## Context selection (ESTIMATED tokens, chars/4)
| query | pack tokens | naive full-file tokens | files | ratio |
|---|---|---|---|---|
| verification engine allowlist | 5994 | 13105 | 11 | 0.46 |
| task state machine transitions | 5996 | 24084 | 12 | 0.25 |
| how is secret redaction done | 5790 | 25171 | 15 | 0.23 |
| impact analysis layers | 5990 | 20949 | 13 | 0.29 |
| statusline usage parsing | 5777 | 25083 | 17 | 0.23 |
median pack/naive ratio: 0.25 (lower = less context; quality not measured here)

## Log compression (ESTIMATED tokens)
| case | raw | summary | ratio | failure found | status (no exit code given) |
|---|---|---|---|---|---|
| vitest 3k tests, 1 failure | 32589 | 109 | 0.003 | yes | failure |
| tsc 400 errors (repetitive) | 8223 | 543 | 0.066 | yes | failure |
| build log 8k lines, 1 error | 73738 | 229 | 0.003 | yes | unknown |
```

How to read these results:
- **Context selection.** A 6K-token pack carries about 25% (median) of the tokens that reading every contributing file in full would cost. These counts are ESTIMATED. The benchmark does **not** measure whether the pack was sufficient for the task. Pack quality is evaluated only qualitatively in this release, and the ranking fix is described in PROGRESS.md.
- **Compression.** All three synthetic failure logs had their failure extracted. For repetitive tsc output the summary is larger (ratio 0.066) because distinct file:line findings are kept, up to 25. Without an exit code, a generic build log gets the honest status `unknown`.
- **Indexing.** An incremental re-index of an unchanged repository takes about 0.3 s.

## A/B model benchmark (designed, NOT executed)
Comparing standard Claude Code with Claude Code plus Kilamu spends real model usage. It therefore needs the founder's explicit go-ahead and was **not run** for 0.1.0. The protocol:

1. **Repository snapshot.** Use a fixed snapshot (a tagged fixture repository) with 6 tasks of the kinds listed in the directive (§22): a feature, a multi-file refactor, debugging, schema investigation, a security review, and log triage.
2. **Two arms, identical settings.**
   - Arm A: `claude -p --model sonnet`.
   - Arm B: the same command plus `--plugin-dir kilamu-code`.
   - Both arms use the same allowed tools, the same prompt and the same acceptance script.
3. **Trials.** Run N ≥ 5 trials per task per arm. Record:
   - tokens and cost, from `--output-format json` usage;
   - wall time;
   - tool-call count;
   - verification pass/fail, using the same acceptance script in both arms.
4. **Reporting.** Report the median and IQR per task, together with completion rate and **cost per verified task**. Include the tasks where Kilamu is worse; small single-file tasks are expected to be worse, because of the always-on overhead.

No savings percentage is claimed until this benchmark has been run.
