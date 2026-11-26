---
name: setup
description: First-run setup and diagnostics for Kilamu Code — checks Node, SQLite/FTS5, Claude Code, agent-team availability and git; initializes local storage; optionally installs the statusline HUD. Use for "set up kilamu", "kilamu doctor", or when a kilamu command fails.
disable-model-invocation: true
---
# Kilamu Code — Setup & diagnostics

1. `kilamu doctor` — reports capabilities: Node ≥ 22.18, node:sqlite + FTS5, Claude Code version, git, pdftotext (optional, for PDF indexing), and whether Agent Teams are enabled. Nothing is changed.
2. `kilamu init --dry-run` shows what would be created; `kilamu init` creates `.kilamu/` (with its own `.gitignore`, so nothing in it gets committed). The project's own files and settings are never modified.
3. Agent Teams are experimental and off by default. Kilamu works without them (it falls back to subagents). To opt in, the user adds `"env": {"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"}` to their Claude Code settings themselves — do not edit settings on their behalf unless they explicitly ask.
4. Optional HUD: `kilamu statusline install --scope project --dry-run` shows the change; without `--dry-run` it writes `statusLine` to `.claude/settings.local.json`, refusing to replace an existing statusline unless `--force` is given (a backup is kept; `kilamu statusline uninstall` restores it). Ask the user before running it.
5. `kilamu index` builds the first index.
