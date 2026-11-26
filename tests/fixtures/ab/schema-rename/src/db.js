import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

/** Open an in-memory database with the schema applied. */
export function openDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  return db;
}
