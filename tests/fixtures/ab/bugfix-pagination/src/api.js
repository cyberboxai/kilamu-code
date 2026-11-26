import { paginate } from './paginate.js';

/** HTTP-ish handler: ?page=N&size=M over a dataset. */
export function listHandler(dataset, query) {
  const page = Number.parseInt(query.page ?? '1', 10);
  const size = Number.parseInt(query.size ?? '10', 10);
  if (!Number.isInteger(page) || page < 1) return { status: 400, body: { error: 'invalid page' } };
  return { status: 200, body: paginate(dataset, page, size) };
}
