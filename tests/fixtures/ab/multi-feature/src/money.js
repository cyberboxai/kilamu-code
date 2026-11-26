/** Sum of line totals in cents. */
export function subtotal(cart) {
  return cart.lines.reduce((s, l) => s + l.priceCents * l.qty, 0);
}
/** Round half away from zero to whole cents. */
export function roundCents(x) {
  return Math.sign(x) * Math.round(Math.abs(x));
}
