import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const UPLOAD_DIR = new URL('../uploads/', import.meta.url).pathname;

/** Return the contents of an uploaded file by its (client-supplied) name. */
export function readUpload(name) {
  return readFileSync(join(UPLOAD_DIR, name), 'utf8');
}
