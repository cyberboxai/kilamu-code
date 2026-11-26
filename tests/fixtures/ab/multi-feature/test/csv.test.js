import test from 'node:test';
import assert from 'node:assert/strict';
import { ordersToCsv } from '../src/export/csv.js';

test('header, CRLF and stable column order', () => {
  const csv = ordersToCsv([{ total: 1250, id: 1, customer: 'Ana', placedAt: '2026-11-01T10:00:00Z' }]);
  assert.equal(csv, 'id,customer,total,placedAt\r\n1,Ana,12.50,2026-11-01T10:00:00Z\r\n');
});
test('fields with commas, quotes or newlines are quoted and quotes doubled', () => {
  const csv = ordersToCsv([{ id: 2, customer: 'Silva, "Zé"\nLda', total: 5, placedAt: '2026-11-02T00:00:00Z' }]);
  assert.equal(csv.split('\r\n')[1], '2,"Silva, ""Zé""\nLda",0.05,2026-11-02T00:00:00Z');
});
test('leading formula characters are neutralised (CSV injection)', () => {
  const csv = ordersToCsv([{ id: 3, customer: '=HYPERLINK("x")', total: 0, placedAt: '2026-11-03T00:00:00Z' }]);
  assert.equal(csv.split('\r\n')[1], `3,"'=HYPERLINK(""x"")",0.00,2026-11-03T00:00:00Z`);
});
test('negative totals (refunds) are plain numbers, not neutralised', () => {
  assert.equal(ordersToCsv([{ id: 5, customer: 'Ana', total: -1250, placedAt: '2026-11-04T00:00:00Z' }]).split('\r\n')[1], '5,Ana,-12.50,2026-11-04T00:00:00Z');
});
test('empty input yields only the header; missing fields are empty', () => {
  assert.equal(ordersToCsv([]), 'id,customer,total,placedAt\r\n');
  assert.equal(ordersToCsv([{ id: 4, total: 100 }]).split('\r\n')[1], '4,,1.00,');
});
