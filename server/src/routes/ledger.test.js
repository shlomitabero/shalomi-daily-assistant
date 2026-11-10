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

test('getEntries caps the response at 200, newest first, instead of returning the entire lifetime ledger', () => {
  // Same precedent as listActions (actions.js, 200), listDigests
  // (digest.js, 90), and listPaperTrades (financial.js, 100) - this route
  // was the one list endpoint left with no cap at all, growing forever
  // for an app meant to run indefinitely.
  __resetForTests();
  for (let i = 0; i < 205; i += 1) {
    db.ledger.insert({
      id: makeId('led'), type: 'revenue', amount: i,
      createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    });
  }
  const res = makeRes();
  getEntries({}, res);
  assert.equal(res.body.entries.length, 200);
  assert.equal(res.body.entries[0].amount, 204);
  assert.equal(res.body.entries[199].amount, 5);
});
