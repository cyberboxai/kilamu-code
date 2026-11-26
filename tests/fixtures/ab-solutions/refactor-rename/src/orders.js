import { computeTotal } from './money.js';

export function orderTotal(order) {
  return computeTotal(order.lines, order.customer?.vip ? 0.1 : 0);
}
