import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyPaddleSignature } from './paddleSignature.js';

function sign(body, ts, secret) {
  return createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
}

// Every test below except the dedicated freshness ones passes `now`
// matching the fixed ts used throughout this file, so they keep testing
// exactly what they tested before the freshness check was added (whether
// the signature itself is valid), independent of it.
const FIXED_TS = '1700000000';
const FIXED_NOW = Number(FIXED_TS) * 1000;

test('accepts a correctly signed payload', () => {
  const secret = 'whsec_test';
  const body = '{"event_type":"subscription.created"}';
  const h1 = sign(body, FIXED_TS, secret);
  assert.equal(verifyPaddleSignature({ rawBody: body, signatureHeader: `ts=${FIXED_TS};h1=${h1}`, secret, now: FIXED_NOW }), true);
});

test('rejects a tampered body', () => {
  const secret = 'whsec_test';
  const h1 = sign('{"event_type":"subscription.created"}', FIXED_TS, secret);
  assert.equal(verifyPaddleSignature({ rawBody: '{"event_type":"x"}', signatureHeader: `ts=${FIXED_TS};h1=${h1}`, secret, now: FIXED_NOW }), false);
});

test('rejects a signature made with the wrong secret', () => {
  const body = '{"x":1}';
  const h1 = sign(body, FIXED_TS, 'whsec_real');
  assert.equal(verifyPaddleSignature({ rawBody: body, signatureHeader: `ts=${FIXED_TS};h1=${h1}`, secret: 'whsec_wrong', now: FIXED_NOW }), false);
});

test('rejects a missing signature header', () => {
  assert.equal(verifyPaddleSignature({ rawBody: '{}', signatureHeader: '', secret: 'x', now: FIXED_NOW }), false);
});

test('rejects when no webhook secret is configured', () => {
  assert.equal(verifyPaddleSignature({ rawBody: '{}', signatureHeader: 'ts=1;h1=abcd', secret: '', now: FIXED_NOW }), false);
});

test('rejects a signature header missing the ts or h1 component instead of crashing on undefined', () => {
  assert.equal(verifyPaddleSignature({ rawBody: '{}', signatureHeader: 'h1=abcd', secret: 'x', now: FIXED_NOW }), false);
  assert.equal(verifyPaddleSignature({ rawBody: '{}', signatureHeader: 'ts=123', secret: 'x', now: FIXED_NOW }), false);
});

test('rejects a signature value of the wrong length instead of throwing in timingSafeEqual', () => {
  // timingSafeEqual itself throws on mismatched buffer lengths - a
  // truncated or otherwise wrong-length h1 (not just a wrong value) must
  // be rejected cleanly before ever reaching it, not crash the webhook
  // handler on a malformed/forged request.
  const secret = 'whsec_test';
  assert.equal(verifyPaddleSignature({ rawBody: '{}', signatureHeader: `ts=${FIXED_TS};h1=ab`, secret, now: FIXED_NOW }), false);
});

test('accepts a correctly signed payload with no explicit now (using the real current clock)', () => {
  // Without a caller-supplied `now`, the real call site (billing.js) relies
  // on the real wall clock - a genuinely fresh Paddle webhook arriving
  // right now must still verify correctly.
  const secret = 'whsec_test';
  const body = '{"event_type":"transaction.completed"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const h1 = sign(body, ts, secret);
  assert.equal(verifyPaddleSignature({ rawBody: body, signatureHeader: `ts=${ts};h1=${h1}`, secret }), true);
});

test('rejects an otherwise-valid signature whose timestamp is older than the allowed window', () => {
  // A correctly-signed request captured once (a compromised log, a replay
  // of a real past webhook) must not stay valid forever just because the
  // HMAC itself still checks out - this is the one thing standing between
  // a captured request and a signature that verifies indefinitely.
  const secret = 'whsec_test';
  const body = '{"event_type":"transaction.completed"}';
  const ts = String(Math.floor(Date.now() / 1000) - 10 * 60); // 10 minutes old
  const h1 = sign(body, ts, secret);
  assert.equal(verifyPaddleSignature({ rawBody: body, signatureHeader: `ts=${ts};h1=${h1}`, secret }), false);
});

test('rejects a timestamp suspiciously far in the future, not just an old one', () => {
  const secret = 'whsec_test';
  const body = '{"event_type":"transaction.completed"}';
  const ts = String(Math.floor(Date.now() / 1000) + 10 * 60); // 10 minutes ahead
  const h1 = sign(body, ts, secret);
  assert.equal(verifyPaddleSignature({ rawBody: body, signatureHeader: `ts=${ts};h1=${h1}`, secret }), false);
});

test('accepts a timestamp within the allowed window via a custom maxAgeSeconds', () => {
  const secret = 'whsec_test';
  const body = '{"event_type":"transaction.completed"}';
  const now = Date.now();
  const ts = String(Math.floor(now / 1000) - 30); // 30 seconds old
  const h1 = sign(body, ts, secret);
  assert.equal(verifyPaddleSignature({ rawBody: body, signatureHeader: `ts=${ts};h1=${h1}`, secret, now, maxAgeSeconds: 60 }), true);
  assert.equal(verifyPaddleSignature({ rawBody: body, signatureHeader: `ts=${ts};h1=${h1}`, secret, now, maxAgeSeconds: 10 }), false);
});

test('rejects a non-numeric ts instead of letting NaN silently defeat the age check', () => {
  const secret = 'whsec_test';
  const h1 = sign('{}', 'not-a-number', secret);
  assert.equal(verifyPaddleSignature({ rawBody: '{}', signatureHeader: `ts=not-a-number;h1=${h1}`, secret }), false);
});
