import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests, makeId } from '../db/store.js';
import { listActions, reportClientError } from './actions.js';

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

test('reportClientError rejects a request missing a message instead of logging an empty entry', () => {
  __resetForTests();
  const res = makeRes();
  reportClientError({ body: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(db.actions_log.all().length, 0);
});

test('reportClientError logs a client_error entry the owner can see in the activity log', () => {
  // Until now a render crash (caught by the client's ErrorBoundary) was
  // only ever visible in the browser's own console - this gives it the
  // same visibility as every other failure this app already tracks.
  __resetForTests();
  const res = makeRes();
  reportClientError({ body: { message: 'Cannot read properties of null', path: '/opportunities/opp_1' } }, res);
  assert.equal(res.statusCode, 201);
  const logged = db.actions_log.where((a) => a.type === 'client_error')[0];
  assert.equal(logged.result, 'failed');
  assert.equal(logged.detail.message, 'Cannot read properties of null');
  assert.equal(logged.detail.path, '/opportunities/opp_1');
});

test('reportClientError truncates an unreasonably long message instead of storing it unbounded', () => {
  __resetForTests();
  const res = makeRes();
  reportClientError({ body: { message: 'x'.repeat(5000) } }, res);
  assert.equal(res.statusCode, 201);
  const logged = db.actions_log.where((a) => a.type === 'client_error')[0];
  assert.equal(logged.detail.message.length, 2000);
});

test('reportClientError stores a null path when none is given, instead of an arbitrary non-string value', () => {
  __resetForTests();
  const res = makeRes();
  reportClientError({ body: { message: 'boom', path: 12345 } }, res);
  assert.equal(res.statusCode, 201);
  const logged = db.actions_log.where((a) => a.type === 'client_error')[0];
  assert.equal(logged.detail.path, null);
});
