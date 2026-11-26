import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as money from '../src/money.js';
import { orderTotal } from '../src/orders.js';
import { invoiceTotal } from '../src/invoices.js';
import { revenue } from '../src/reports.js';

const lines = [{ priceCents: 1000, qty: 2 }, { priceCents: 250, qty: 4 }];

test('computeTotal is exported and calcTotal is gone', () => {
  assert.equal(typeof money.computeTotal, 'function');
  assert.equal('calcTotal' in money, false);
});
test('computeTotal applies discounts', () => assert.equal(money.computeTotal(lines, 0.1), 2700));
test('no source file references calcTotal any more', () => {
  const dir = new URL('../src/', import.meta.url).pathname;
  for (const f of readdirSync(dir)) assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /calcTotal/, f);
});
test('orders, invoices and reports keep their behaviour', () => {
  assert.equal(orderTotal({ lines, customer: { vip: true } }), 2700);
  assert.equal(invoiceTotal({ lines, taxRate: 0.2 }), 3600);
  assert.equal(revenue([{ lines }, { lines }]), 6000);
});
