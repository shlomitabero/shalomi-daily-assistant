import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityHeaders } from './securityHeaders.js';

function makeRes() {
  const headers = {};
  return { headers, setHeader: (k, v) => { headers[k] = v; } };
}

test('sets X-Frame-Options to DENY, stopping this app from being framed by another site', () => {
  const res = makeRes();
  securityHeaders({}, res, () => {});
  assert.equal(res.headers['X-Frame-Options'], 'DENY');
});

test('sets X-Content-Type-Options to nosniff', () => {
  const res = makeRes();
  securityHeaders({}, res, () => {});
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
});

test('sets Referrer-Policy to no-referrer', () => {
  const res = makeRes();
  securityHeaders({}, res, () => {});
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
});

test('always calls next() so the request continues to the real route', () => {
  const res = makeRes();
  let nextCalled = false;
  securityHeaders({}, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
