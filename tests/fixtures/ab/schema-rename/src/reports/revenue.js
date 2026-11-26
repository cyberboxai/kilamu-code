import { allOrders } from '../repo/orders.js';

/** Revenue in cents per customer, excluding cancelled orders. */
export function revenueByCustomer(db) {
  const out = {};
  for (const o of allOrders(db)) {
    if (o.status === 'cancelled') continue;
    out[o.customerId] = (out[o.customerId] ?? 0) + o.totalCents;
  }
  return out;
}
