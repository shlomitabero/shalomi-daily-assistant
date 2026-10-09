import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReferralCode, shouldCreditReferral } from './referral.js';

test('createReferralCode produces codes of the requested length from the ambiguity-free alphabet', () => {
  const code = createReferralCode(Math.random, 7);
  assert.equal(code.length, 7);
  assert.match(code, /^[A-HJ-NP-Z2-9]+$/);
});

test('createReferralCode is deterministic given a deterministic rng', () => {
  const rng = () => 0;
  assert.equal(createReferralCode(rng, 4), 'AAAA');
});

test('shouldCreditReferral is false with no referrer', () => {
  assert.equal(shouldCreditReferral({ referrerId: null, newUserId: 'u1', newUserAlreadyReferred: false }), false);
});

test('shouldCreditReferral rejects self-referral', () => {
  assert.equal(shouldCreditReferral({ referrerId: 'u1', newUserId: 'u1', newUserAlreadyReferred: false }), false);
});

test('shouldCreditReferral rejects a user who already redeemed a code', () => {
  assert.equal(shouldCreditReferral({ referrerId: 'u1', newUserId: 'u2', newUserAlreadyReferred: true }), false);
});

test('shouldCreditReferral allows a legitimate new referral', () => {
  assert.equal(shouldCreditReferral({ referrerId: 'u1', newUserId: 'u2', newUserAlreadyReferred: false }), true);
});
