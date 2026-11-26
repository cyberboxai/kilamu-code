import { findOrdersByCustomer } from '../repo/orders.js';
import { serializeOrder } from '../serializers/order.js';

/** GET /orders?customer=<id> */
export function listOrdersHandler(db, query) {
  const customerId = Number.parseInt(query.customer ?? '', 10);
  if (!Number.isInteger(customerId) || customerId <= 0) return { status: 400, body: { error: 'customer is required' } };
  return { status: 200, body: findOrdersByCustomer(db, customerId).map(serializeOrder) };
}
