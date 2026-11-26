# Knowledge Graph

## Data model
- **Nodes** are typed string refs:

  | Ref | Meaning |
  |---|---|
  | `file:<path>` | A file |
  | `symbol:<path>#<name>` | A symbol defined in a file |
  | `table:<name>` | A database table |
  | `column:<table>.<col>` | A table column |
  | `module:<specifier>` | An imported module |
  | `endpoint:<METHOD> <path>` | An HTTP endpoint |
  | `doc:<path>` | A document |
  | `config:<path>#<key>` | A config key |

- **Edges** are `(src, rel, dst, path, line, confidence)`. The relations are IMPORTS, CALLS, EXTENDS, IMPLEMENTS, READS, WRITES, DEPENDS_ON, REFERENCES, DEFINES, CONNECTS_TO, MIGRATES_TO and DOCUMENTS.
- **Symbols** are `(path, name, kind, line range, signature, exported)`.
- **Full-text** search uses FTS5 over ~40-line chunks with a 5-line overlap. The path is indexed. All text is redacted before insert.

## Parsers (0.1.0: heuristic; see `kilamu coverage`)
| Family | Extracts | Confidence class |
|---|---|---|
| TS/JS/TSX/JSX | functions, classes, interfaces, types, exported consts, methods, imports/require (resolved to files), extends/implements, Express/Koa routes | structural-heuristic |
| Python | def/class, bases, imports (resolved), FastAPI/Flask/Django routes, Django/SQLAlchemy columns | structural-heuristic |
| Go, Rust, Java/Kotlin, C/C++, C# | top-level types, functions, imports | structural-heuristic |
| SQL | CREATE TABLE/columns, FOREIGN KEY/REFERENCES, ALTER TABLE ADD COLUMN (MIGRATES_TO), CREATE INDEX/VIEW | structural-heuristic |
| Markdown/rst/txt | headings, links to repo files (DOCUMENTS) | structural-heuristic |
| JSON/YAML/TOML/Dockerfile/compose | top-level keys, dependencies (DEPENDS_ON), compose services (CONNECTS_TO) | structural-heuristic |
| PDF | text per page via `pdftotext`, page numbers kept | text-only |
| Others (Ruby, PHP, …) | full-text only | text-only |

Every heuristic edge has confidence < 1. **Kilamu does not claim semantic understanding.** Tree-sitter parsing is on the roadmap.

### Cross-layer linking
After the SQL pass, identifiers in code files are matched against known column names. Matching is snake-case-normalised, so `customerId` matches `customer_id`. Only names of at least 4 characters are considered, and a stoplist excludes generic names such as `name` and `status`. Each match yields `file REFERENCES column` at confidence 0.35.

## Incremental indexing
- Files come from `git ls-files -co --exclude-standard`. Without git, a walker applies IGNORED_DIRS and the root `.gitignore`.
- Sensitive files, symlinks, binaries, and files over 1 MB are always excluded.
- A file is reprocessed only when its sha256 or parser version changes. Rows for deleted files are removed.
- Writes are batched at 200 files per transaction.
- `kilamu index --rebuild` forces a full reindex. `--path <p>` limits indexing to the given paths.

## Impact tracing
`kilamu impact <term>` works in four steps:
1. Resolve seeds: columns named `*.term`, tables, symbols, and paths.
2. Run a bounded BFS over reverse edges, plus foreign-key targets. Each traversed edge's observing file is included.
3. Add FTS hits as evidence at confidence 0.2.
4. Group results by layer: database → model → repository → service → api → frontend → test → docs → config. Each entry carries its via-chain and its confidence.

A unit test runs this on `tests/fixtures/kg-customer-app`. It traces SQL column → ORM model → repository → service → FastAPI route → TSX component, in that order.

## Performance (measured by the module author on this machine)
2,000 synthetic files took 6.3 s to index the first time and 0.7 s incrementally (in-memory DB). With a file DB on a rotational disk under load, the first run took about 17 s, dominated by fsync during COMMIT. This repository (~136 files) indexes in about 1.1–2.9 s on a cold run.
