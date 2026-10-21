import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login } from './auth.js';
import { verifyOwnerToken } from '../engine/auth.js';

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.statusCode ??= 200; return res; };
  return res;
}

function withOwnerPassword(password, fn) {
  const original = process.env.OWNER_PASSWORD;
  if (password === undefined) delete process.env.OWNER_PASSWORD;
  else process.env.OWNER_PASSWORD = password;
  try {
    return fn();
  } finally {
    if (original !== undefined) process.env.OWNER_PASSWORD = original;
    else delete process.env.OWNER_PASSWORD;
  }
}

test('login returns 503 instead of a confusing 401 when OWNER_PASSWORD is not configured yet', () => {
  withOwnerPassword(undefined, () => {
    const res = makeRes();
    login({ body: { password: 'anything' } }, res);
    assert.equal(res.statusCode, 503);
  });
});

test('login rejects the wrong password without issuing a token', () => {
  withOwnerPassword('the-real-password', () => {
    const res = makeRes();
    login({ body: { password: 'guess' } }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.token, undefined);
  });
});

test('login issues a real, verifiable owner token for the correct password', () => {
  withOwnerPassword('the-real-password', () => {
    const res = makeRes();
    login({ body: { password: 'the-real-password' } }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.token);
    assert.equal(verifyOwnerToken(res.body.token), true);
  });
});

test('login rejects a request with no password in the body instead of throwing', () => {
  withOwnerPassword('the-real-password', () => {
    const res = makeRes();
    login({ body: {} }, res);
    assert.equal(res.statusCode, 401);
  });
});
