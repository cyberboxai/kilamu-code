/**
 * Shared contracts for Kilamu Code.
 *
 * OWNERSHIP: Lead engineer. Module authors consume these types; changes here
 * are integration decisions (see docs/TECHNICAL_DECISIONS.md).
 */

// ---------------------------------------------------------------------------
// Metric honesty labels (directive §3.6, §12.5)
// ---------------------------------------------------------------------------

/** Every reported number carries one of these labels. */
export type MetricLabel = 'MEASURED' | 'ESTIMATED' | 'UNAVAILABLE';

export interface LabeledValue<T = number> {
  value: T | null;
  label: MetricLabel;
  /** Where the value came from, e.g. "statusline:cost.total_cost_usd". */
  source: string;
}

// ---------------------------------------------------------------------------
// Execution & tasks (directive §8.2)
// ---------------------------------------------------------------------------

export type ExecutionMode = 'SINGLE' | 'SUBAGENT' | 'TEAM';

export type ExecutionStatus = 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type TaskStatus =
  | 'CREATED'
  | 'WAITING'
  | 'READY'
  | 'RUNNING'
  | 'VERIFYING'
  | 'VERIFIED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED';

/** Task classes drive model policy and tool selection (directive §12.1). */
export type TaskClass =
  | 'classification'
  | 'discovery'
  | 'summarization'
  | 'research'
  | 'implementation'
  | 'debugging'
  | 'architecture'
  | 'security'
  | 'verification';

export type Complexity = 'trivial' | 'small' | 'medium' | 'large';

export type ModelAlias = 'haiku' | 'sonnet' | 'opus' | 'fable' | 'inherit';

/** Specialist roles shipped as plugin agents (agents/*.md). */
export type AgentRole =
  | 'lead'
  | 'architect'
  | 'researcher'
  | 'developer'
  | 'database-engineer'
  | 'security-reviewer'
  | 'verifier';

export type AcceptanceCriterion =
  | { id: string; kind: 'command'; command: string; cwd?: string; timeoutSec?: number; description?: string }
  | { id: string; kind: 'file_exists'; path: string; description?: string }
  | { id: string; kind: 'file_contains'; path: string; pattern: string; regex?: boolean; description?: string }
  | { id: string; kind: 'artifact'; description?: string }
  | { id: string; kind: 'attestation'; description: string };

export interface TaskBudget {
  /** Estimated token ceiling for this task's agent work. */
  maxTokens: number;
}

export interface TaskSpec {
  /** Stable, plan-unique identifier, e.g. "T1" or "auth-schema". */
  id: string;
  title: string;
  description: string;
  role: AgentRole;
  taskClass: TaskClass;
  complexity: Complexity;
  priority: number; // 1 (highest) .. 5
  dependsOn: string[];
  /** Files this task may modify. Used for ownership/conflict control. */
  files: string[];
  /** Read-only inputs: file paths, artifact ids ("artifact:<id>"), task outputs ("task:<id>"). */
  inputs: string[];
  expectedOutput: string;
  acceptance: AcceptanceCriterion[];
  maxRetries: number;
  budget?: TaskBudget;
}

export interface PlanSpec {
  objective: string;
  tasks: TaskSpec[];
  /** Optional: execution-wide budget in estimated tokens. */
  budgetTokens?: number;
}

export interface TaskRecord extends TaskSpec {
  executionId: string;
  status: TaskStatus;
  owner: string | null;
  attempts: number;
  checkpointId: string | null;
  resultSummary: string | null;
  outputArtifacts: string[];
  createdAt: string;
  updatedAt: string;
  /** Claude Code session that started the current attempt (recovery scoping). */
  sessionId?: string | null;
  /** Set by reconciliation: work may already be on disk — verify before re-running. */
  verifyFirst?: boolean;
}

export interface ExecutionRecord {
  id: string;
  objective: string;
  status: ExecutionStatus;
  mode: ExecutionMode;
  modeRationale: ModeDecision;
  budgetTokens: number;
  createdAt: string;
  updatedAt: string;
  sessionId: string | null;
  baseCommit: string | null;
}

export interface ModeFactor {
  name: string;
  value: number | string | boolean;
  effect: string;
}

export interface ModeDecision {
  mode: ExecutionMode;
  teamSize: number;
  reasons: string[];
  factors: ModeFactor[];
  /** Capability constraints that changed the decision, e.g. teams unavailable. */
  constraints: string[];
}

// ---------------------------------------------------------------------------
// Verification (directive §14)
// ---------------------------------------------------------------------------

export type CheckStatus = 'PASS' | 'FAIL' | 'ERROR' | 'SKIPPED' | 'ATTESTED';

export interface CheckResult {
  criterionId: string;
  kind: AcceptanceCriterion['kind'];
  status: CheckStatus;
  /** Human-readable reason, mandatory for SKIPPED/ERROR. */
  detail: string;
  command?: string;
  exitCode?: number | null;
  durationMs?: number;
  artifactId?: string;
}

export interface VerificationReport {
  executionId: string;
  taskId: string;
  results: CheckResult[];
  /** VERIFIED only if every criterion is PASS or ATTESTED and at least one is PASS or there are only artifact/attestation criteria with evidence. */
  verdict: 'VERIFIED' | 'FAILED';
  runId: string;
}

// ---------------------------------------------------------------------------
// Artifacts & context (directive §9)
// ---------------------------------------------------------------------------

export interface ArtifactRef {
  id: string;
  kind: 'command-output' | 'log' | 'file-snapshot' | 'report' | 'handoff' | 'context-pack' | 'other';
  bytes: number;
  lines: number;
  source: string;
  createdAt: string;
}

export interface CompressedSummary {
  artifactId: string;
  source: string;
  totalLines: number;
  totalBytes: number;
  detectedFormat: string;
  status: 'success' | 'failure' | 'unknown';
  /** Key findings, each with optional line range in the artifact. */
  findings: Array<{ text: string; lineStart?: number; lineEnd?: number }>;
  /** e.g. "kilamu artifact show <id> --lines 120-180" */
  retrieval: string;
  estimatedTokensSaved: LabeledValue;
}

export interface ContextItem {
  kind: 'file' | 'symbol' | 'snippet' | 'memory' | 'artifact' | 'doc';
  ref: string; // path, path#symbol, memory id, artifact id
  lineStart?: number;
  lineEnd?: number;
  reason: string;
  score: number;
  estimatedTokens: number;
  content?: string;
}

export interface ContextPack {
  query: string;
  budgetTokens: number;
  usedTokens: LabeledValue;
  items: ContextItem[];
  omitted: Array<{ ref: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Knowledge graph (directive §10)
// ---------------------------------------------------------------------------

export type EdgeRelation =
  | 'IMPORTS'
  | 'CALLS'
  | 'EXTENDS'
  | 'IMPLEMENTS'
  | 'READS'
  | 'WRITES'
  | 'DEPENDS_ON'
  | 'REFERENCES'
  | 'DEFINES'
  | 'CONNECTS_TO'
  | 'MIGRATES_TO'
  | 'DOCUMENTS';

/**
 * Node references are typed strings:
 *   file:<relpath>  symbol:<relpath>#<name>  table:<name>  column:<table>.<col>
 *   module:<specifier>  endpoint:<METHOD> <path>  doc:<relpath>  config:<relpath>#<key>
 */
export type NodeRef = string;

export interface GraphEdge {
  src: NodeRef;
  rel: EdgeRelation;
  dst: NodeRef;
  path: string; // file where the relationship was observed
  line: number;
  /** 0..1 — heuristic extractors must report < 1. */
  confidence: number;
}

export interface SymbolRecord {
  path: string;
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'method' | 'table' | 'column' | 'endpoint' | 'heading' | 'key' | 'other';
  lineStart: number;
  lineEnd: number;
  signature: string;
  exported: boolean;
}

export interface SearchHit {
  path: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  score: number;
}

/** Read-only query surface the context engine depends on (implemented by knowledge/). */
export interface KnowledgeQuery {
  search(query: string, limit?: number): SearchHit[];
  findSymbols(name: string, limit?: number): SymbolRecord[];
  neighbors(ref: NodeRef, direction: 'in' | 'out' | 'both', limit?: number): GraphEdge[];
  fileInfo(path: string): { path: string; sha256: string; size: number; language: string } | null;
}

// ---------------------------------------------------------------------------
// Memory (directive §11)
// ---------------------------------------------------------------------------

export type MemoryCategory = 'project' | 'execution' | 'pattern' | 'technical';
export type MemoryValidation = 'UNVERIFIED' | 'VERIFIED' | 'STALE' | 'INVALIDATED';

export interface MemorySourceRef {
  path: string;
  /** sha256 of the file when the memory was created; drives invalidation. */
  sha256: string | null;
  lineStart?: number;
  lineEnd?: number;
}

export interface MemoryItem {
  id: string;
  category: MemoryCategory;
  scope: string; // "global" | module path | execution id
  description: string;
  problem: string;
  solution: string;
  evidence: string[]; // verification run ids, artifact ids, commands
  sources: MemorySourceRef[];
  confidence: number; // 0..1
  validation: MemoryValidation;
  invalidationConditions: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Usage & cost (directive §12)
// ---------------------------------------------------------------------------

export interface UsageSample {
  sessionId: string;
  source: 'statusline' | 'estimate' | 'manual';
  label: MetricLabel;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  contextUsedPct: number | null;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Capabilities (directive §6.1)
// ---------------------------------------------------------------------------

export interface CapabilityReport {
  claudeCodeVersion: string | null;
  nodeVersion: string;
  nodeSupported: boolean;
  sqliteAvailable: boolean;
  fts5Available: boolean;
  agentTeams: { available: boolean; source: string; note: string };
  git: boolean;
  pdftotext: boolean;
  platform: string;
}

// ---------------------------------------------------------------------------
// Narrow cross-module interfaces (dependency inversion between subsystems)
// ---------------------------------------------------------------------------

/** Minimal artifact-writing surface (implemented by context/artifacts.ts). */
export interface ArtifactSink {
  put(content: string, meta: { kind: ArtifactRef['kind']; source: string; executionId?: string; taskId?: string }): ArtifactRef;
}

/** Everything the statusline HUD renders. Built by observability/hud-state, rendered by observability/statusline. */
export interface HudState {
  execution: null | {
    id: string;
    objective: string;
    status: ExecutionStatus;
    mode: ExecutionMode;
    teamSize: number;
    /** VERIFIED tasks / total tasks, 0..100. */
    progressPct: number;
    counts: Partial<Record<TaskStatus, number>>;
    total: number;
    running: Array<{ taskId: string; role: AgentRole; title: string }>;
    next: string | null;
    blockers: string[];
    lastVerified: string | null;
    budgetTokens: number;
  };
  usage: {
    model: string | null;
    tokens: LabeledValue;
    costUsd: LabeledValue;
    contextPct: LabeledValue;
    durationMs: LabeledValue;
    cacheHitRatio: LabeledValue;
  };
  /** Share of execution token budget left, from MEASURED session tokens since execution start. */
  budgetRemainingPct: LabeledValue;
}
