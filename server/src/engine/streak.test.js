import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStreakUpdate } from './streak.js';

test('generating again on the same day does not change the streak', () => {
  const result = computeStreakUpdate({ lastDate: '2026-10-09', today: '2026-10-09', currentStreak: 3 });
  assert.deepEqual(result, { streak: 3, isNewDay: false });
});

test('generating on the very next day increments the streak', () => {
  const result = computeStreakUpdate({ lastDate: '2026-10-08', today: '2026-10-09', currentStreak: 3 });
  assert.deepEqual(result, { streak: 4, isNewDay: true });
});

test('a gap of more than a day resets the streak to 1', () => {
  const result = computeStreakUpdate({ lastDate: '2026-10-01', today: '2026-10-09', currentStreak: 10 });
  assert.deepEqual(result, { streak: 1, isNewDay: true });
});

test('a brand new user (no lastDate) starts a streak of 1', () => {
  const result = computeStreakUpdate({ lastDate: undefined, today: '2026-10-09', currentStreak: 0 });
  assert.deepEqual(result, { streak: 1, isNewDay: true });
});

test('streak correctly rolls over a month boundary', () => {
  const result = computeStreakUpdate({ lastDate: '2026-09-30', today: '2026-10-01', currentStreak: 5 });
  assert.deepEqual(result, { streak: 6, isNewDay: true });
});
