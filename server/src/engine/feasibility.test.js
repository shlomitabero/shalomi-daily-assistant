import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNetProfit } from './feasibility.js';

test('computes a full profit range when revenue and all costs are known', () => {
  const result = computeNetProfit({
    revenueEstimate: { low: 100, mid: 150, high: 200 },
    costs: { acquisition: 20, advertising: 10 },
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.missing, []);
  assert.equal(result.totalCost, 30);
  assert.deepEqual(result.netProfit, { low: 70, mid: 120, high: 170 });
});

test('derives mid revenue as the midpoint when not given explicitly', () => {
  const result = computeNetProfit({ revenueEstimate: { low: 100, high: 200 }, costs: { advertising: 10 } });
  assert.equal(result.netProfit.mid, 140); // (100+200)/2 - 10
});

test('reports missing revenueEstimate instead of assuming zero', () => {
  const result = computeNetProfit({ revenueEstimate: null, costs: { advertising: 10 } });
  assert.equal(result.status, 'incomplete');
  assert.ok(result.missing.includes('revenueEstimate'));
  assert.equal(result.netProfit, null);
});

test('reports each unknown cost field by name instead of treating it as zero', () => {
  const result = computeNetProfit({
    revenueEstimate: { low: 100, high: 200 },
    costs: { advertising: 10, shipping: null, paymentProcessing: undefined },
  });
  assert.equal(result.status, 'incomplete');
  assert.ok(result.missing.includes('cost:shipping'));
  assert.ok(result.missing.includes('cost:paymentProcessing'));
  assert.equal(result.missing.includes('cost:advertising'), false);
});

test('a net loss is reported as a negative profit, not clamped to zero', () => {
  const result = computeNetProfit({ revenueEstimate: { low: 10, high: 20 }, costs: { advertising: 50 } });
  assert.equal(result.status, 'complete');
  assert.ok(result.netProfit.high < 0);
});
