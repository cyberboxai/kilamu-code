import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export const UPLOAD_DIR = new URL('../uploads/', import.meta.url).pathname;

function forbidden() {
  return Object.assign(new Error('path escapes the upload directory'), { code: 'EFORBIDDEN' });
}

/** Return the contents of an uploaded file by its (client-supplied) name. */
export function readUpload(name) {
  if (typeof name !== 'string' || name === '' || isAbsolute(name)) throw forbidden();
  const target = resolve(UPLOAD_DIR, name);
  const rel = relative(UPLOAD_DIR, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw forbidden();
  return readFileSync(target, 'utf8');
}
