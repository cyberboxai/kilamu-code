import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { processBatch } from '../src/billing/batch.js';
import { formatKz } from '../src/billing/format.js';

const load = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'));

test('replaying the 2026-11-25 nightly batch matches the upstream control totals', () => {
  assert.deepEqual(processBatch(load('./nightly.json')), load('./expected.json'));
});
test('small batches keep working', () => {
  assert.deepEqual(processBatch([{ id: 'a', region: 'LDA', amount: '10.00' }, { id: 'b', region: 'CAB', amount: '-2.50' }]),
    { count: 2, netCents: 750, taxCents: 123, grossCents: 873 });
});
test('garbage amounts are rejected', () => assert.throws(() => processBatch([{ id: 'x', region: 'LDA', amount: 'abc' }])));
test('formatting is unchanged', () => assert.equal(formatKz(123450), '1 234,50 Kz'));
