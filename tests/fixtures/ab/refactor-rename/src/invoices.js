import { calcTotal } from './money.js';

export function invoiceTotal(invoice) {
  const subtotal = calcTotal(invoice.lines);
  return subtotal + Math.round(subtotal * invoice.taxRate);
}
