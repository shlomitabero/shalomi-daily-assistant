import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyOwnerPassword, signOwnerToken, verifyOwnerToken, resolveJwtSecret } from './auth.js';

test('verifyOwnerPassword rejects everything when OWNER_PASSWORD is unset', () => {
  const original = process.env.OWNER_PASSWORD;
  delete process.env.OWNER_PASSWORD;
  try {
    assert.equal(verifyOwnerPassword('anything'), false);
  } finally {
    if (original !== undefined) process.env.OWNER_PASSWORD = original;
  }
});

test('verifyOwnerPassword accepts the exact configured password and rejects anything else', () => {
  const original = process.env.OWNER_PASSWORD;
  process.env.OWNER_PASSWORD = 'correct-horse-battery-staple';
  try {
    assert.equal(verifyOwnerPassword('correct-horse-battery-staple'), true);
    assert.equal(verifyOwnerPassword('wrong'), false);
    assert.equal(verifyOwnerPassword(''), false);
  } finally {
    if (original !== undefined) process.env.OWNER_PASSWORD = original; else delete process.env.OWNER_PASSWORD;
  }
});

test('a token signed by signOwnerToken verifies as the owner', () => {
  const token = signOwnerToken();
  assert.equal(verifyOwnerToken(token), true);
});

test('a garbage token fails verification instead of throwing', () => {
  assert.equal(verifyOwnerToken('not-a-real-token'), false);
});

test('resolveJwtSecret uses the configured value as-is and never warns', () => {
  let warned = false;
  const secret = resolveJwtSecret('a-stable-configured-secret', { onFallback: () => { warned = true; } });
  assert.equal(secret, 'a-stable-configured-secret');
  assert.equal(warned, false);
});

test('resolveJwtSecret falls back to a random secret and warns when unset', () => {
  // A silent fallback here is what used to make every login session vanish
  // on each redeploy with zero indication why — the warning must fire.
  let warned = false;
  const secret = resolveJwtSecret(undefined, { onFallback: () => { warned = true; } });
  assert.equal(typeof secret, 'string');
  assert.ok(secret.length > 0);
  assert.equal(warned, true);
});

test('resolveJwtSecret falls back for an empty string too, not just undefined', () => {
  let warned = false;
  const secret = resolveJwtSecret('', { onFallback: () => { warned = true; } });
  assert.ok(secret.length > 0);
  assert.equal(warned, true);
});
