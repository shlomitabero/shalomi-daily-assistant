import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSpend } from './budget.js';

test('blocks all spend when the emergency stop is active, even within budget', () => {
  const result = canSpend({ amount: 1, budgetConfigured: true, budget: 1000, emergencyStop: true });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /emergency stop/);
});

test('blocks spend when no budget has ever been configured (budget defaults to zero)', () => {
  const result = canSpend({ amount: 1, budgetConfigured: false, budget: 0 });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /no budget/);
});

test('blocks a non-positive spend amount', () => {
  assert.equal(canSpend({ amount: 0, budgetConfigured: true, budget: 100 }).allowed, false);
  assert.equal(canSpend({ amount: -5, budgetConfigured: true, budget: 100 }).allowed, false);
});

test('blocks a spend that would exceed the configured budget', () => {
  const result = canSpend({ amount: 60, budgetConfigured: true, budget: 100, spentSoFar: 50 });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /exceed budget/);
});

test('blocks a spend that would exceed the max acceptable loss', () => {
  const result = canSpend({ amount: 30, budgetConfigured: true, budget: 1000, maxLoss: 100, lossSoFar: 90 });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /maximum acceptable loss/);
});

test('allows a spend within budget and loss limits', () => {
  const result = canSpend({ amount: 20, budgetConfigured: true, budget: 100, spentSoFar: 50, maxLoss: 100, lossSoFar: 10 });
  assert.deepEqual(result, { allowed: true, reason: null });
});

test('maxLoss is optional — omitting it only checks the budget', () => {
  const result = canSpend({ amount: 20, budgetConfigured: true, budget: 100, spentSoFar: 50 });
  assert.equal(result.allowed, true);
});
