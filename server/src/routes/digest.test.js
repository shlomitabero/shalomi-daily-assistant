import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests, makeId } from '../db/store.js';
import { listDigests, generateDigest } from './digest.js';

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.statusCode ??= 200; return res; };
  return res;
}

test('listDigests returns digests newest-first regardless of insertion order', () => {
  __resetForTests();
  db.digests.insert({ id: makeId('dig'), date: '2026-01-01', text: 'old', generatedAt: '2026-01-01T00:00:00.000Z' });
  db.digests.insert({ id: makeId('dig'), date: '2026-03-01', text: 'newest', generatedAt: '2026-03-01T00:00:00.000Z' });
  db.digests.insert({ id: makeId('dig'), date: '2026-02-01', text: 'middle', generatedAt: '2026-02-01T00:00:00.000Z' });

  const res = makeRes();
  listDigests({}, res);
  assert.deepEqual(res.body.digests.map((d) => d.text), ['newest', 'middle', 'old']);
});

test('listDigests returns an empty list rather than throwing when there are no digests', () => {
  __resetForTests();
  const res = makeRes();
  listDigests({}, res);
  assert.deepEqual(res.body.digests, []);
});

test('generateDigest responds 201 with the freshly generated digest', () => {
  __resetForTests();
  const res = makeRes();
  generateDigest({}, res);
  assert.equal(res.statusCode, 201);
  assert.ok(res.body.digest);
  assert.ok(res.body.digest.text);
});

test('generateDigest called twice the same day replaces the earlier entry instead of duplicating it', () => {
  __resetForTests();
  generateDigest({}, makeRes());
  generateDigest({}, makeRes());

  const listRes = makeRes();
  listDigests({}, listRes);
  assert.equal(listRes.body.digests.length, 1);
});
