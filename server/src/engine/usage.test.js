import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canGenerate, consumeGeneration, remainingGenerations, FREE_DAILY_LIMIT } from './usage.js';

test('a paid user always has unlimited generations', () => {
  assert.equal(remainingGenerations({ isPaid: true, generationsToday: 999, bonusGenerations: 0 }), Infinity);
  assert.equal(canGenerate({ isPaid: true, generationsToday: 999, bonusGenerations: 0 }), true);
});

test('a free user gets exactly FREE_DAILY_LIMIT generations with no bonus', () => {
  assert.equal(remainingGenerations({ isPaid: false, generationsToday: 0, bonusGenerations: 0 }), FREE_DAILY_LIMIT);
  assert.equal(remainingGenerations({ isPaid: false, generationsToday: FREE_DAILY_LIMIT, bonusGenerations: 0 }), 0);
  assert.equal(canGenerate({ isPaid: false, generationsToday: FREE_DAILY_LIMIT, bonusGenerations: 0 }), false);
});

test('bonus generations extend a free user past the daily limit', () => {
  assert.equal(remainingGenerations({ isPaid: false, generationsToday: FREE_DAILY_LIMIT, bonusGenerations: 3 }), 3);
  assert.equal(canGenerate({ isPaid: false, generationsToday: FREE_DAILY_LIMIT, bonusGenerations: 3 }), true);
});

test('consumeGeneration uses free daily quota before touching bonus credits', () => {
  const result = consumeGeneration({ isPaid: false, generationsToday: 1, bonusGenerations: 5 });
  assert.equal(result.bonusGenerationsUsed, 0);
});

test('consumeGeneration only spends a bonus credit once the daily quota is exhausted', () => {
  const result = consumeGeneration({ isPaid: false, generationsToday: FREE_DAILY_LIMIT, bonusGenerations: 5 });
  assert.equal(result.bonusGenerationsUsed, 1);
});

test('consumeGeneration throws if nothing is left (route layer must check canGenerate first)', () => {
  assert.throws(() => consumeGeneration({ isPaid: false, generationsToday: FREE_DAILY_LIMIT, bonusGenerations: 0 }));
});

test('a paid user consuming a generation never touches bonus credits', () => {
  const result = consumeGeneration({ isPaid: true, generationsToday: 50, bonusGenerations: 5 });
  assert.equal(result.bonusGenerationsUsed, 0);
});
