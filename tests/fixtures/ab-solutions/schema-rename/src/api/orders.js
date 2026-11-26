import { findOrdersByAccount } from '../repo/orders.js';
import { serializeOrder } from '../serializers/order.js';

/** GET /orders?account=<id> */
export function listOrdersHandler(db, query) {
  const accountId = Number.parseInt(query.account ?? '', 10);
  if (!Number.isInteger(accountId) || accountId <= 0) return { status: 400, body: { error: 'account is required' } };
  return { status: 200, body: findOrdersByAccount(db, accountId).map(serializeOrder) };
}
