/** Sum line totals (price × qty) in cents, applying an optional discount rate. */
export function calcTotal(lines, discountRate = 0) {
  const gross = lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);
  return Math.round(gross * (1 - discountRate));
}
