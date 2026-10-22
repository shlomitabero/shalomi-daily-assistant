import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests, makeId } from '../db/store.js';
import { listActions } from './actions.js';

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.statusCode ??= 200; return res; };
  return res;
}

test('listActions returns entries newest-first regardless of insertion order', () => {
  __resetForTests();
  db.actions_log.insert({ id: makeId('act'), type: 'scan', result: 'success', createdAt: '2026-01-01T00:00:00.000Z' });
  db.actions_log.insert({ id: makeId('act'), type: 'scan', result: 'success', createdAt: '2026-03-01T00:00:00.000Z' });
  db.actions_log.insert({ id: makeId('act'), type: 'scan', result: 'success', createdAt: '2026-02-01T00:00:00.000Z' });

  const res = makeRes();
  listActions({}, res);
  assert.deepEqual(res.body.actions.map((a) => a.createdAt), [
    '2026-03-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
  ]);
});

test('listActions returns an empty list rather than throwing when the log is empty', () => {
  __resetForTests();
  const res = makeRes();
  listActions({}, res);
  assert.deepEqual(res.body.actions, []);
});

test('listActions caps the response at the 200 most recent entries', () => {
  __resetForTests();
  for (let i = 0; i < 250; i++) {
    db.actions_log.insert({ id: makeId('act'), type: 'scan', result: 'success', createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString() });
  }

  const res = makeRes();
  listActions({}, res);
  assert.equal(res.body.actions.length, 200);
  // The kept entries must be the 200 most recent, not an arbitrary slice.
  assert.equal(res.body.actions[0].createdAt, new Date(2026, 0, 1, 0, 0, 249).toISOString());
  assert.equal(res.body.actions[199].createdAt, new Date(2026, 0, 1, 0, 0, 50).toISOString());
});
