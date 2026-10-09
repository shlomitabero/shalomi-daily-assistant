import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyOwnerPassword, signOwnerToken, verifyOwnerToken } from './auth.js';

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
