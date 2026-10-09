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
  const tampered = '{"event_type":"subscription.canceled"}';
  assert.equal(verifyPaddleSignature({ rawBody: tampered, signatureHeader: `ts=${ts};h1=${h1}`, secret }), false);
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

test('rejects a header missing the h1 part', () => {
  assert.equal(verifyPaddleSignature({ rawBody: '{}', signatureHeader: 'ts=1700000000', secret: 'whsec_test' }), false);
});
