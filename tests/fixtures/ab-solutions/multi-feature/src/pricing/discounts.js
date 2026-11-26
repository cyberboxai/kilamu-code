import { roundCents, subtotal } from '../money.js';

const norm = (code) => String(code).trim().toUpperCase();

export function createDiscountBook(defs) {
  const codes = new Map();
  for (const d of defs) {
    const key = norm(d.code);
    if (codes.has(key)) throw new Error(`duplicate discount code ${key}`);
    if (d.kind === 'percent' && !(d.value > 0 && d.value <= 100)) throw new RangeError(`percent must be in (0, 100]: ${key}`);
    if (d.kind === 'fixed' && !(Number.isInteger(d.valueCents) && d.valueCents > 0)) throw new RangeError(`valueCents must be a positive integer: ${key}`);
    if (d.kind !== 'percent' && d.kind !== 'fixed') throw new TypeError(`unknown discount kind: ${d.kind}`);
    codes.set(key, d);
  }
  return { codes, used: new Set() };
}

export function applyDiscount(book, cart, code, now) {
  const key = norm(code);
  const d = book.codes.get(key);
  if (!d) return { ok: false, reason: 'UNKNOWN_CODE' };
  if (d.expiresAt && now > new Date(d.expiresAt)) return { ok: false, reason: 'EXPIRED' };
  const sub = subtotal(cart);
  if (d.minSubtotalCents && sub < d.minSubtotalCents) return { ok: false, reason: 'MIN_SUBTOTAL' };
  const useKey = `${key}\u0000${cart.customerId}`;
  if (d.singleUse && book.used.has(useKey)) return { ok: false, reason: 'ALREADY_USED' };
  const raw = d.kind === 'percent' ? roundCents((sub * d.value) / 100) : d.valueCents;
  const discountCents = Math.min(raw, sub);
  if (d.singleUse) book.used.add(useKey);
  return { ok: true, subtotalCents: sub, discountCents, totalCents: sub - discountCents };
}
