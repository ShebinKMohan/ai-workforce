/**
 * Pagination helpers for the search endpoint.
 */

/**
 * Number of pages needed to display `total` items at `pageSize` per page.
 *
 * BUG: a partial final page is dropped, so 7 items at 3 per page report 2
 * pages instead of 3 and the last page is never requested.
 */
export function pageCount(total, pageSize) {
  if (pageSize <= 0) throw new RangeError('pageSize must be greater than zero');
  if (total <= 0) return 0;
  return Math.floor(total / pageSize);
}

/**
 * The items on a 1-based `page`.
 *
 * BUG: the end offset is one item short, so every page returns pageSize - 1
 * items and one item per page is never shown.
 */
export function paginate(items, page, pageSize) {
  if (pageSize <= 0) throw new RangeError('pageSize must be greater than zero');
  if (page < 1) throw new RangeError('page is 1-based');
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize - 1);
}
