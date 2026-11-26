import { readUpload } from './files.js';
import { findUserByName, listUsersByRole } from './users.js';

/** Minimal request router used by the tests (no real HTTP). */
export function handle(db, req) {
  try {
    if (req.path === '/download') return { status: 200, body: readUpload(req.query.file ?? '') };
    if (req.path === '/user') {
      const u = findUserByName(db, req.query.name ?? '');
      return u ? { status: 200, body: u } : { status: 404, body: { error: 'not found' } };
    }
    if (req.path === '/users') return { status: 200, body: listUsersByRole(db, req.query.role ?? '') };
    return { status: 404, body: { error: 'no route' } };
  } catch (err) {
    if (err?.code === 'EFORBIDDEN') return { status: 403, body: { error: 'forbidden' } };
    if (err?.code === 'ENOENT') return { status: 404, body: { error: 'not found' } };
    return { status: 500, body: { error: 'internal error' } };
  }
}
