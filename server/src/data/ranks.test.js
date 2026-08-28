import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RANKS, rankForNetWorth, nextRank } from './ranks.js';

test('there are exactly 100 ranks with unique, ascending thresholds', () => {
  assert.equal(RANKS.length, 100);
  for (let i = 1; i < RANKS.length; i++) {
    assert.ok(RANKS[i].netWorthThreshold >= RANKS[i - 1].netWorthThreshold, `rank ${i + 1} threshold should not decrease`);
  }
  const titles = new Set(RANKS.map((r) => r.title));
  assert.equal(titles.size, 100, 'all rank titles should be unique');
});

test('rank 1 starts at $0 and rank 100 is THE SHARK', () => {
  assert.equal(RANKS[0].netWorthThreshold, 0);
  assert.equal(RANKS[99].title, 'THE SHARK');
  assert.equal(RANKS[99].rank, 100);
});

test('rankForNetWorth returns the highest rank the player qualifies for', () => {
  assert.equal(rankForNetWorth(0).rank, 1);
  assert.equal(rankForNetWorth(10000).tier, 'HUSTLER');
  assert.equal(rankForNetWorth(100_000_000_000).rank, 100);
});

test('nextRank returns null after rank 100', () => {
  assert.equal(nextRank(100), null);
  assert.equal(nextRank(1).rank, 2);
});
