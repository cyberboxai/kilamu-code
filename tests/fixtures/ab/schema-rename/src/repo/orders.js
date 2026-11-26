import { orderFromRow } from '../models/order.js';

export function insertOrder(db, { customerId, totalCents, status = 'open' }) {
  const r = db.prepare('INSERT INTO orders (customer_id, total_cents, status) VALUES (?, ?, ?)').run(customerId, totalCents, status);
  return Number(r.lastInsertRowid);
}

export function findOrdersByCustomer(db, customerId) {
  return db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id').all(customerId).map(orderFromRow);
}

export function allOrders(db) {
  return db.prepare('SELECT * FROM orders ORDER BY id').all().map(orderFromRow);
}
