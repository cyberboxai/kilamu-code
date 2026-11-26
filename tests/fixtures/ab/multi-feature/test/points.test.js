import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, earn, redeem, balance, expire } from '../src/loyalty/points.js';

const d = (s) => new Date(s);

test('earn 1 point per whole 100 Kz (10000 cents) spent', () => {
  const l = createLedger();
  assert.equal(earn(l, 'c1', 25999, d('2026-01-10')), 2);
  assert.equal(earn(l, 'c1', 9999, d('2026-01-11')), 0);
  assert.equal(balance(l, 'c1'), 2);
});
test('redeem spends oldest points first and refuses overdraft', () => {
  const l = createLedger();
  earn(l, 'c1', 50000, d('2026-01-01'));
  earn(l, 'c1', 30000, d('2026-06-01'));
  assert.deepEqual(redeem(l, 'c1', 6, d('2026-07-01')), { ok: true, remaining: 2 });
  assert.deepEqual(redeem(l, 'c1', 3, d('2026-07-02')), { ok: false, reason: 'INSUFFICIENT_POINTS', available: 2 });
  assert.equal(balance(l, 'c1'), 2);
});
test('points older than 12 months expire; partially redeemed lots expire only their remainder', () => {
  const l = createLedger();
  earn(l, 'c1', 50000, d('2025-10-01'));
  earn(l, 'c1', 30000, d('2026-06-01'));
  redeem(l, 'c1', 2, d('2026-01-01'));
  assert.equal(expire(l, d('2026-10-02')), 3);
  assert.equal(balance(l, 'c1'), 3);
});
test('balances are per customer and invalid input is refused', () => {
  const l = createLedger();
  earn(l, 'c1', 20000, d('2026-01-01'));
  assert.equal(balance(l, 'c2'), 0);
  assert.throws(() => earn(l, 'c1', -5, d('2026-01-01')), RangeError);
  assert.throws(() => redeem(l, 'c1', 0, d('2026-01-01')), RangeError);
});
