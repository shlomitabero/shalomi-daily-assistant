import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTransactionAmount } from './paddleTransaction.js';

test('converts minor units (cents) to a major-unit amount', () => {
  assert.equal(extractTransactionAmount({ details: { totals: { total: '2900' } } }), 29);
});

test('a missing total defaults to zero instead of throwing', () => {
  assert.equal(extractTransactionAmount({ details: { totals: {} } }), 0);
  assert.equal(extractTransactionAmount({}), 0);
});

test('a non-numeric total throws instead of silently becoming NaN', () => {
  // Number('N/A') is NaN, and NaN would otherwise flow straight into the
  // ledger and poison every future summed total derived from it.
  assert.throws(() => extractTransactionAmount({ details: { totals: { total: 'N/A' } } }), /not a valid number/);
});

test('an empty-string total throws rather than silently resolving to zero', () => {
  // Number('') is 0, which would hide a malformed payload as a real
  // zero-amount sale instead of surfacing the problem.
  assert.throws(() => extractTransactionAmount({ details: { totals: { total: '' } } }), /not a valid number/);
});
