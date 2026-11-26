/**
 * Paginate an array. Pages are 1-based.
 * @returns {{ items: unknown[], page: number, pageSize: number, totalPages: number, hasNext: boolean }}
 */
export function paginate(items, page, pageSize) {
  if (pageSize <= 0) throw new RangeError('pageSize must be positive');
  const totalPages = Math.ceil(items.length / pageSize);
  const start = (page - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  return { items: slice, page, pageSize, totalPages, hasNext: page < totalPages };
}
