import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HudState, LabeledValue } from '../../../src/core/types.ts';
import { collectCapabilities, renderDoctor } from '../../../src/observability/doctor.ts';
import { EventLog } from '../../../src/observability/events.ts';
import { parseStatuslinePayload, renderStatusline } from '../../../src/observability/statusline.ts';
import { openRuntime, type Runtime } from '../../../src/runtime.ts';

const m = (value: number): LabeledValue => ({ value, label: 'MEASURED', source: 't' });
const e = (value: number): LabeledValue => ({ value, label: 'ESTIMATED', source: 't' });
const na: LabeledValue = { value: null, label: 'UNAVAILABLE', source: 't' };

function hud(over: Partial<HudState> = {}): HudState {
  return {
    execution: null,
    usage: { model: 'sonnet', tokens: m(12_300), costUsd: m(0.45), contextPct: m(42), durationMs: na, cacheHitRatio: na },
    budgetRemainingPct: na,
    ...over,
  };
}
const execution: NonNullable<HudState['execution']> = {
  id: 'ex1', objective: 'Add authentication to the API service with refresh tokens and rotation', status: 'ACTIVE', mode: 'SUBAGENT',
  teamSize: 2, progressPct: 60, counts: { VERIFIED: 3, RUNNING: 1 }, total: 5,
  running: [{ taskId: 'T4', role: 'developer', title: 'x' }], next: 'T5 write docs', blockers: ['a', 'b'], lastVerified: 'T3', budgetTokens: 400_000,
};

describe('renderStatusline', () => {
  it('renders one line without an execution', () => {
    const out = renderStatusline(hud());
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toBe('KILAMU | sonnet | ctx 42% | 12.3K tok | $0.45');
  });

  it('renders execution lines', () => {
    const out = renderStatusline(hud({ execution, budgetRemainingPct: m(64) }));
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('VERIFIED 3/5 (60%)');
    expect(lines[1]).toContain('SUBAGENT');
    expect(lines[1]).toContain('ACTIVE');
    expect(lines[1]).toContain('...');
    expect(lines[2]).toContain('running T4:developer');
    expect(lines[2]).toContain('next: T5 write docs');
    expect(lines[2]).toContain('blockers 2');
    expect(lines[2]).toContain('budget 64% left');
  });

  it('omits UNAVAILABLE metrics and non-MEASURED cost; marks ESTIMATED with ~', () => {
    const out = renderStatusline(hud({ usage: { model: null, tokens: e(5000), costUsd: e(1), contextPct: na, durationMs: na, cacheHitRatio: na } }));
    expect(out).toBe('KILAMU | 5.0K tok~');
    const none = renderStatusline(hud({ usage: { model: null, tokens: na, costUsd: na, contextPct: na, durationMs: na, cacheHitRatio: na } }));
    expect(none).toBe('KILAMU');
  });

  it('compact is a single line', () => {
    const out = renderStatusline(hud({ execution }), { compact: true });
    expect(out).not.toContain('\n');
    expect(out).toContain('VERIFIED 3/5');
  });

  it('uses ANSI only with color and strips control chars from objective', () => {
    expect(renderStatusline(hud())).not.toContain('\u001b');
    expect(renderStatusline(hud(), { color: true })).toContain('\u001b[');
    const evil = renderStatusline(hud({ execution: { ...execution, objective: 'x\u001b[31mred\nline' } }));
    expect(evil).not.toContain('\u001b');
    expect(evil.split('\n')).toHaveLength(3);
  });

  it('respects width', () => {
    const out = renderStatusline(hud({ execution }), { width: 30 });
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(30);
  });
});

describe('parseStatuslinePayload', () => {
  it('parses JSON and returns null on garbage', () => {
    expect(parseStatuslinePayload('{"a":1}')).toEqual({ a: 1 });
    expect(parseStatuslinePayload('not json')).toBeNull();
    expect(parseStatuslinePayload('')).toBeNull();
  });
});

describe('EventLog', () => {
  let root: string;
  let rt: Runtime;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kil-obs-'));
    rt = openRuntime({ root, create: true });
  });
  afterEach(() => {
    rt.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('emits, tails in order and redacts secrets', () => {
    const log = new EventLog(rt.db);
    log.emit('a', { n: 1 }, { executionId: 'x1' });
    log.emit('b', { token: 'ghp_' + 'a'.repeat(36), password: 'supersecretvalue' }, { executionId: 'x1', taskId: 'T1', level: 'warn' });
    log.emit('c', {}, { executionId: 'x2' });
    const t = log.tail({ executionId: 'x1', limit: 10 });
    expect(t.map((r) => r.type)).toEqual(['a', 'b']);
    expect(t[1]).toMatchObject({ level: 'warn', taskId: 'T1' });
    const dump = JSON.stringify(t[1]?.data);
    expect(dump).toContain('REDACTED');
    expect(dump).not.toContain('supersecretvalue');
    expect(log.tail({ limit: 2 }).map((r) => r.type)).toEqual(['b', 'c']);
  });
});

describe('doctor', () => {
  it('collects a sane capability report', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kil-doc-'));
    try {
      const r = await collectCapabilities(root);
      expect(r.nodeVersion).toBe(process.versions.node);
      expect(r.nodeSupported).toBe(true);
      expect(r.sqliteAvailable).toBe(true);
      expect(r.fts5Available).toBe(true);
      expect(typeof r.git).toBe('boolean');
      expect(typeof r.agentTeams.available).toBe('boolean');
      expect(r.agentTeams.note).toMatch(/never enables/);
      const text = renderDoctor(r, [{ name: 'db', status: 'ok', detail: 'fine' }]);
      expect(text).toContain('node:sqlite');
      expect(text).toContain('[ok  ] db: fine');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
