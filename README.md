# Kilamu Code

**The Intelligent Multi-Agent Engineering System for Claude Code.**
*Build More. Waste Less. Engineer Smarter.*

Created by **Wilker Flores**. Version 0.1.0. MIT licensed.

> Kilamu Code is an independent, open-source plugin for Claude Code. It is not an Anthropic product and is not endorsed by Anthropic.

Kilamu Code turns Claude Code into a coordinated engineering environment. You describe an objective in plain language. Kilamu then:

1. plans the objective as a task graph with explicit acceptance criteria;
2. chooses whether the work runs in the main session, in parallel subagents, or in a native Agent Team, and explains why;
3. gives each agent only the context it needs;
4. keeps durable task state that survives interruptions;
5. marks work as done only when a verification engine has proven it.

The guiding metric is **verified engineering output per token**. More agents and more activity are not the goal.

## What makes it different

| | Plain prompting | Kilamu Code |
|---|---|---|
| "Done" | The agent says so | `kilamu verify` ran the criteria and stored evidence. The CLI never sets VERIFIED any other way. (An agent with file access could still edit the local SQLite file directly; Kilamu prevents accidental or casual false completion, not tampering by someone with full access.) |
| Parallelism | Ad hoc, or always-on teams | Deterministic SINGLE / SUBAGENT / TEAM selection, with a written rationale and file-ownership conflict control |
| Context | Read files until it fits | Incremental local index (symbols, graph, FTS5) plus ranked context packs under a token budget |
| Long logs | Pasted into context | Compressed to failures with line ranges; the full log is kept as an artifact |
| Interruptions | Start over | Durable SQLite state; interrupted tasks are reconciled and verified before anything is redone |
| Metrics | Guesswork | Every number is labelled MEASURED, ESTIMATED or UNAVAILABLE |

## Requirements

- Claude Code 2.1.x (developed against 2.1.332)
- **Node.js ≥ 22.18**. Kilamu runs its TypeScript directly through Node's type stripping and uses the built-in `node:sqlite`. There is no build step and there are no runtime dependencies.
- Optional: `git` (used for checkpoints and reconciliation), `pdftotext` (for PDF indexing), and Agent Teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, experimental and something you opt into yourself).

## Install

From a clone or a local path:

```bash
claude --plugin-dir /path/to/kilamu-code          # try it for one session
```

From a git repository that hosts this marketplace (`.claude-plugin/marketplace.json`):

```bash
claude plugin marketplace add <owner>/<repo>
claude plugin install kilamu-code@kilamu-code-marketplace
```

Then, inside a project:

```text
/kilamu-code:setup          # user-invoked only (it creates local state), or run `kilamu init` yourself
```

This runs `kilamu doctor` and `kilamu init`. `init` creates `.kilamu/`, which carries its own `.gitignore` so it is never committed. Kilamu never edits your project files, your `.gitignore` or your Claude Code settings during setup.

Optional HUD:

```bash
kilamu statusline install --scope project --dry-run   # preview
kilamu statusline install --scope project             # writes .claude/settings.local.json
kilamu statusline uninstall --scope project           # restores what was there before
```

If you already have a statusline, install refuses to replace it unless you pass `--force`. A backup is always kept. The statusline runs an update-safe shim in `~/.config/kilamu-code/`, so it keeps working after plugin updates.

## Use

Talk to Claude normally. The plugin's skills handle routing:

- "Implement JWT authentication with refresh tokens, migrations and tests" → **orchestrate**
- "Explain how this codebase handles payments" / "What is affected if I change `customer_id`?" → **understand-codebase**
- "Investigate why the checkout test fails" → **investigate**
- "Review the application's security" → **review**
- "Continue the previous implementation" → **resume**

Every skill can also be called explicitly, for example `/kilamu-code:orchestrate <objective>`. The `kilamu` CLI is on Claude's Bash PATH while the plugin is enabled, and you can run it yourself. Use `kilamu help`, and add `--json` to any command for machine-readable output.

```text
kilamu status            current execution, task states, budget
kilamu next              ready tasks with agent briefs
kilamu verify T3         run T3's acceptance criteria and record evidence
kilamu impact customer_id
kilamu context "how are sessions stored" --budget 4000 --content
npm test 2>&1 | kilamu compress --source "npm test"
kilamu report            final verification table and cost metrics
```

## Architecture

The model plans and the engine decides. The full picture is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```
skills/ agents/ hooks/  ──Bash──►  kilamu CLI  ──►  orchestrator · execution · verification
(markdown, no code)                                 knowledge · context · memory · cost
                                                    tools · observability
                                                    └─► .kilamu/state/execution.db (SQLite, WAL)
```

## Documentation

| Doc | Topic |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Modules, boundaries, data flow |
| [PLATFORM_RESEARCH](docs/PLATFORM_RESEARCH.md) · [PLATFORM_COMPATIBILITY](docs/PLATFORM_COMPATIBILITY.md) | Claude Code capabilities and limits |
| [ORCHESTRATION](docs/ORCHESTRATION.md) | Planning, mode selection, scheduling |
| [CONTEXT_ENGINE](docs/CONTEXT_ENGINE.md) · [KNOWLEDGE_GRAPH](docs/KNOWLEDGE_GRAPH.md) · [MEMORY](docs/MEMORY.md) | Context, index, memory |
| [COST_ENGINE](docs/COST_ENGINE.md) | Metrics, budgets, benchmark method |
| [PERSISTENCE](docs/PERSISTENCE.md) | Schema, recovery, migrations |
| [SECURITY](SECURITY.md) · [TESTING](docs/TESTING.md) | Threat model; test strategy |
| [TECHNICAL_DECISIONS](docs/TECHNICAL_DECISIONS.md) · [RISK_REGISTER](docs/RISK_REGISTER.md) · [KNOWN_ISSUES](KNOWN_ISSUES.md) | ADRs, risks, limitations |
| [ROADMAP](ROADMAP.md) · [CHANGELOG](CHANGELOG.md) · [CONTRIBUTING](CONTRIBUTING.md) | Project |

## Honest status

Version 0.1.0 is a functional MVP. [`PROGRESS.md`](PROGRESS.md) classifies every feature as implemented and verified, implemented but not fully verified, partial, planned, or blocked. Two limits matter in particular:

- Code parsing is heuristic: regex and line scanners, not Tree-sitter yet.
- Per-agent token usage is not exposed by Claude Code, so Kilamu reports it as UNAVAILABLE.

Kilamu does not claim percentage savings. The benchmark harness is described in [`docs/COST_ENGINE.md`](docs/COST_ENGINE.md).

## Development

```bash
npm install          # dev tooling only: typescript, vitest, @types/node
npm run typecheck
npm test
claude plugin validate .
```

See [CONTRIBUTING.md](CONTRIBUTING.md).
