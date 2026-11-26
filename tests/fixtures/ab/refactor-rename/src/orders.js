import { calcTotal } from './money.js';

export function orderTotal(order) {
  return calcTotal(order.lines, order.customer?.vip ? 0.1 : 0);
}
