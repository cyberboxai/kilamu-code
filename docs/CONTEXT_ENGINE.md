# Context Engine

Goal: give each agent **the right information, not the most information** (directive §9).

## Hierarchy (§9.1)
| Level | Where it lives | How agents get it |
|---|---|---|
| Global | `kilamu index` (files, symbols, graph), `project` memory, docs | `kilamu context`, `kilamu memory search` |
| Module | Symbols and edges per file; layer classification | `kilamu impact`, `kilamu symbols` |
| Task | The task's owned files, inputs and acceptance criteria | `kilamu context "<task>" --task <id>` seeds retrieval from the task |
| Agent | Dispatch brief (`src/orchestrator/brief.ts`): role, responsibility, files, inputs, expected output, protocol | `kilamu next` / `kilamu brief <id>` |

## Retrieval (`src/context/pack.ts`)
Retrieval is deterministic and needs no vector store. Candidates are scored as follows:

| Signal | Score |
|---|---|
| Explicit seeds | 1.0 |
| Symbol-name matches for identifier-like tokens | 0.9 |
| FTS5 hits aggregated per file | 0.8 → 0.4 by rank |
| VERIFIED or UNVERIFIED memory | 0.6 |
| One-hop graph neighbours | 0.5 → 0.3 |

FTS ranking (`src/knowledge/query.ts`):
- English stopwords are dropped and the remaining terms are OR'd.
- Porter stemming applies.
- Chunks are scored with bm25, and the path column carries weight 3.
- Results are reranked to boost paths that name a query term and to down-weight prose by 0.75.

Selection fills the token budget greedily (ESTIMATED as chars/4). Items that do not fit are listed under `omitted`. With `--content`, only the relevant line ranges are included: the symbol range, the hit ±5 lines, or at most 120 lines of a seed. Content is never a whole large file.

Every content block is redacted and wrapped in a `<<<KILAMU-UNTRUSTED …>>>` fence. Lines that look like injected instructions are flagged.

## Compression (`src/context/compress.ts`)
Large outputs are piped in with `<cmd> 2>&1 | kilamu compress --source "<cmd>"`, or through the opt-in PostToolUse hook. Compression works in four steps:
1. The output is redacted and stored in full as a content-addressed artifact.
2. The format is detected: vitest/jest, pytest, go test, cargo, tsc, eslint, npm, Python traceback, or generic.
3. Up to 25 findings are extracted, with line ranges in the stored artifact. Repeated lines are collapsed (×N).
4. A summary is returned with the artifact id and `kilamu artifact show <id> --lines A-B` retrieval instructions.

**Nothing is discarded.** The full text is always available.

## Artifacts (`src/context/artifacts.ts`)
- Ids are `a_<16 hex of sha256>`. Identical content deduplicates to the same id.
- Files are stored under `.kilamu/artifacts/<xx>/<id>.txt` with mode 0600, using atomic writes.
- Artifacts can be read by line range.
- Artifacts are pruned by age with `kilamu cleanup`.

## Duplicate-read tracking (`src/context/dedup.ts`)
`ReadTracker` records `(session, path, sha256)` reads. It can report whether a file was already read with the same content. In 0.1.0 it is a library API used by future hooks. No hook calls it yet; see KNOWN_ISSUES.

## Measured locally
Measured with `npm run bench` on this repository. The numbers are ESTIMATED token counts, so the comparison is relative. See `docs/COST_ENGINE.md` for the results.
