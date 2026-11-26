import { isDeepStrictEqual } from 'node:util';

export function createAuditLog() {
  return { entries: [] };
}

export function diff(before, after) {
  const fields = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  return fields
    .filter((f) => !isDeepStrictEqual(before?.[f], after?.[f]))
    .map((field) => ({ field, from: before?.[field], to: after?.[field] }));
}

export function record(log, { entity, actor, at, before, after }) {
  if (typeof actor !== 'string' || !actor) throw new TypeError('actor is required');
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) throw new TypeError('at must be an ISO timestamp');
  const changes = diff(before, after);
  for (const c of changes) log.entries.push(Object.freeze({ entity, actor, at, ...c }));
  return changes.length;
}

export function history(log, entity) {
  return log.entries.filter((e) => e.entity === entity).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
