# Persistent Memory

## Categories
| Category | Holds | Promotion |
|---|---|---|
| project | Architecture, conventions, constraints, decisions | — |
| execution | Results, failures and artifacts from past tasks | Can be promoted to `pattern` |
| technical | Verified framework behaviour and techniques | Can be promoted to `pattern` |
| pattern | Reusable solutions | Only via `promote`: VERIFIED, confidence ≥ 0.8, evidence ≥ 2 |

## Item fields
id, category, scope, description, problem, solution, evidence[], sources[] (path plus the sha256 at creation and an optional line range), confidence, validation, invalidationConditions[], createdAt, updatedAt.

## Lifecycle
```
add → UNVERIFIED ──validate(evidence)──► VERIFIED ──promote──► pattern
            │                               │
            └──── sources changed (memory check / import) ──► STALE
any ── invalidate(reason) ──► INVALIDATED
```
- `kilamu memory check` recomputes source hashes. Any item with a changed or missing source becomes STALE, and the reason is recorded in `invalidationConditions`.
- `relevant()`, which context packs use, excludes STALE and INVALIDATED items and ranks VERIFIED items first.

## Safety
- Kilamu rejects any memory text that contains a secret.
- It rejects sources that are sensitive paths or that escape the project.
- Text fields are capped. Text over the cap is rejected, never truncated, to discourage transcript dumping.
- No personal data or conversation transcripts are stored.

## Sharing
`kilamu memory export [--dir]` writes human-readable `<category>.md` files. By default they go to `.kilamu/memory/`, which is not committed. You can move them into your docs if you choose to share them. `kilamu export` and `kilamu import` move memory between machines as JSON. Imports are re-validated, and an import is all-or-nothing.
