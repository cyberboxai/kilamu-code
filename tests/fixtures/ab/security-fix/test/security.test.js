import test from 'node:test';
import assert from 'node:assert/strict';
import { readUpload } from '../src/files.js';
import { openUserDb, findUserByName, listUsersByRole } from '../src/users.js';
import { handle } from '../src/server.js';

const forbidden = (fn) => assert.throws(fn, (e) => e.code === 'EFORBIDDEN', 'expected an error with code EFORBIDDEN');

test('legitimate uploads still work, including subdirectories', () => {
  assert.equal(readUpload('report.txt').trim(), 'hello from a legitimate upload');
  assert.equal(readUpload('2026/q1.txt').trim(), 'nested upload');
});
test('path traversal is refused with code EFORBIDDEN', () => {
  forbidden(() => readUpload('../secret.txt'));
  forbidden(() => readUpload('2026/../../secret.txt'));
  forbidden(() => readUpload('/etc/passwd'));
  forbidden(() => readUpload('..'));
});
test('a sibling directory sharing the prefix is refused', () => forbidden(() => readUpload('../uploads-evil/x.txt')));
test('the download route answers 403 for traversal and 404 for missing files', () => {
  const db = openUserDb();
  assert.equal(handle(db, { path: '/download', query: { file: '../secret.txt' } }).status, 403);
  assert.equal(handle(db, { path: '/download', query: { file: 'nope.txt' } }).status, 404);
  assert.equal(handle(db, { path: '/download', query: { file: 'report.txt' } }).status, 200);
});
test('user lookup is not injectable', () => {
  const db = openUserDb();
  assert.equal(findUserByName(db, "x' OR '1'='1"), undefined);
  assert.equal(findUserByName(db, "' OR role = 'admin' --"), undefined);
});
test('names with quotes are found exactly', () => {
  const db = openUserDb();
  assert.equal(findUserByName(db, "O'Brien")?.role, 'user');
  assert.equal(findUserByName(db, 'alice')?.role, 'admin');
});
test('role listing is not injectable either', () => {
  const db = openUserDb();
  assert.deepEqual(listUsersByRole(db, "user' OR '1'='1"), []);
  assert.deepEqual(listUsersByRole(db, 'user').map((u) => u.name), ['bob', "O'Brien"]);
});
test('the user route never leaks rows for injected input', () => {
  const db = openUserDb();
  assert.equal(handle(db, { path: '/user', query: { name: "x' OR '1'='1" } }).status, 404);
});
