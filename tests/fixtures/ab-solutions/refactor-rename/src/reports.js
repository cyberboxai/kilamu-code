import { computeTotal } from './money.js';

/** Revenue across many orders (no discounts applied in reports). */
export function revenue(orders) {
  return orders.reduce((sum, o) => sum + computeTotal(o.lines), 0);
}
