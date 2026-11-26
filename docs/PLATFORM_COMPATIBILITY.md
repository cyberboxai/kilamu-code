# Platform Compatibility

| Requirement | Version | Verified |
|---|---|---|
| Claude Code | 2.1.x (developed and tested on 2.1.332) | `claude plugin validate .` passes. `claude --plugin-dir` reports "✔ loaded". A live headless session confirmed SessionStart context injection and `kilamu` on the Bash PATH. |
| Node.js | ≥ 22.18. Needed for native type stripping and unflagged `node:sqlite` with FTS5. | Tested on 22.23.2. The launcher refuses to run on older versions. |
| OS | Linux (tested). macOS should work (POSIX `sh` launcher, `readlink -f` has a fallback). Windows: WSL only. | Linux only |
| git | Optional. Used for checkpoints, reconciliation and fast file listing. | 2.43 |
| pdftotext (poppler) | Optional. Used for PDF indexing. | Present |

## Claude Code capabilities used

| Capability | Status | Required? | Without it |
|---|---|---|---|
| Plugin skills, agents, hooks, `bin/` | Stable | Yes | — |
| Agent Teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) | Experimental | No | TEAM plans fall back to SUBAGENT. The fallback is shown as a constraint in `kilamu plan create`. |
| TaskCompleted hook | Teams only | No | The lead runs `kilamu verify` explicitly. |
| Statusline | Stable | No | Usage reported as UNAVAILABLE |
| `-p` / headless mode | Stable | — | Teams do not form in `-p` mode (a documented platform limit). Kilamu falls back as above. |

## Experimental features: Kilamu never enables them for you
To opt in to Agent Teams, add this to your own Claude Code settings:
```json
{ "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }
```
`kilamu doctor` reports whether the flag is set and where it comes from: the environment, user settings or project settings.
