import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests, makeId } from '../db/store.js';
import { getSummary, getEntries } from './ledger.js';

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.statusCode ??= 200; return res; };
  return res;
}

test('getSummary returns the ledger summary shape', () => {
  __resetForTests();
  const res = makeRes();
  getSummary({}, res);
  assert.ok(res.body.summary);
});

test('getEntries returns entries newest-first regardless of insertion order', () => {
  __resetForTests();
  db.ledger.insert({ id: makeId('led'), type: 'revenue', amount: 10, createdAt: '2026-01-01T00:00:00.000Z' });
  db.ledger.insert({ id: makeId('led'), type: 'revenue', amount: 30, createdAt: '2026-03-01T00:00:00.000Z' });
  db.ledger.insert({ id: makeId('led'), type: 'revenue', amount: 20, createdAt: '2026-02-01T00:00:00.000Z' });

  const res = makeRes();
  getEntries({}, res);
  assert.deepEqual(res.body.entries.map((e) => e.amount), [30, 20, 10]);
});

test('getEntries returns an empty list rather than throwing when the ledger is empty', () => {
  __resetForTests();
  const res = makeRes();
  getEntries({}, res);
  assert.deepEqual(res.body.entries, []);
});
