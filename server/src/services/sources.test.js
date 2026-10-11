import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests } from '../db/store.js';
import { syncSources } from './sources.js';

test('syncSources inserts a row for every source definition on first run', () => {
  __resetForTests();
  syncSources();
  assert.ok(db.sources.all().length > 0);
});

test('syncSources refreshes name/description/howToConnect on an existing row, not just connected/lastCheckedAt', () => {
  // This is the bug this test guards against: editing SOURCE_DEFINITIONS'
  // text (e.g. fixing a howToConnect instruction) must reach rows that were
  // already inserted by an earlier sync, not just newly-inserted ones.
  __resetForTests();
  syncSources();
  const before = db.sources.all()[0];

  db.sources.update(before.id, {
    name: 'stale name from before an edit',
    description: 'stale description',
    howToConnect: 'stale how-to-connect text',
  });

  syncSources();
  const after = db.sources.get(before.id);
  assert.notEqual(after.name, 'stale name from before an edit');
  assert.notEqual(after.description, 'stale description');
  assert.notEqual(after.howToConnect, 'stale how-to-connect text');
});

test('syncSources never creates a duplicate row for the same source key', () => {
  __resetForTests();
  syncSources();
  const countAfterFirst = db.sources.all().length;
  syncSources();
  syncSources();
  assert.equal(db.sources.all().length, countAfterFirst);
});
