import { calcTotal } from './money.js';

/** Revenue across many orders (no discounts applied in reports). */
export function revenue(orders) {
  return orders.reduce((sum, o) => sum + calcTotal(o.lines), 0);
}
