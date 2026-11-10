import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireOwner } from './auth.js';
import { signOwnerToken } from '../engine/auth.js';

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('requireOwner rejects a request with no Authorization header', () => {
  const res = makeRes();
  let nextCalled = false;
  requireOwner({ headers: {} }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('requireOwner rejects a header that is not in the "Bearer <token>" form', () => {
  // A raw token with no "Bearer " prefix (a common copy-paste mistake)
  // must be refused, not accidentally accepted as-is.
  const res = makeRes();
  let nextCalled = false;
  requireOwner({ headers: { authorization: signOwnerToken() } }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('requireOwner rejects a well-formed but invalid/garbage token', () => {
  const res = makeRes();
  let nextCalled = false;
  requireOwner({ headers: { authorization: 'Bearer not-a-real-token' } }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('requireOwner rejects with a clean Hebrew error, not raw English, so a flash of it before the login redirect is never untranslated', () => {
  // Every other error in this codebase is Hebrew - this 401 body was the
  // one exception ('not authenticated'). client/src/api.js's auth:expired
  // handling already redirects to /login purely off the status code, so
  // this message is never pattern-matched anywhere; it only needs to read
  // right if a page's own error line renders it in the gap before that
  // redirect takes effect.
  const res = makeRes();
  requireOwner({ headers: {} }, res, () => {});
  assert.equal(res.body.error, 'לא מחובר — יש להתחבר מחדש');
});

test('requireOwner calls next() with no response sent for a genuine owner token', () => {
  const res = makeRes();
  let nextCalled = false;
  requireOwner({ headers: { authorization: `Bearer ${signOwnerToken()}` } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});
