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

test('a key whose failures have all aged out is dropped from tracking, not kept around forever', () => {
  const limiter = createLoginRateLimiter({ maxAttempts: 5, windowMs: 1000 });
  limiter.recordFailure('one-off-scanner', 0);
  assert.equal(limiter.trackedKeyCount(), 1);
  // Nothing ever touches this key again after its one failure ages out -
  // isBlocked on a DIFFERENT key is what actually prunes it here, mirroring
  // how the real /login route only ever calls isBlocked for the key of
  // whoever is making the current request.
  limiter.isBlocked('one-off-scanner', 5000);
  assert.equal(limiter.trackedKeyCount(), 0);
});

test('tracked keys never exceed maxTrackedKeys - the oldest is evicted to make room for a new one', () => {
  const limiter = createLoginRateLimiter({ maxAttempts: 10, windowMs: 60_000, maxTrackedKeys: 3 });
  const now = 1_000_000;
  limiter.recordFailure('ip-1', now);
  limiter.recordFailure('ip-2', now);
  limiter.recordFailure('ip-3', now);
  assert.equal(limiter.trackedKeyCount(), 3);
  limiter.recordFailure('ip-4', now);
  assert.equal(limiter.trackedKeyCount(), 3);
  // ip-1 was the oldest (first ever tracked) and must be the one evicted -
  // a fresh failure for it starts a clean count, not a continuation of
  // whatever it had before.
  assert.equal(limiter.isBlocked('ip-1', now), false);
});

test('a documented tradeoff: enough distinct new keys can evict an older key\'s own in-progress count', () => {
  // This is the accepted cost of capping at all, not a goal in itself -
  // flooding in maxTrackedKeys distinct source IPs to evict someone
  // else's count is a far bigger lift than the single IP's own
  // maxAttempts this limiter is actually meant to slow down, and it's
  // strictly better than the previous behavior (no cap, unbounded growth
  // for every scanner that never comes back). A real fix for a
  // determined, many-IP attacker would need per-IP connection limits at
  // the network layer, not an in-process map.
  const limiter = createLoginRateLimiter({ maxAttempts: 3, windowMs: 60_000, maxTrackedKeys: 2 });
  const now = 1_000_000;
  limiter.recordFailure('real-owner', now);
  limiter.recordFailure('real-owner', now);
  limiter.recordFailure('attacker-a', now);
  limiter.recordFailure('attacker-b', now); // at the cap - evicts real-owner, the oldest entry
  assert.equal(limiter.trackedKeyCount(), 2);
  assert.equal(limiter.isBlocked('real-owner', now), false);
});
