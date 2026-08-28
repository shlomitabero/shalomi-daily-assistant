import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findNearestRival } from './rival.js';

const rows = [
  { profile_id: 'me', net_worth_at: 100_000 },
  { profile_id: 'far', net_worth_at: 5_000_000 },
  { profile_id: 'close', net_worth_at: 120_000 },
  { profile_id: 'closer_but_below', net_worth_at: 95_000 },
];

test('finds the competitor with the smallest net worth gap, excluding self', () => {
  const rival = findNearestRival('me', 100_000, rows);
  assert.equal(rival.profile_id, 'closer_but_below');
});

test('returns null when there are no other players', () => {
  assert.equal(findNearestRival('me', 100_000, [{ profile_id: 'me', net_worth_at: 100_000 }]), null);
});
