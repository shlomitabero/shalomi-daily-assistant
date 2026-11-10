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

test('sets Strict-Transport-Security to force HTTPS for a year', () => {
  const res = makeRes();
  securityHeaders({}, res, () => {});
  assert.equal(res.headers['Strict-Transport-Security'], 'max-age=31536000');
});

test('sets Permissions-Policy to disable unused hardware features, but never touches "payment"', () => {
  // Paddle's own checkout overlay (ProductPage.jsx's real revenue path)
  // may rely on the Payment Request API internally for Apple Pay/Google
  // Pay - disabling "payment" here could silently break a real checkout
  // with nothing pointing back to this header as the cause, so this pins
  // that it's deliberately left out even as other features get locked down.
  const res = makeRes();
  securityHeaders({}, res, () => {});
  assert.match(res.headers['Permissions-Policy'], /camera=\(\)/);
  assert.match(res.headers['Permissions-Policy'], /microphone=\(\)/);
  assert.match(res.headers['Permissions-Policy'], /geolocation=\(\)/);
  assert.doesNotMatch(res.headers['Permissions-Policy'], /payment/);
});

test('always calls next() so the request continues to the real route', () => {
  const res = makeRes();
  let nextCalled = false;
  securityHeaders({}, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
