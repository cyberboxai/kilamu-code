import { nowIso } from '../core/ids.ts';
import { redact } from '../core/redact.ts';
import { parseJson, type Db } from '../persistence/db.ts';

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface EventContext {
  executionId?: string;
  taskId?: string;
  level?: EventLevel;
}

export interface EventRow {
  id: number;
  at: string;
  level: string;
  type: string;
  executionId: string | null;
  taskId: string | null;
  data: unknown;
}

interface RawRow {
  id: number;
  at: string;
  level: string;
  type: string;
  execution_id: string | null;
  task_id: string | null;
  data_json: string;
}

export class EventLog {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Append an event. The data payload is secret-redacted before it is stored. */
  emit(type: string, data: unknown, ctx: EventContext = {}): void {
    const json = redact(JSON.stringify(data ?? {})).text;
    this.db
      .prepare('INSERT INTO events(at, level, type, execution_id, task_id, data_json) VALUES(?,?,?,?,?,?)')
      .run(nowIso(), ctx.level ?? 'info', type, ctx.executionId ?? null, ctx.taskId ?? null, json);
  }

  /** Most recent events, returned oldest-first. */
  tail(opts: { executionId?: string; limit: number }): EventRow[] {
    const limit = Math.max(1, Math.floor(opts.limit));
    const rows = (opts.executionId
      ? this.db.prepare('SELECT * FROM events WHERE execution_id = ? ORDER BY id DESC LIMIT ?').all(opts.executionId, limit)
      : this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)) as unknown as RawRow[];
    return rows.reverse().map((r) => ({
      id: r.id,
      at: r.at,
      level: r.level,
      type: r.type,
      executionId: r.execution_id,
      taskId: r.task_id,
      data: parseJson<unknown>(r.data_json, {}),
    }));
  }
}
