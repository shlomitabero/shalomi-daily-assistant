import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuotePrice } from './marketQuote.js';

test('parses a normal numeric price', () => {
  assert.equal(parseQuotePrice({ price: '192.53' }), 192.53);
});

test('throws a clean Hebrew message on a provider error response (code set), never the provider\'s own raw English text', () => {
  // The provider's raw data.message ('invalid symbol' here, but TwelveData's
  // real wording is often much longer/more technical) used to be thrown
  // verbatim and reached the owner unchanged via routes/financial.js's
  // `לא ניתן היה לקבל מחיר: ${err.message}` - untranslated English dropped
  // into an otherwise all-Hebrew error line, for the single most common
  // real reason this call fails (a typo'd or delisted symbol).
  assert.throws(() => parseQuotePrice({ code: 400, message: 'invalid symbol' }), /מקור נתוני השוק דחה/);
  assert.throws(() => parseQuotePrice({ code: 400, message: 'invalid symbol' }), (err) => !/invalid symbol/.test(err.message));
});

test('throws on a missing price', () => {
  assert.throws(() => parseQuotePrice({}), /תגובה לא צפויה/);
});

test('throws instead of silently returning NaN for a non-numeric price', () => {
  // "N/A" is truthy, so a `!data.price` check alone would miss this —
  // Number("N/A") is NaN, which must never flow out of this function.
  assert.throws(() => parseQuotePrice({ price: 'N/A' }), /מחיר שאינו מספר/);
});

test('throws instead of silently returning zero for an empty-string price', () => {
  // Number('') is 0 — a provider sending an empty string must not be
  // mistaken for a real $0 quote.
  assert.throws(() => parseQuotePrice({ price: '' }), /תגובה לא צפויה/);
});
