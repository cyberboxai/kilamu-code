import { allOrders } from '../repo/orders.js';

/** Revenue in cents per account, excluding cancelled orders. */
export function revenueByAccount(db) {
  const out = {};
  for (const o of allOrders(db)) {
    if (o.status === 'cancelled') continue;
    out[o.accountId] = (out[o.accountId] ?? 0) + o.totalCents;
  }
  return out;
}
