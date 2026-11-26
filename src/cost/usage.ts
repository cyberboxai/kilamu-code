import { nowIso } from '../core/ids.ts';
import type { Db } from '../persistence/db.ts';
import type { UsageSample } from '../core/types.ts';

const THROTTLE_MS = 5_000;

interface UsageRow {
  session_id: string;
  source: string;
  label: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  context_used_pct: number | null;
  recorded_at: string;
}

export interface UsageDelta {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  samples: number;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function toSample(r: UsageRow): UsageSample {
  return {
    sessionId: r.session_id,
    source: r.source as UsageSample['source'],
    label: r.label as UsageSample['label'],
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    costUsd: r.cost_usd,
    durationMs: r.duration_ms,
    contextUsedPct: r.context_used_pct,
    recordedAt: r.recorded_at,
  };
}

/** Parse a Claude Code statusline payload. Every field is optional; absent fields stay null. */
export function parsePayload(payload: unknown): UsageSample | null {
  const p = obj(payload);
  const sessionId = str(p.session_id);
  if (!sessionId) return null;
  const model = obj(p.model);
  const cost = obj(p.cost);
  const ctx = obj(p.context_window);
  const current = obj(ctx.current_usage);
  return {
    sessionId,
    source: 'statusline',
    label: 'MEASURED',
    model: str(model.id) ?? str(model.display_name),
    inputTokens: int(ctx.total_input_tokens),
    outputTokens: int(ctx.total_output_tokens),
    cacheReadTokens: int(current.cache_read_input_tokens),
    cacheWriteTokens: int(current.cache_creation_input_tokens),
    costUsd: num(cost.total_cost_usd),
    durationMs: int(cost.total_duration_ms),
    contextUsedPct: num(ctx.used_percentage),
    recordedAt: nowIso(),
  };
}

export class UsageStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Record a statusline payload. Returns the stored (or throttled-to latest) sample; null if unusable. */
  recordStatusline(payload: unknown): UsageSample | null {
    const sample = parsePayload(payload);
    if (!sample) return null;
    const last = this.latest(sample.sessionId);
    if (
      last &&
      Date.now() - Date.parse(last.recordedAt) < THROTTLE_MS &&
      last.inputTokens === sample.inputTokens &&
      last.outputTokens === sample.outputTokens
    ) {
      return last;
    }
    this.db
      .prepare(
        `INSERT INTO usage_samples(session_id, source, label, model, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, cost_usd, duration_ms, context_used_pct, recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        sample.sessionId, sample.source, sample.label, sample.model, sample.inputTokens, sample.outputTokens,
        sample.cacheReadTokens, sample.cacheWriteTokens, sample.costUsd, sample.durationMs, sample.contextUsedPct, sample.recordedAt,
      );
    return sample;
  }

  latest(sessionId: string): UsageSample | null {
    const r = this.db.prepare('SELECT * FROM usage_samples WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId) as UsageRow | undefined;
    return r ? toSample(r) : null;
  }

  first(sessionId: string): UsageSample | null {
    const r = this.db.prepare('SELECT * FROM usage_samples WHERE session_id = ? ORDER BY id ASC LIMIT 1').get(sessionId) as UsageRow | undefined;
    return r ? toSample(r) : null;
  }

  /** Token and cost deltas between the first sample at/after `isoTime` and the latest sample. Null if none. */
  deltaSince(sessionId: string, isoTime: string): UsageDelta | null {
    const base = this.db
      .prepare('SELECT * FROM usage_samples WHERE session_id = ? AND recorded_at >= ? ORDER BY id ASC LIMIT 1')
      .get(sessionId, isoTime) as UsageRow | undefined;
    const last = this.latest(sessionId);
    if (!base || !last) return null;
    const count = this.db
      .prepare('SELECT COUNT(*) AS n FROM usage_samples WHERE session_id = ? AND recorded_at >= ?')
      .get(sessionId, isoTime) as { n: number };
    const diff = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : Math.max(0, a - b));
    return {
      inputTokens: diff(last.inputTokens, base.input_tokens),
      outputTokens: diff(last.outputTokens, base.output_tokens),
      costUsd: diff(last.costUsd, base.cost_usd),
      samples: count.n,
    };
  }

  /** Keep only the newest `maxRowsPerSession` rows per session. Returns rows deleted. */
  prune(maxRowsPerSession: number): number {
    const r = this.db
      .prepare(
        `DELETE FROM usage_samples WHERE id IN (
           SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) AS rn FROM usage_samples)
           WHERE rn > ?)`,
      )
      .run(Math.max(1, Math.floor(maxRowsPerSession)));
    return Number(r.changes);
  }
}
