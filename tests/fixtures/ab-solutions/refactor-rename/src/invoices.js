import { computeTotal } from './money.js';

export function invoiceTotal(invoice) {
  const subtotal = computeTotal(invoice.lines);
  return subtotal + Math.round(subtotal * invoice.taxRate);
}
