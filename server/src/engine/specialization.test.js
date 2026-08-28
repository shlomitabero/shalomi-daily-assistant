import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferSpecialization } from './specialization.js';

test('a brand-new player is a rising entrepreneur', () => {
  assert.equal(inferSpecialization({}), 'RISING ENTREPRENEUR');
});

test('2+ acquisitions makes you THE SHARK', () => {
  assert.equal(inferSpecialization({ acquisitions: 2 }), 'THE SHARK');
});

test('3+ properties makes you THE REAL ESTATE KING', () => {
  assert.equal(inferSpecialization({ properties: 3 }), 'THE REAL ESTATE KING');
});

test('the strongest qualifying signal wins when multiple qualify', () => {
  // 5 properties (strength 5) should beat 2 acquisitions (strength 2)
  const result = inferSpecialization({ acquisitions: 2, properties: 5 });
  assert.equal(result, 'THE REAL ESTATE KING');
});

test('organically founding 3+ businesses makes you THE BUILDER', () => {
  assert.equal(inferSpecialization({ organicBusinesses: 3 }), 'THE BUILDER');
});
