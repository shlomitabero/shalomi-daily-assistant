import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyPaddleSignature } from './paddleSignature.js';

function sign(body, ts, secret) {
  return createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
}

// A fixed `now` matching the fixed `ts` below, so these tests stay fresh
// (within tolerance) forever rather than drifting stale as real time
// passes - the `now` injection exists in verifyPaddleSignature for
// exactly this.
const FIXED_NOW = 1700000000 * 1000;

test('accepts a correctly signed payload', () => {
  const secret = 'whsec_test';
  const body = '{"event_type":"subscription.created"}';
  const ts = '1700000000';
  const h1 = sign(body, ts, secret);
  assert.equal(verifyPaddleSignature({ rawBody: body, signatureHeader: `ts=${ts};h1=${h1}`, secret, now: FIXED_NOW }), true);
});

test('rejects a tampered body', () => {
  const secret = 'whsec_test';
  const ts = '1700000000';
  const h1 = sign('{"event_type":"subscription.created"}', ts, secret);
  assert.equal(verifyPaddleSignature({ rawBody: '{"event_type":"x"}', signatureHeader: `ts=${ts};h1=${h1}`, secret, now: FIXED_NOW }), false);
});

test('rejects a signature made with the wrong secret', () => {
  const body = '{"x":1}';
  const ts = '1700000000';
  const h1 = sign(body, ts, 'whsec_real');
  assert.equal(verifyPaddleSignature({ rawBody: body, signatureHeader: `ts=${ts};h1=${h1}`, secret: 'whsec_wrong', now: FIXED_NOW }), false);
});

test('rejects a missing signature header', () => {
  assert.equal(verifyPaddleSignature({ rawBody: '{}', signatureHeader: '', secret: 'x' }), false);
});

test('rejects when no webhook secret is configured', () => {
  assert.equal(verifyPaddleSignature({ rawBody: '{}', signatureHeader: 'ts=1;h1=abcd', secret: '' }), false);
});

test('rejects a correctly-signed but stale (replayed) payload', () => {
  // A valid (ts, body, signature) tuple from 10 minutes ago, verified
  // "now" - exactly what a captured-and-replayed delivery looks like.
  // Without a freshness check this passes forever; with one, it must not.
  const secret = 'whsec_test';
  const body = '{"event_type":"transaction.completed"}';
  const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
  const h1 = sign(body, tenMinutesAgo, secret);
  assert.equal(verifyPaddleSignature({ rawBody: body, signatureHeader: `ts=${tenMinutesAgo};h1=${h1}`, secret }), false);
});

test('accepts a payload signed just now, using the real default tolerance', () => {
  // No `now` override here - exercises the actual production default
  // (Date.now()), not just the injectable test path.
  const secret = 'whsec_test';
  const body = '{"event_type":"transaction.completed"}';
  const ts = Math.floor(Date.now() / 1000);
  const h1 = sign(body, ts, secret);
  assert.equal(verifyPaddleSignature({ rawBody: body, signatureHeader: `ts=${ts};h1=${h1}`, secret }), true);
});

test('rejects a timestamp claiming to be far in the future, not just stale ones', () => {
  // A one-sided check (only rejecting old timestamps) would let a forged
  // future timestamp slide through if an attacker ever got hold of a
  // valid signature for some reason - guard both directions.
  const secret = 'whsec_test';
  const body = '{"event_type":"transaction.completed"}';
  const tenMinutesFromNow = Math.floor(Date.now() / 1000) + 600;
  const h1 = sign(body, tenMinutesFromNow, secret);
  assert.equal(verifyPaddleSignature({ rawBody: body, signatureHeader: `ts=${tenMinutesFromNow};h1=${h1}`, secret }), false);
});

test('rejects a non-numeric timestamp instead of letting it through', () => {
  const secret = 'whsec_test';
  const body = '{}';
  const h1 = sign(body, 'not-a-number', secret);
  assert.equal(verifyPaddleSignature({ rawBody: body, signatureHeader: `ts=not-a-number;h1=${h1}`, secret }), false);
});
