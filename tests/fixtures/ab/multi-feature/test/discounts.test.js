import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscountBook, applyDiscount } from '../src/pricing/discounts.js';

const now = new Date('2026-11-26T12:00:00Z');
const cart = (customerId, ...lines) => ({ customerId, lines });
const book = () => createDiscountBook([
  { code: 'TEN', kind: 'percent', value: 10, expiresAt: '2026-12-31T23:59:59Z' },
  { code: 'KZ500', kind: 'fixed', valueCents: 50000, minSubtotalCents: 100000 },
  { code: 'OLD', kind: 'percent', value: 50, expiresAt: '2026-01-01T00:00:00Z' },
  { code: 'ONCE', kind: 'fixed', valueCents: 1000, singleUse: true },
]);

test('percentage discount, rounded to cents', () => {
  const r = applyDiscount(book(), cart('c1', { priceCents: 1999, qty: 3 }), 'TEN', now);
  assert.deepEqual(r, { ok: true, subtotalCents: 5997, discountCents: 600, totalCents: 5397 });
});
test('codes are case-insensitive and trimmed', () => assert.equal(applyDiscount(book(), cart('c1', { priceCents: 1000, qty: 1 }), '  ten ', now).discountCents, 100));
test('fixed discount respects the minimum subtotal', () => {
  assert.deepEqual(applyDiscount(book(), cart('c1', { priceCents: 50000, qty: 1 }), 'KZ500', now), { ok: false, reason: 'MIN_SUBTOTAL' });
  assert.equal(applyDiscount(book(), cart('c1', { priceCents: 60000, qty: 2 }), 'KZ500', now).totalCents, 70000);
});
test('a fixed discount never makes the total negative', () => {
  const b = createDiscountBook([{ code: 'BIG', kind: 'fixed', valueCents: 99999 }]);
  assert.deepEqual(applyDiscount(b, cart('c1', { priceCents: 500, qty: 1 }), 'BIG', now), { ok: true, subtotalCents: 500, discountCents: 500, totalCents: 0 });
});
test('expired and unknown codes are rejected', () => {
  assert.deepEqual(applyDiscount(book(), cart('c1', { priceCents: 1000, qty: 1 }), 'OLD', now), { ok: false, reason: 'EXPIRED' });
  assert.deepEqual(applyDiscount(book(), cart('c1', { priceCents: 1000, qty: 1 }), 'NOPE', now), { ok: false, reason: 'UNKNOWN_CODE' });
});
test('single-use codes work once per customer', () => {
  const b = book();
  assert.equal(applyDiscount(b, cart('c1', { priceCents: 5000, qty: 1 }), 'ONCE', now).ok, true);
  assert.deepEqual(applyDiscount(b, cart('c1', { priceCents: 5000, qty: 1 }), 'ONCE', now), { ok: false, reason: 'ALREADY_USED' });
  assert.equal(applyDiscount(b, cart('c2', { priceCents: 5000, qty: 1 }), 'ONCE', now).ok, true);
});
test('invalid definitions are refused when the book is created', () => {
  assert.throws(() => createDiscountBook([{ code: 'X', kind: 'percent', value: 120 }]), RangeError);
  assert.throws(() => createDiscountBook([{ code: 'A', kind: 'fixed', valueCents: 1 }, { code: 'a', kind: 'fixed', valueCents: 2 }]), /duplicate/i);
});
