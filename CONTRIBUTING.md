# Contributing to Kilamu Code

## Setup
```bash
git clone <repo> && cd kilamu-code
npm install            # dev tooling only (typescript, vitest, @types/node)
npm run check          # typecheck + all tests
claude plugin validate .
claude --plugin-dir .  # load locally in Claude Code
```
You need Node ≥ 22.18. Sources run directly through Node's type stripping, so there is no build step.

## Code standards
- **Erasable TypeScript only.** No `enum`, `namespace` or constructor parameter properties. Relative imports end in `.ts`. `tsc` with `erasableSyntaxOnly` enforces this.
- **Zero runtime dependencies.** A new dependency needs a written justification covering need, maintenance and security, recorded as an ADR in `docs/TECHNICAL_DECISIONS.md`.
- **Module boundaries.** A module touches only the tables it owns (listed in `src/persistence/migrations.ts`). Cross-module needs go through the narrow interfaces in `src/core/types.ts`. Changing a shared contract counts as an ADR-level change.
- **Errors.** Throw `KilamuError(code, message)` with an actionable message. Do not swallow errors. The exceptions are hooks and the statusline, which must never break a session.
- **Honesty.** Every metric carries a MEASURED, ESTIMATED or UNAVAILABLE label. Do not invent numbers.
- **Migrations are append-only.** Never edit a released migration. Add a new version instead.

## Tests
Use vitest. New logic ships with tests that cover the happy path and the key failure and edge cases. Tests use temporary directories and never touch the repository's own `.kilamu/`. Do not use `.skip`, `.only` or placeholder assertions.

## Commits
Use Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`), imperative and scoped. Never commit `.kilamu/`, `.env` files or secrets.
