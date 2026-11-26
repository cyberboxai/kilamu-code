/**
 * Paginate an array. Pages are 1-based.
 * @returns {{ items: unknown[], page: number, pageSize: number, totalPages: number, hasNext: boolean }}
 */
export function paginate(items, page, pageSize) {
  if (pageSize <= 0) throw new RangeError('pageSize must be positive');
  const totalPages = Math.floor(items.length / pageSize);
  const start = page * pageSize;
  const slice = items.slice(start, start + pageSize);
  return { items: slice, page, pageSize, totalPages, hasNext: page < totalPages - 1 };
}
