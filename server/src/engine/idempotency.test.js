import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeIdempotencyKey, wasAlreadyPerformed } from './idempotency.js';

test('the same opportunity/action/day always produces the same key', () => {
  const a = makeIdempotencyKey({ opportunityId: 'opp_1', actionType: 'publish', dateKey: '2026-10-09' });
  const b = makeIdempotencyKey({ opportunityId: 'opp_1', actionType: 'publish', dateKey: '2026-10-09' });
  assert.equal(a, b);
});

test('a different opportunity, action, or day produces a different key', () => {
  const base = makeIdempotencyKey({ opportunityId: 'opp_1', actionType: 'publish', dateKey: '2026-10-09' });
  assert.notEqual(base, makeIdempotencyKey({ opportunityId: 'opp_2', actionType: 'publish', dateKey: '2026-10-09' }));
  assert.notEqual(base, makeIdempotencyKey({ opportunityId: 'opp_1', actionType: 'charge', dateKey: '2026-10-09' }));
  assert.notEqual(base, makeIdempotencyKey({ opportunityId: 'opp_1', actionType: 'publish', dateKey: '2026-10-10' }));
});

test('wasAlreadyPerformed detects a repeat and lets a new key through', () => {
  const key = makeIdempotencyKey({ opportunityId: 'opp_1', actionType: 'publish', dateKey: '2026-10-09' });
  assert.equal(wasAlreadyPerformed(key, [key]), true);
  assert.equal(wasAlreadyPerformed(key, []), false);
});
