import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyApiError } from './apiError.js';

test('a malformed JSON body (body-parser entity.parse.failed) is a clean 400, not 500', () => {
  const err = { type: 'entity.parse.failed', status: 400, expose: true, message: 'Unexpected token' };
  const result = classifyApiError(err);
  assert.equal(result.status, 400);
  assert.match(result.message, /not valid JSON/);
});

test('another body-parser client error marked expose:true keeps its own status and message', () => {
  const err = { status: 413, expose: true, message: 'request entity too large' };
  const result = classifyApiError(err);
  assert.equal(result.status, 413);
  assert.equal(result.message, 'request entity too large');
});

test('a 4xx error NOT marked expose:true still falls back to a generic 500', () => {
  // expose:true is the library's own signal that this message is safe to
  // show a client — without it, surfacing err.message could leak internals.
  const err = { status: 400, message: 'some internal detail' };
  const result = classifyApiError(err);
  assert.equal(result.status, 500);
});

test('a real application error (no status at all) is a generic 500', () => {
  const err = new Error('something broke in application code');
  const result = classifyApiError(err);
  assert.equal(result.status, 500);
  assert.equal(result.message, 'internal server error');
});

test('a null/undefined error does not throw and falls back to 500', () => {
  assert.doesNotThrow(() => classifyApiError(null));
  assert.equal(classifyApiError(null).status, 500);
  assert.equal(classifyApiError(undefined).status, 500);
});
