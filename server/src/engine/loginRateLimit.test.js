import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoginRateLimiter } from './loginRateLimit.js';

test('isBlocked is false before any failures are recorded', () => {
  const limiter = createLoginRateLimiter({ maxAttempts: 3, windowMs: 1000 });
  assert.equal(limiter.isBlocked('1.2.3.4'), false);
});

test('isBlocked becomes true only once failures reach the configured max', () => {
  const limiter = createLoginRateLimiter({ maxAttempts: 3, windowMs: 1000 });
  const now = 1_000_000;
  limiter.recordFailure('1.2.3.4', now);
  limiter.recordFailure('1.2.3.4', now);
  assert.equal(limiter.isBlocked('1.2.3.4', now), false);
  limiter.recordFailure('1.2.3.4', now);
  assert.equal(limiter.isBlocked('1.2.3.4', now), true);
});

test('a failure outside the rolling window no longer counts toward the block', () => {
  const limiter = createLoginRateLimiter({ maxAttempts: 2, windowMs: 1000 });
  limiter.recordFailure('1.2.3.4', 0);
  limiter.recordFailure('1.2.3.4', 500);
  assert.equal(limiter.isBlocked('1.2.3.4', 999), true);
  // Both failures are now older than windowMs (1000ms) relative to this
  // check - the block must lift on its own rather than persisting forever.
  assert.equal(limiter.isBlocked('1.2.3.4', 1600), false);
});

test('recordSuccess clears a key\'s failure history, lifting any block', () => {
  const limiter = createLoginRateLimiter({ maxAttempts: 2, windowMs: 1000 });
  const now = 1_000_000;
  limiter.recordFailure('1.2.3.4', now);
  limiter.recordFailure('1.2.3.4', now);
  assert.equal(limiter.isBlocked('1.2.3.4', now), true);
  limiter.recordSuccess('1.2.3.4');
  assert.equal(limiter.isBlocked('1.2.3.4', now), false);
});

test('different keys are tracked independently - one attacker never blocks another client', () => {
  const limiter = createLoginRateLimiter({ maxAttempts: 2, windowMs: 1000 });
  const now = 1_000_000;
  limiter.recordFailure('attacker-ip', now);
  limiter.recordFailure('attacker-ip', now);
  assert.equal(limiter.isBlocked('attacker-ip', now), true);
  assert.equal(limiter.isBlocked('owner-ip', now), false);
});
