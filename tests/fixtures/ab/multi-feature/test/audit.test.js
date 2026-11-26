import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditLog, record, diff, history } from '../src/audit/log.js';

test('diff reports changed, added and removed fields, sorted by field', () => {
  assert.deepEqual(diff({ a: 1, b: 2, c: 3 }, { a: 1, b: 5, d: 4 }), [
    { field: 'b', from: 2, to: 5 },
    { field: 'c', from: 3, to: undefined },
    { field: 'd', from: undefined, to: 4 },
  ]);
  assert.deepEqual(diff({ x: [1, 2] }, { x: [1, 2] }), []);
});
test('record stores one entry per change and skips no-op updates', () => {
  const log = createAuditLog();
  assert.equal(record(log, { entity: 'order:1', actor: 'ana', at: '2026-11-26T10:00:00Z', before: { status: 'open' }, after: { status: 'paid' } }), 1);
  assert.equal(record(log, { entity: 'order:1', actor: 'ana', at: '2026-11-26T10:05:00Z', before: { status: 'paid' }, after: { status: 'paid' } }), 0);
  assert.deepEqual(history(log, 'order:1'), [{ entity: 'order:1', actor: 'ana', at: '2026-11-26T10:00:00Z', field: 'status', from: 'open', to: 'paid' }]);
});
test('history is per entity, chronological, and entries are immutable', () => {
  const log = createAuditLog();
  record(log, { entity: 'order:2', actor: 'bob', at: '2026-11-26T11:00:00Z', before: {}, after: { total: 10 } });
  record(log, { entity: 'order:3', actor: 'bob', at: '2026-11-26T09:00:00Z', before: {}, after: { total: 1 } });
  record(log, { entity: 'order:2', actor: 'eve', at: '2026-11-26T08:00:00Z', before: { total: 10 }, after: { total: 12 } });
  const h = history(log, 'order:2');
  assert.deepEqual(h.map((e) => e.actor), ['eve', 'bob']);
  assert.throws(() => { h[0].to = 999; }, TypeError);
  assert.equal(history(log, 'order:2')[0].to, 12);
});
test('actor and timestamp are required', () => {
  const log = createAuditLog();
  assert.throws(() => record(log, { entity: 'order:1', at: '2026-11-26T10:00:00Z', before: {}, after: { a: 1 } }), /actor/);
  assert.throws(() => record(log, { entity: 'order:1', actor: 'ana', at: 'yesterday', before: {}, after: { a: 1 } }), /at/);
});
