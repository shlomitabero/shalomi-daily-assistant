import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDefaultPriceUSD } from './pricing.js';

test('an unset env var falls back to the hard-coded default', () => {
  assert.equal(resolveDefaultPriceUSD(undefined), 9);
});

test('an empty string falls back instead of resolving to a free ($0) product', () => {
  // Number('') is 0 — without this guard every auto-created product would
  // silently be priced at zero.
  assert.equal(resolveDefaultPriceUSD(''), 9);
});

test('a non-numeric value falls back instead of becoming NaN', () => {
  assert.equal(resolveDefaultPriceUSD('nine dollars'), 9);
  assert.equal(resolveDefaultPriceUSD('$9'), 9);
});

test('zero or a negative value falls back instead of producing a free or negative price', () => {
  assert.equal(resolveDefaultPriceUSD('0'), 9);
  assert.equal(resolveDefaultPriceUSD('-5'), 9);
});

test('a valid positive numeric string is used as-is', () => {
  assert.equal(resolveDefaultPriceUSD('14.99'), 14.99);
});
