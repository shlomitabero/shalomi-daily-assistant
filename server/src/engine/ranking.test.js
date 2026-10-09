import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreOpportunity, rankOpportunities } from './ranking.js';

const base = { netProfitMid: 100, capitalRequired: 50, timeToCashDays: 3, riskLevel: 'low', dataQuality: 'verified' };

test('higher profit scores higher, all else equal', () => {
  const low = scoreOpportunity({ ...base, netProfitMid: 50 });
  const high = scoreOpportunity({ ...base, netProfitMid: 100 });
  assert.ok(high > low);
});

test('a riskier opportunity scores lower than an equally profitable safe one', () => {
  const safe = scoreOpportunity({ ...base, riskLevel: 'low' });
  const risky = scoreOpportunity({ ...base, riskLevel: 'high' });
  assert.ok(safe > risky);
});

test('an opportunity requiring more capital scores lower, same profit', () => {
  const cheap = scoreOpportunity({ ...base, capitalRequired: 10 });
  const expensive = scoreOpportunity({ ...base, capitalRequired: 1000 });
  assert.ok(cheap > expensive);
});

test('a slower payout scores lower, same profit', () => {
  const fast = scoreOpportunity({ ...base, timeToCashDays: 1 });
  const slow = scoreOpportunity({ ...base, timeToCashDays: 60 });
  assert.ok(fast > slow);
});

test('unverified/unknown data quality scores lower than verified', () => {
  const verified = scoreOpportunity({ ...base, dataQuality: 'verified' });
  const unknown = scoreOpportunity({ ...base, dataQuality: 'unknown' });
  assert.ok(verified > unknown);
});

test('a missing netProfitMid scores zero rather than crashing or faking a number', () => {
  assert.equal(scoreOpportunity({ ...base, netProfitMid: undefined }), 0);
});

test('rankOpportunities sorts highest score first and a big-but-risky-and-slow deal can lose to a modest safe fast one', () => {
  const bigRiskySlow = { id: 'a', netProfitMid: 1000, capitalRequired: 5000, timeToCashDays: 90, riskLevel: 'high', dataQuality: 'unknown' };
  const smallSafeFast = { id: 'b', netProfitMid: 80, capitalRequired: 20, timeToCashDays: 1, riskLevel: 'low', dataQuality: 'verified' };
  const ranked = rankOpportunities([bigRiskySlow, smallSafeFast]);
  assert.equal(ranked[0].id, 'b');
  assert.ok(ranked[0].score > ranked[1].score);
});

test('a loss-making opportunity ranks below a profitable one', () => {
  const loss = { id: 'loss', netProfitMid: -50, capitalRequired: 10, timeToCashDays: 1, riskLevel: 'low', dataQuality: 'verified' };
  const profit = { id: 'profit', netProfitMid: 10, capitalRequired: 10, timeToCashDays: 1, riskLevel: 'low', dataQuality: 'verified' };
  const ranked = rankOpportunities([loss, profit]);
  assert.equal(ranked[0].id, 'profit');
});
