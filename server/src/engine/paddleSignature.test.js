import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyPaddleSignature } from './paddleSignature.js';

function sign(body, ts, secret) {
  return createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
}

test('accepts a correctly signed payload', () => {
  const secret = 'whsec_test';
  const body = '{"event_type":"subscription.created"}';
  const ts = '1700000000';
  const h1 = sign(body, ts, secret);
  assert.equal(verifyPaddleSignature({ rawBody: body, signatureHeader: `ts=${ts};h1=${h1}`, secret }), true);
});

test('rejects a tampered body', () => {
  const secret = 'whsec_test';
  const ts = '1700000000';
  const h1 = sign('{"event_type":"subscription.created"}', ts, secret);
  assert.equal(verifyPaddleSignature({ rawBody: '{"event_type":"x"}', signatureHeader: `ts=${ts};h1=${h1}`, secret }), false);
});

test('rejects a signature made with the wrong secret', () => {
  const body = '{"x":1}';
  const ts = '1700000000';
  const h1 = sign(body, ts, 'whsec_real');
  assert.equal(verifyPaddleSignature({ rawBody: body, signatureHeader: `ts=${ts};h1=${h1}`, secret: 'whsec_wrong' }), false);
});

test('rejects a missing signature header', () => {
  assert.equal(verifyPaddleSignature({ rawBody: '{}', signatureHeader: '', secret: 'x' }), false);
});

test('rejects when no webhook secret is configured', () => {
  assert.equal(verifyPaddleSignature({ rawBody: '{}', signatureHeader: 'ts=1;h1=abcd', secret: '' }), false);
});

test('rejects a signature header missing the ts or h1 component instead of crashing on undefined', () => {
  assert.equal(verifyPaddleSignature({ rawBody: '{}', signatureHeader: 'h1=abcd', secret: 'x' }), false);
  assert.equal(verifyPaddleSignature({ rawBody: '{}', signatureHeader: 'ts=123', secret: 'x' }), false);
});

test('rejects a signature value of the wrong length instead of throwing in timingSafeEqual', () => {
  // timingSafeEqual itself throws on mismatched buffer lengths - a
  // truncated or otherwise wrong-length h1 (not just a wrong value) must
  // be rejected cleanly before ever reaching it, not crash the webhook
  // handler on a malformed/forged request.
  const secret = 'whsec_test';
  const ts = '1700000000';
  assert.equal(verifyPaddleSignature({ rawBody: '{}', signatureHeader: `ts=${ts};h1=ab`, secret }), false);
});
