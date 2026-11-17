import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests, makeId } from '../db/store.js';
import { listActions, reportClientError, resolveUnrecordedSale } from './actions.js';

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

test('reportClientError rejects a request with no body at all instead of throwing', () => {
  // req.body is undefined, not {}, when body-parser didn't run for this
  // request at all - every other test here always supplies a body object.
  __resetForTests();
  const res = makeRes();
  reportClientError({}, res);
  assert.equal(res.statusCode, 400);
  assert.equal(db.actions_log.all().length, 0);
});

test('reportClientError rejects a non-string message instead of storing a type the UI never expects', () => {
  __resetForTests();
  const res = makeRes();
  reportClientError({ body: { message: { not: 'a string' } } }, res);
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

test('resolveUnrecordedSale returns 404 for an id that does not exist', () => {
  __resetForTests();
  const res = makeRes();
  resolveUnrecordedSale({ params: { id: 'act_missing' } }, res);
  assert.equal(res.statusCode, 404);
});

test('resolveUnrecordedSale rejects an entry that is not a blocked sale_confirmed', () => {
  // A success sale_confirmed is already fully recorded in the ledger - this
  // action only ever makes sense for the one case where it wasn't.
  __resetForTests();
  const entry = db.actions_log.insert({
    id: makeId('act'), type: 'sale_confirmed', detail: { opportunityId: 'opp_1' }, result: 'success', createdAt: new Date().toISOString(),
  });
  const res = makeRes();
  resolveUnrecordedSale({ params: { id: entry.id } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(db.actions_log.get(entry.id).detail.resolvedAt, undefined);
});

test('resolveUnrecordedSale rejects a blocked entry of a different type', () => {
  __resetForTests();
  const entry = db.actions_log.insert({
    id: makeId('act'), type: 'publish_product', detail: {}, result: 'blocked: Paddle עדיין לא מוגדר', createdAt: new Date().toISOString(),
  });
  const res = makeRes();
  resolveUnrecordedSale({ params: { id: entry.id } }, res);
  assert.equal(res.statusCode, 409);
});

test('resolveUnrecordedSale marks a blocked sale_confirmed entry as resolved', () => {
  __resetForTests();
  const entry = db.actions_log.insert({
    id: makeId('act'), type: 'sale_confirmed', detail: { opportunityId: 'opp_1', error: 'bad amount' },
    result: 'blocked: bad amount', createdAt: new Date().toISOString(),
  });
  const res = makeRes();
  resolveUnrecordedSale({ params: { id: entry.id } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.action.detail.resolvedAt);
  // The original detail fields must survive, not be replaced.
  assert.equal(res.body.action.detail.opportunityId, 'opp_1');
});

test('resolveUnrecordedSale rejects resolving the same entry twice', () => {
  __resetForTests();
  const entry = db.actions_log.insert({
    id: makeId('act'), type: 'sale_confirmed', detail: { opportunityId: 'opp_1' }, result: 'blocked: bad amount', createdAt: new Date().toISOString(),
  });
  resolveUnrecordedSale({ params: { id: entry.id } }, makeRes());
  const res = makeRes();
  resolveUnrecordedSale({ params: { id: entry.id } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.duplicate, true);
});
