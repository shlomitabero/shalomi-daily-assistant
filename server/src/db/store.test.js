import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDataDir, db, __resetForTests, makeId } from './store.js';

test('resolveDataDir uses the env override when set', () => {
  assert.equal(resolveDataDir('/data', '/app/server/data'), '/data');
});

test('resolveDataDir falls back to the default when unset', () => {
  assert.equal(resolveDataDir(undefined, '/app/server/data'), '/app/server/data');
  assert.equal(resolveDataDir('', '/app/server/data'), '/app/server/data');
});

// The generic table() CRUD helper every route/engine/service in the app
// goes through instead of touching the filesystem directly — a bug here
// would silently corrupt every table at once, not just one feature.
test('get() returns null for a row that was never inserted', () => {
  __resetForTests();
  assert.equal(db.actions_log.get('does_not_exist'), null);
});

test('insert() then get() returns the exact same row back', () => {
  __resetForTests();
  const row = db.actions_log.insert({ id: makeId('act'), type: 'test', detail: { a: 1 }, result: 'success' });
  assert.deepEqual(db.actions_log.get(row.id), row);
});

test('update() merges a patch into the existing row without dropping untouched fields', () => {
  __resetForTests();
  const row = db.settings.insert({ id: 'main', budget: 0, mode: 'research' });
  const updated = db.settings.update('main', { mode: 'approve' });
  assert.equal(updated.mode, 'approve');
  assert.equal(updated.budget, 0);
  assert.deepEqual(db.settings.get('main'), updated);
});

test('update() on a row that does not exist returns null instead of inserting one', () => {
  __resetForTests();
  assert.equal(db.actions_log.update('nope', { result: 'success' }), null);
  assert.equal(db.actions_log.all().length, 0);
});

test('delete() removes an existing row and reports whether one actually existed', () => {
  __resetForTests();
  const row = db.actions_log.insert({ id: makeId('act'), type: 'test', result: 'success' });
  assert.equal(db.actions_log.delete(row.id), true);
  assert.equal(db.actions_log.get(row.id), null);
  assert.equal(db.actions_log.delete(row.id), false);
});

test('where() only returns rows matching the predicate', () => {
  __resetForTests();
  db.actions_log.insert({ id: makeId('act'), type: 'a', result: 'success' });
  db.actions_log.insert({ id: makeId('act'), type: 'b', result: 'failed' });
  db.actions_log.insert({ id: makeId('act'), type: 'a', result: 'failed' });
  assert.equal(db.actions_log.where((a) => a.type === 'a').length, 2);
  assert.equal(db.actions_log.where((a) => a.result === 'failed').length, 2);
});
