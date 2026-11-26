---
name: resume
description: Continue an interrupted or previous Kilamu Code execution from durable state — "continue the previous implementation", "resume", "where were we". Reconciles interrupted tasks, verifies work already on disk, and only re-runs what is still needed.
---
# Kilamu Code — Resume

1. `kilamu status` — shows the active execution, task states and any reconciliation done at session start. `kilamu recover` reconciles manually if the session-start hook did not run. Tasks still RUNNING under another session are left alone (that session may be live); if you know it is gone, `kilamu recover --force`.
2. For every task flagged **verify first** (its owned files changed before the interruption): `kilamu task submit <id> --summary "recovered after interruption"` then `kilamu verify <id>`. If it passes, it is done — do not redo it.
3. Tasks released with no file changes are safe to re-run: continue with the `orchestrate` skill from step 4 (`kilamu next --json`). Subagents and teammates from the old session no longer exist; spawn fresh ones from the briefs.
4. If git HEAD moved since the plan was made, re-check the plan's assumptions (`kilamu plan show`) before continuing; cancel with `kilamu execution cancel <id> --reason "…"` and re-plan if it no longer fits.
5. Tell the user in a few lines: what was already verified, what was recovered by verification, what remains.
