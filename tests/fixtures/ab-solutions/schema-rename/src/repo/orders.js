import { orderFromRow } from '../models/order.js';

export function insertOrder(db, { accountId, totalCents, status = 'open' }) {
  const r = db.prepare('INSERT INTO orders (account_id, total_cents, status) VALUES (?, ?, ?)').run(accountId, totalCents, status);
  return Number(r.lastInsertRowid);
}

export function findOrdersByAccount(db, accountId) {
  return db.prepare('SELECT * FROM orders WHERE account_id = ? ORDER BY id').all(accountId).map(orderFromRow);
}

export function allOrders(db) {
  return db.prepare('SELECT * FROM orders ORDER BY id').all().map(orderFromRow);
}
