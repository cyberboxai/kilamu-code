import { DatabaseSync } from 'node:sqlite';

export function openUserDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL);
           INSERT INTO users (name, role) VALUES ('alice', 'admin'), ('bob', 'user'), ('O''Brien', 'user');`);
  return db;
}

/** Look up one user by exact name. */
export function findUserByName(db, name) {
  return db.prepare('SELECT id, name, role FROM users WHERE name = ?').get(name);
}

/** Users whose role matches. */
export function listUsersByRole(db, role) {
  return db.prepare('SELECT id, name, role FROM users WHERE role = ? ORDER BY id').all(role);
}
