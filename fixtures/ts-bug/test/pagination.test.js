import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageCount, paginate } from '../src/pagination.js';

test('pageCount counts a partial final page', () => {
  assert.equal(pageCount(7, 3), 3, '7 items at 3 per page need 3 pages');
  assert.equal(pageCount(6, 3), 2);
  assert.equal(pageCount(1, 3), 1);
  assert.equal(pageCount(0, 3), 0);
});

test('paginate returns a full page of items', () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(paginate(items, 1, 3), [1, 2, 3]);
  assert.deepEqual(paginate(items, 2, 3), [4, 5, 6]);
});

test('paginate returns the remainder on the final page', () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(paginate(items, 3, 3), [7], 'the last match must still be returned');
});

test('every item appears exactly once across all pages', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const pageSize = 3;
  const seen = [];
  for (let page = 1; page <= pageCount(items.length, pageSize); page += 1) {
    seen.push(...paginate(items, page, pageSize));
  }
  assert.deepEqual(seen, items);
});

test('pageSize must be positive', () => {
  assert.throws(() => pageCount(5, 0), RangeError);
  assert.throws(() => paginate([1], 1, 0), RangeError);
});
