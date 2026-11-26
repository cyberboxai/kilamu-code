import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/core/config.ts';
import type { PlanSpec, TaskSpec } from '../../../src/core/types.ts';
import { estimateBudget, modelFor, shouldStop } from '../../../src/cost/policy.ts';
import { costReport, renderCostReport } from '../../../src/cost/report.ts';
import { UsageStore } from '../../../src/cost/usage.ts';
import { openRuntime, type Runtime } from '../../../src/runtime.ts';

let root: string;
let rt: Runtime;
let store: UsageStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kil-cost-'));
  rt = openRuntime({ root, create: true });
  store = new UsageStore(rt.db);
});
afterEach(() => {
  rt.close();
  rmSync(root, { recursive: true, force: true });
});

const payload = (over: Record<string, unknown> = {}) => ({
  session_id: 's1',
  model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet' },
  cost: { total_cost_usd: 0.5, total_duration_ms: 1000 },
  context_window: {
    total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 12.5,
    current_usage: { cache_read_input_tokens: 700, cache_creation_input_tokens: 50 },
  },
  ...over,
});

describe('UsageStore', () => {
  it('records a full statusline payload as MEASURED', () => {
    const s = store.recordStatusline(payload());
    expect(s).toMatchObject({
      sessionId: 's1', source: 'statusline', label: 'MEASURED', model: 'claude-sonnet-5-5',
      inputTokens: 1000, outputTokens: 200, cacheReadTokens: 700, cacheWriteTokens: 50,
      costUsd: 0.5, durationMs: 1000, contextUsedPct: 12.5,
    });
    expect(store.latest('s1')?.inputTokens).toBe(1000);
  });

  it('keeps missing fields null and falls back to display_name', () => {
    const s = store.recordStatusline({ session_id: 's2', model: { display_name: 'Opus' } });
    expect(s).toMatchObject({ model: 'Opus', inputTokens: null, outputTokens: null, costUsd: null, cacheReadTokens: null, contextUsedPct: null });
  });

  it('returns null for unusable payloads', () => {
    expect(store.recordStatusline(null)).toBeNull();
    expect(store.recordStatusline('x')).toBeNull();
    expect(store.recordStatusline({ cost: {} })).toBeNull();
    expect(store.recordStatusline(payload({ context_window: { total_input_tokens: 'many' } }))?.inputTokens).toBeNull();
  });

  it('throttles unchanged totals within 5s but records changes', () => {
    store.recordStatusline(payload());
    store.recordStatusline(payload());
    const count = () => (rt.db.prepare('SELECT COUNT(*) AS n FROM usage_samples').get() as { n: number }).n;
    expect(count()).toBe(1);
    store.recordStatusline(payload({ context_window: { total_input_tokens: 2000, total_output_tokens: 300 } }));
    expect(count()).toBe(2);
  });

  it('computes deltaSince and first/prune', () => {
    const ins = rt.db.prepare(
      "INSERT INTO usage_samples(session_id, source, label, input_tokens, output_tokens, cost_usd, recorded_at) VALUES('s3','statusline','MEASURED',?,?,?,?)",
    );
    ins.run(100, 10, 0.1, '2026-01-01T00:00:00.000Z');
    ins.run(500, 50, 0.4, '2026-01-01T01:00:00.000Z');
    ins.run(900, 90, 0.9, '2026-01-01T02:00:00.000Z');
    expect(store.first('s3')?.inputTokens).toBe(100);
    const d = store.deltaSince('s3', '2026-01-01T00:30:00.000Z');
    expect(d?.inputTokens).toBe(400);
    expect(d?.outputTokens).toBe(40);
    expect(d?.costUsd).toBeCloseTo(0.5);
    expect(d?.samples).toBe(2);
    expect(store.deltaSince('s3', '2027-01-01T00:00:00.000Z')).toBeNull();
    expect(store.prune(1)).toBe(2);
    expect(store.first('s3')?.inputTokens).toBe(900);
  });
});

const task = (id: string, complexity: TaskSpec['complexity']): TaskSpec => ({
  id, title: id, description: '', role: 'developer', taskClass: 'implementation', complexity, priority: 1,
  dependsOn: [], files: [], inputs: [], expectedOutput: '', acceptance: [], maxRetries: 1,
});
const plan: PlanSpec = { objective: 'o', tasks: [task('a', 'trivial'), task('b', 'small'), task('c', 'medium'), task('d', 'large')] };

describe('policy', () => {
  it('modelFor reads config', () => {
    expect(modelFor('architecture', DEFAULT_CONFIG)).toBe('opus');
    expect(modelFor('discovery', DEFAULT_CONFIG)).toBe('haiku');
  });

  it('estimates SINGLE: work 198k + 15% reserve', () => {
    const e = estimateBudget(plan, 'SINGLE', 1);
    expect(e.label).toBe('ESTIMATED');
    expect(e.components.find((c) => c.name === 'work')?.tokens).toBe(198_000);
    expect(e.components.find((c) => c.name === 'agent-init')?.tokens).toBe(0);
    expect(e.total).toBe(Math.round(198_000 * 1.15));
  });

  it('estimates SUBAGENT with init and TEAM with capped overhead', () => {
    expect(estimateBudget(plan, 'SUBAGENT', 2).components.find((c) => c.name === 'agent-init')?.tokens).toBe(40_000);
    const t3 = estimateBudget(plan, 'TEAM', 3);
    expect(t3.components.find((c) => c.name === 'coordination')?.tokens).toBe(39_600); // 20% of 198k
    const t9 = estimateBudget(plan, 'TEAM', 9);
    expect(t9.components.find((c) => c.name === 'coordination')?.tokens).toBe(79_200); // capped 40%
    const sum = t3.components.filter((c) => c.name !== 'verification-reserve').reduce((s, c) => s + c.tokens, 0);
    expect(t3.total).toBe(sum + Math.round(sum * 0.15));
  });

  it('shouldStop thresholds', () => {
    const base = { budgetTokens: 100_000, verificationReserve: 0.15 }; // usable 85k
    expect(shouldStop({ ...base, usedTokens: 50_000 })).toMatchObject({ stop: false, warn: false });
    expect(shouldStop({ ...base, usedTokens: 68_000 })).toMatchObject({ stop: false, warn: true });
    expect(shouldStop({ ...base, usedTokens: 85_000 })).toMatchObject({ stop: true, warn: true });
    expect(shouldStop({ budgetTokens: 0, verificationReserve: 0.15, usedTokens: 1 }).stop).toBe(true);
  });
});

describe('costReport', () => {
  const t0 = '2026-01-01T00:00:00.000Z';
  const base = { executionStartedAt: t0, verifiedTasks: 2, totalTasks: 4 };

  it('is UNAVAILABLE without session or samples', () => {
    for (const sessionId of [null, 'nosession']) {
      const r = costReport({ usage: store, sessionId, ...base });
      expect(r.tokens.label).toBe('UNAVAILABLE');
      expect(r.costPerVerifiedTask.label).toBe('UNAVAILABLE');
      expect(r.notes.join(' ')).toMatch(/list price/);
      expect(r.notes.join(' ')).toMatch(/Per-agent usage is UNAVAILABLE/);
    }
  });

  it('computes MEASURED values and per-task division; UNAVAILABLE with zero verified tasks', () => {
    const ins = rt.db.prepare(
      "INSERT INTO usage_samples(session_id, source, label, input_tokens, output_tokens, cost_usd, recorded_at) VALUES('s',?,'MEASURED',?,?,?,?)",
    );
    ins.run('statusline', 0, 0, 0, '2026-01-01T00:00:01.000Z');
    ins.run('statusline', 3000, 1000, 2, '2026-01-01T01:00:00.000Z');
    const r = costReport({ usage: store, sessionId: 's', ...base });
    expect(r.tokens).toMatchObject({ value: 4000, label: 'MEASURED' });
    expect(r.costPerVerifiedTask.value).toBe(1);
    expect(r.tokensPerVerifiedTask.value).toBe(2000);
    expect(renderCostReport(r)).toContain('[MEASURED]');
    const none = costReport({ usage: store, sessionId: 's', ...base, verifiedTasks: 0 });
    expect(none.tokens.label).toBe('MEASURED');
    expect(none.costPerVerifiedTask.label).toBe('UNAVAILABLE');
    expect(renderCostReport(none)).toContain('UNAVAILABLE');
  });
});
