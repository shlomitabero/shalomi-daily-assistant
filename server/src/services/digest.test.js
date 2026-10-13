import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests } from '../db/store.js';
import { generateDailyDigest } from './digest.js';

test('generateDailyDigest creates exactly one row for today on first run', () => {
  __resetForTests();
  generateDailyDigest();
  assert.equal(db.digests.all().length, 1);
});

test('generating again the same day updates the existing row instead of duplicating it', () => {
  // This is the bug this test guards against: the owner can click
  // "generate now" on the Digests page any number of times a day on top of
  // the 7am cron run, and each click must refresh today's entry, not pile
  // up several near-duplicate rows for the same date.
  __resetForTests();
  const first = generateDailyDigest();
  const second = generateDailyDigest();
  assert.equal(db.digests.all().length, 1);
  assert.equal(second.id, first.id);
});

test('a digest generated for a different day does not get merged with today\'s', () => {
  __resetForTests();
  const today = generateDailyDigest();
  db.digests.insert({ id: 'dig_yesterday', date: '2000-01-01', text: 'old', generatedAt: '2000-01-01T00:00:00.000Z' });
  const updatedToday = generateDailyDigest();
  assert.equal(db.digests.all().length, 2);
  assert.equal(updatedToday.id, today.id);
});
