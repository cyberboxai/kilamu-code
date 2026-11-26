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

## A/B model benchmark (first run: 2026-11-26)
Comparing standard Claude Code with Claude Code plus Kilamu spends real model usage. The founder approved one run. The harness is `scripts/ab-bench.ts`. Raw per-trial data: `docs/benchmarks/ab-2026-11-26-07-11-19.json`. Generated report: `docs/benchmarks/ab-2026-11-26-07-11-19.md`.

### Protocol as run
- **Arms.** A: `claude -p --model sonnet --output-format json`. B: the same command plus `--plugin-dir <kilamu>`, with `kilamu init` run in the trial project. Both arms get the same prompt, allowed tools and max turns (40).
- **Trials.** Each trial gets a fresh, git-initialized temp copy of the fixture.
- **Acceptance.** `node --test` exits 0 **and** the fixture's test files are byte-identical.
- **Metrics.** MEASURED by Claude Code (`total_cost_usd` is the client-side list price, not a bill).

**Deviation from the designed protocol:** this run used **3 tasks × 3 runs per arm** (18 trials). The design called for 6 task kinds and N ≥ 5. Schema investigation, security review and log triage fixtures do not exist yet.

### Results (medians, [Q1–Q3])
| task | arm | verified | cost USD | total tokens | turns | duration s |
|---|---|---|---|---|---|---|
| bugfix-pagination | A-plain | 3/3 | 0.1296 [0.1279–0.1557] | 190,239 | 8 | 31.6 |
| bugfix-pagination | B-kilamu | 3/3 | 0.1275 [0.1249–0.1306] | 153,853 | 7 | 28.7 |
| feature-slugify | A-plain | 3/3 | 0.1112 [0.1109–0.1112] | 111,971 | 3 | 11.9 |
| feature-slugify | B-kilamu | 3/3 | 0.1140 [0.1139–0.1141] | 113,902 | 3 | 17.1 |
| refactor-rename | A-plain | 3/3 | 0.1095 [0.1095–0.1123] | 111,641 | 3 | 13.8 |
| refactor-rename | B-kilamu | 3/3 | 0.1135 [0.1128–0.1136] | 113,926 | 4 | 11.7 |

Totals: both arms verified 9/9. Cost per verified task: A 0.1227 USD, B 0.1183 USD.

### Interpretation
- **Correctness: no difference.** Both arms verified every trial. No trial tampered with tests, errored or hit a permission denial.
- **Small tasks: Kilamu is worse.** On `feature-slugify` and `refactor-rename`, B costs **+2.5%** and **+3.7%** more (median). It uses about **+1.9K–2.3K tokens per session**, which is Kilamu's always-on overhead (plugin listing plus SessionStart orientation). This matches the expected cost of the always-on layer. B was also slower on `feature-slugify` (17.1 s vs 11.9 s, median).
- **Bugfix: B is slightly cheaper, but not significantly.** The median cost is −1.6% and median tokens are −19%. But the spread comes mostly from arm A's run 1 (0.1818 USD, with a large prompt-cache write). Run order and prompt-cache warmth are a confound at this sample size.
- **The total "−3.6% cost per verified task" for B is not a savings claim.** It is within noise and driven by that one A outlier.
- **Kilamu did not engage.** No trial in either arm spawned a subagent. On these small single-agent tasks, arm B measured Kilamu's overhead only, not its orchestration, context packs or verification.
- **Confound.** Both arms load the same user-level configuration (global CLAUDE.md, other enabled plugins). Only `--plugin-dir` differs.

### Harness v2 (ready, not yet run)
The gaps above are addressed in the harness. The paid run has not happened yet.

- **Fixtures (`tests/fixtures/ab/`).** There are 7 tasks:
  - the original 3;
  - `schema-rename` (rename `customer_id` → `account_id` across schema, model, repository, serializer, API and report, checked with `node:sqlite`);
  - `security-fix` (path traversal and SQL injection, including a second injectable function the task does not name);
  - `log-triage` (wrong batch totals, with the clue in a 4,287-line log);
  - `multi-feature` (4 independent modules with 19 tests, sized to make SUBAGENT mode possible).
- **Reference solutions (`tests/fixtures/ab-solutions/`).** They live outside the fixture directory. `tests/benchmarks/ab-fixtures.test.ts` proves several things for every fixture:
  - it fails as shipped;
  - it passes with its solution, with `test/` unchanged;
  - every path its TASK.md names is actually shipped. The log-triage log was at first dropped by the repository's `*.log` ignore rule, which this check now catches.
- **Keeping solutions out of reach.** Arm B's `--plugin-dir` is a temp copy of the plugin's own files (`.claude-plugin`, `agents`, `bin`, `hooks`, `skills`, `src`, `package.json`), not the repository. So neither arm learns the repository path. A session whose output mentions `ab-solutions` is marked invalid.
- **Trial setup.** Each trial copies only the fixture's git-visible files, so ignored local state such as `.omc/` cannot leak in. (In the first run, a stray 342-byte `.omc` state file was copied into both arms of `feature-slugify`.)
- **Tamper check.** The baseline is the trial's own `test/` tree, hashed before the agent runs, not the source directory.
- **Arm order.** It is shuffled per (run, task) from a recorded `--seed`.
- **`--isolate`.** It passes `--setting-sources project,local --strict-mcp-config` to both arms. `--bare` is not used, because it also disables plugin hooks (Kilamu's included) and accepts only API-key auth.
  - **Unverified:** whether this drops user-enabled plugins, and whether the global CLAUDE.md still loads. `claude plugin list` ignores these flags, so it cannot show this.
  - **Evidence:** each trial now records the `plugins` and MCP server count from its session's `system/init` event.
  - **Enforced:** after every (run, task) pair, arm B must load exactly arm A's plugins plus Kilamu. Otherwise the run aborts and writes what it has, so a broken isolation costs at most one pair.
- **Engagement.** Each trial records Kilamu CLI calls (including multi-line and path-qualified invocations), Kilamu skill invocations, Kilamu agent calls and all Agent/Task calls made by the main agent. These are parsed from `--output-format stream-json`. The report shows "Kilamu engaged" per cell.
- **Costs and tokens.** A timed-out session keeps its partial stream. A trial without a cost figure is reported as missing, never counted as 0. Tokens come from `modelUsage`, which covers all models including subagents, with `usage` (main loop only) as the fallback. The source is recorded per trial.

Planned run: `--runs 5 --isolate`, 7 tasks × 5 × 2 = 70 trials on `sonnet`. The first run's per-trial cost suggests about 9–20 USD (ESTIMATED). It needs the founder's go-ahead.

No savings percentage versus plain Claude Code is claimed.
