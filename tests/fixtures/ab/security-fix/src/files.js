import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPLOAD_DIR = fileURLToPath(new URL('../uploads/', import.meta.url));

/** Return the contents of an uploaded file by its (client-supplied) name. */
export function readUpload(name) {
  return readFileSync(join(UPLOAD_DIR, name), 'utf8');
}
