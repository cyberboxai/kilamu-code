# Platform Research — Claude Code integration surface

Researched 2026-11-25 against **Claude Code 2.1.332** on Linux, using the official docs at code.claude.com (plugins, plugins/manifest-reference, plugins/components, plugins/cli-reference, plugins/marketplace-reference, hooks, statusline, sub-agents, agent-teams, skills, costs, model-config, settings-reference). Where a statement says **UNCONFIRMED**, the docs did not settle it and Kilamu does not depend on it.

## Environment observed

| Item | Value |
|---|---|
| Claude Code | 2.1.332 |
| Node.js | 22.23.2: native TypeScript type stripping works with no flags; `node:sqlite` is available and reports SQLite 3.51.3 with FTS5 |
| npm | 12.0.2 |
| Agent Teams flag | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set in this environment |
| Optional tools | `git` 2.43, `pdftotext` (poppler) available; `rg` not on PATH |

## Findings that shape the design

### Plugins
- The manifest is `.claude-plugin/plugin.json`. Only `name` is required. `author` is `{name, email?, url?}`.
- These directories are auto-discovered: `skills/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `bin/`, and others.
- **Files in `bin/` are on the Bash tool's `PATH`** while the plugin is enabled. They come after the user's own entries, so a plugin cannot shadow `git` and similar tools. → Skills and agents call `kilamu` as a bare command.
- `${CLAUDE_PLUGIN_ROOT}` is substituted in hook commands and in skill and agent bodies.
- `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`) exists. Kilamu deliberately keeps per-project state in `<project>/.kilamu/` instead: state follows the project, is inspectable, and is removed with it.
- Plugin env variables are **not** exported to Bash-tool commands. Hooks receive `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CLAUDE_PROJECT_DIR`.
- Validation command: `claude plugin validate <path> [--strict] [--json]`. Local loading: `claude --plugin-dir <path>`.
- Marketplace file: `.claude-plugin/marketplace.json` with `{name, owner{name}, plugins[{name, source:"./"}]}`.
- **A plugin cannot set `statusLine`** (UNCONFIRMED in the docs, so treated as unsupported). The HUD is installed into user or project settings by an explicit, reversible command.

### Hooks used by Kilamu
| Event | Fields used | Output used |
|---|---|---|
| SessionStart | `source` (startup / resume / clear / compact / fork), `session_id` | `hookSpecificOutput.additionalContext`, which carries the orientation |
| PreCompact | `trigger` | plain stdout on exit 0 **becomes compaction-summary instructions** (capped at 10,000 chars) |
| TaskCompleted (Agent Teams) | `task_subject`, `task_id`, `teammate_name` | exit 2 plus stderr keeps the task open. This is the verification gate |
| PostToolUse (Bash, opt-in) | `tool_input`, `tool_response` | `hookSpecificOutput.updatedToolOutput` / `additionalContext` |

Exit codes: 0 means success; 2 is a blocking error on events that can block; any other code is a non-blocking error. Default command-hook timeout is 600 s; Kilamu sets 15–20 s.

### Subagents
- Frontmatter fields: `name`, `description`, `tools`, `disallowedTools`, `model` (`haiku|sonnet|opus|fable|inherit|<id>`), `effort`, `isolation: worktree`, `color`, `maxTurns`, and others.
- **Plugin agents ignore `hooks`, `mcpServers` and `permissionMode`.** Kilamu agents therefore cannot escalate permissions.
- Model resolution order: Agent-tool `model` parameter → frontmatter `model` → `CLAUDE_CODE_SUBAGENT_MODEL` → main model. → **Kilamu routes models by passing the per-invocation `model` parameter**, so no settings change is needed.

### Agent Teams (experimental)
- Opt-in through `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, set in the environment or in the settings `env` block. Kilamu never sets it.
- Teammates are spawned through the Agent tool with a `name`. A teammate can use a plugin agent type, which supplies its tools, model and body; `skills` are not applied to teammates.
- The team has a shared task list (pending / in-progress / completed, with dependencies) and uses `SendMessage`.
- Documented limitations:
  - No session resumption for in-process teammates.
  - One team per session.
  - No nested teams.
  - The lead is fixed.
  - No per-teammate permission mode.
  - Teams do not form in `-p` (non-interactive) mode.
  - Every teammate is a full Claude instance; 3–5 teammates is the recommended size.
- → Kilamu keeps **its own** task state and never reads `~/.claude/teams/**` (an internal mailbox format). Recovery assumes teammates are gone after a restart.

### Statusline
- The statusline script receives JSON on stdin. Fields: `session_id`, `model{id, display_name}`, `cost{total_cost_usd, total_duration_ms, …}`, `context_window{total_input_tokens, total_output_tokens, used_percentage, current_usage{…cache…}}`, `prompt_cache{hit_ratio, …}`, `rate_limits` (subscribers only), and `version`.
- It runs on each assistant message, debounced at 300 ms. An in-flight run is cancelled when a new one starts. → The renderer must be fast and do no model calls or indexing.
- `cost.total_cost_usd` is computed client-side at list price; on subscription plans it is not the bill.

### Usage and costs
- Officially exposed to scripts: the statusline fields listed above, plus `/usage` and `/cost`, which are interactive and not machine-readable. OpenTelemetry export exists; its metric names are UNCONFIRMED here.
- **The transcript JSONL schema is undocumented.** Kilamu does not parse transcripts.
- **Per-subagent token usage is not exposed** to plugins. Kilamu reports it as UNAVAILABLE.

### Models
Aliases: `default`, `best`, `fable`, `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan` (`opusplan` is for the main session only). The main-session model is the user's choice; Kilamu never changes it.

## Compatibility matrix

| Capability | Status in 2.1.332 | Kilamu usage | Fallback |
|---|---|---|---|
| Plugin skills/agents/hooks | Stable | Core surface | — |
| Plugin `bin/` on PATH | Documented | `kilamu` CLI | `"${CLAUDE_PLUGIN_ROOT}/bin/kilamu"` |
| Agent Teams | Experimental, opt-in | TEAM mode | SUBAGENT mode (automatic, recorded as a constraint) |
| TaskCompleted hook | Documented (teams) | Verification gate | Lead runs `kilamu verify` |
| PreCompact stdout → instructions | Documented | Preserve execution state | SessionStart(compact) orientation |
| PostToolUse `updatedToolOutput` for Bash | Documented field; behaviour not exercised live | Opt-in compression | Agents pipe through `kilamu compress` |
| Statusline from plugin | Not supported | Explicit `kilamu statusline install` | Manual snippet |
| Per-agent usage | Not exposed | Reported as UNAVAILABLE | — |
| Node type stripping | Node ≥ 22.18 | Runs `.ts` without a build | `bin/kilamu` refuses to run on older Node, with a clear message |

## Lessons from open-source orchestration layers
Lessons drawn from systems inspected for this design, including oh-my-claudecode, which is installed in this environment:
- Prompt-only orchestration drifts. Durable, machine-checked state is what makes resumption reliable.
- Spawning many agents by default inflates cost without improving quality. Mode selection must be justified per plan.
- "Agent says done" is the most common false-completion path. A deterministic verification gate is required.
