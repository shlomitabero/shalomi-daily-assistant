import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests } from '../db/store.js';
import { getSettings, updateSettings } from './settings.js';

test('getSettings seeds safe defaults on first read — research mode, no budget, no emergency stop', () => {
  // These defaults are what every gate (mode gate, budget gate) falls back
  // to before the owner has configured anything — they must never default
  // to a state that lets a real action run or real money move.
  __resetForTests();
  const settings = getSettings();
  assert.equal(settings.mode, 'research');
  assert.equal(settings.budgetConfigured, false);
  assert.equal(settings.budget, 0);
  assert.equal(settings.emergencyStop, false);
});

test('getSettings returns the same row on every call instead of re-seeding it', () => {
  __resetForTests();
  const first = getSettings();
  updateSettings({ mode: 'auto_limited' });
  const second = getSettings();
  assert.equal(second.mode, 'auto_limited');
  assert.equal(second.id, first.id);
  assert.equal(db.settings.all().length, 1);
});

test('updateSettings merges a patch without dropping fields it did not touch', () => {
  __resetForTests();
  getSettings();
  updateSettings({ budget: 100, budgetConfigured: true });
  const updated = updateSettings({ mode: 'approve' });
  assert.equal(updated.mode, 'approve');
  assert.equal(updated.budget, 100);
  assert.equal(updated.budgetConfigured, true);
});

test('updateSettings works even when getSettings() was never called first', () => {
  __resetForTests();
  assert.equal(db.settings.all().length, 0);
  const updated = updateSettings({ mode: 'approve' });
  assert.equal(updated.mode, 'approve');
  assert.equal(db.settings.all().length, 1);
});
