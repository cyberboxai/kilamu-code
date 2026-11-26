import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPLOAD_DIR = fileURLToPath(new URL('../uploads/', import.meta.url));

function forbidden() {
  return Object.assign(new Error('path escapes the upload directory'), { code: 'EFORBIDDEN' });
}

/** Return the contents of an uploaded file by its (client-supplied) name. */
export function readUpload(name) {
  if (typeof name !== 'string' || name === '' || isAbsolute(name)) throw forbidden();
  const target = resolve(UPLOAD_DIR, name);
  const rel = relative(UPLOAD_DIR, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw forbidden();
  return readFileSync(target, 'utf8');
}
