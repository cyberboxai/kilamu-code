import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import * as repo from '../src/repo/orders.js';
import { orderFromRow } from '../src/models/order.js';
import { serializeOrder } from '../src/serializers/order.js';
import { listOrdersHandler } from '../src/api/orders.js';
import * as reports from '../src/reports/revenue.js';

function seed() {
  const db = openDb();
  repo.insertOrder(db, { accountId: 7, totalCents: 1250 });
  repo.insertOrder(db, { accountId: 7, totalCents: 500, status: 'cancelled' });
  repo.insertOrder(db, { accountId: 9, totalCents: 300 });
  return db;
}

test('schema uses account_id', () => {
  const cols = openDb().prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  assert.ok(cols.includes('account_id'));
  assert.ok(!cols.includes('customer_id'));
});
test('account_id stays NOT NULL and indexed', () => {
  const db = openDb();
  assert.throws(() => db.prepare('INSERT INTO orders (total_cents) VALUES (1)').run());
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orders'").all().map((r) => r.name);
  assert.ok(idx.some((n) => n.includes('account')), `index names: ${idx}`);
});
test('model maps account_id to accountId', () => {
  assert.deepEqual(orderFromRow({ id: 1, account_id: 3, total_cents: 10, status: 'open' }), { id: 1, accountId: 3, totalCents: 10, status: 'open' });
});
test('repository finds orders by account', () => {
  assert.equal('findOrdersByCustomer' in repo, false);
  assert.deepEqual(repo.findOrdersByAccount(seed(), 7).map((o) => o.totalCents), [1250, 500]);
});
test('serializer emits account_id', () => {
  assert.deepEqual(serializeOrder({ id: 1, accountId: 3, totalCents: 1999, status: 'open' }), { id: 1, account_id: 3, total: 19.99, status: 'open' });
});
test('API filters by ?account= and validates it', () => {
  const db = seed();
  const ok = listOrdersHandler(db, { account: '9' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, [{ id: 3, account_id: 9, total: 3, status: 'open' }]);
  assert.equal(listOrdersHandler(db, { customer: '9' }).status, 400);
  assert.equal(listOrdersHandler(db, {}).body.error, 'account is required');
});
test('revenue report is grouped by account and skips cancelled orders', () => {
  assert.equal('revenueByCustomer' in reports, false);
  assert.deepEqual(reports.revenueByAccount(seed()), { 7: 1250, 9: 300 });
});
test('no source or schema file mentions the old name', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const f of [...walk(join(root, 'db')), ...walk(join(root, 'src'))]) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /customer_id|customerId|Customer/, f);
  }
});
