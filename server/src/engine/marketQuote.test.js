import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuotePrice } from './marketQuote.js';

test('parses a normal numeric price', () => {
  assert.equal(parseQuotePrice({ price: '192.53' }), 192.53);
});

test('throws on a provider error response (code set)', () => {
  assert.throws(() => parseQuotePrice({ code: 400, message: 'invalid symbol' }), /invalid symbol/);
});

test('throws on a missing price', () => {
  assert.throws(() => parseQuotePrice({}), /unexpected market data response/);
});

test('throws instead of silently returning NaN for a non-numeric price', () => {
  // "N/A" is truthy, so a `!data.price` check alone would miss this —
  // Number("N/A") is NaN, which must never flow out of this function.
  assert.throws(() => parseQuotePrice({ price: 'N/A' }), /non-numeric price/);
});

test('throws instead of silently returning zero for an empty-string price', () => {
  // Number('') is 0 — a provider sending an empty string must not be
  // mistaken for a real $0 quote.
  assert.throws(() => parseQuotePrice({ price: '' }), /unexpected market data response/);
});
