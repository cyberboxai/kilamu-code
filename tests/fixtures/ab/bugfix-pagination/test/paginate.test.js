import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/paginate.js';
import { listHandler } from '../src/api.js';

const data = Array.from({ length: 23 }, (_, i) => i + 1);

test('first page starts at the first item', () => assert.deepEqual(paginate(data, 1, 10).items, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
test('last partial page is returned', () => assert.deepEqual(paginate(data, 3, 10).items, [21, 22, 23]));
test('totalPages rounds up', () => assert.equal(paginate(data, 1, 10).totalPages, 3));
test('hasNext is true before the last page and false on it', () => {
  assert.equal(paginate(data, 2, 10).hasNext, true);
  assert.equal(paginate(data, 3, 10).hasNext, false);
});
test('exact multiple has no empty trailing page', () => assert.equal(paginate(data.slice(0, 20), 1, 10).totalPages, 2));
test('empty input has zero pages', () => assert.deepEqual(paginate([], 1, 10), { items: [], page: 1, pageSize: 10, totalPages: 0, hasNext: false }));
test('handler serves page 1 by default', () => assert.deepEqual(listHandler(data, {}).body.items.slice(0, 2), [1, 2]));
test('handler rejects page 0', () => assert.equal(listHandler(data, { page: '0' }).status, 400));
