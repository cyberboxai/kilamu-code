/**
 * Versioned schema migrations. Append-only: never edit a released migration.
 *
 * TABLE OWNERSHIP (directive §7: subsystems must not mutate each other's state):
 *   meta, events                        → persistence / observability
 *   executions, tasks, task_events,
 *   checkpoints, execution_sessions,
 *   session_ends                         → execution
 *   verification_runs                    → verification
 *   artifacts                            → context
 *   files, symbols, edges, chunks_fts    → knowledge
 *   memory_items                         → memory
 *   usage_samples                        → cost
 *   file_reads, tool_cache               → context (dedup) / tools
 * Other modules read through the owning module's API.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    sql: `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  type TEXT NOT NULL,
  execution_id TEXT,
  task_id TEXT,
  data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_exec ON events(execution_id, id);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','COMPLETED','FAILED','CANCELLED')),
  mode TEXT NOT NULL CHECK (mode IN ('SINGLE','SUBAGENT','TEAM')),
  mode_rationale_json TEXT NOT NULL,
  budget_tokens INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  session_id TEXT,
  base_commit TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_exec_status ON executions(status, updated_at);

CREATE TABLE tasks (
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  role TEXT NOT NULL,
  task_class TEXT NOT NULL,
  complexity TEXT NOT NULL,
  priority INTEGER NOT NULL,
  status TEXT NOT NULL,
  owner TEXT,
  depends_on_json TEXT NOT NULL,
  files_json TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  expected_output TEXT NOT NULL,
  acceptance_json TEXT NOT NULL,
  max_retries INTEGER NOT NULL,
  budget_tokens INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  checkpoint_id TEXT,
  result_summary TEXT,
  output_artifacts_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, id)
);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX idx_task_events ON task_events(execution_id, task_id, id);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  git_head TEXT,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_checkpoints ON checkpoints(execution_id, created_at);

CREATE TABLE verification_runs (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('VERIFIED','FAILED')),
  results_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_verif ON verification_runs(execution_id, task_id, created_at);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  lines INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  summary_json TEXT,
  execution_id TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_sha ON artifacts(sha256);

CREATE TABLE files (
  path TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  language TEXT NOT NULL,
  parser TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('INDEXED','SKIPPED','ERROR')),
  detail TEXT,
  indexed_at TEXT NOT NULL
);

CREATE TABLE symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  signature TEXT NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_symbols_name ON symbols(name COLLATE NOCASE);
CREATE INDEX idx_symbols_path ON symbols(path);

CREATE TABLE edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src TEXT NOT NULL,
  rel TEXT NOT NULL,
  dst TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  confidence REAL NOT NULL
);
CREATE INDEX idx_edges_src ON edges(src);
CREATE INDEX idx_edges_dst ON edges(dst);
CREATE INDEX idx_edges_path ON edges(path);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  path,
  line_start UNINDEXED,
  line_end UNINDEXED,
  content,
  tokenize = 'porter unicode61 remove_diacritics 2 tokenchars ''_'''
);

CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('project','execution','pattern','technical')),
  scope TEXT NOT NULL,
  description TEXT NOT NULL,
  problem TEXT NOT NULL,
  solution TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  validation TEXT NOT NULL CHECK (validation IN ('UNVERIFIED','VERIFIED','STALE','INVALIDATED')),
  invalidation_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_memory_cat ON memory_items(category, validation);

CREATE TABLE usage_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('MEASURED','ESTIMATED','UNAVAILABLE')),
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  context_used_pct REAL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX idx_usage_session ON usage_samples(session_id, id);

CREATE TABLE file_reads (
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (session_id, path)
);

CREATE TABLE tool_cache (
  key TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'execution-integrity',
    // Review fixes: tasks are bound to the session that started them (recovery
    // must not release live work of another session), reconciled work is
    // flagged verify-first, unblocks are capped, and verification runs are
    // bound to the attempt (checkpoint) they verified.
    sql: `
ALTER TABLE tasks ADD COLUMN session_id TEXT;
ALTER TABLE tasks ADD COLUMN verify_first INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN unblocks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE verification_runs ADD COLUMN checkpoint_id TEXT;

CREATE TABLE execution_sessions (
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  PRIMARY KEY (execution_id, session_id)
);

CREATE TABLE session_ends (
  session_id TEXT PRIMARY KEY,
  ended_at TEXT NOT NULL,
  reason TEXT
);
`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
