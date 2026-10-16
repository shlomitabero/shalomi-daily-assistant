import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests } from '../db/store.js';
import { addLedgerEntry, totalSpentSoFar, totalLossSoFar } from './ledger.js';

test('totalSpentSoFar only counts verified costs', () => {
  __resetForTests();
  addLedgerEntry({ type: 'cost', amount: 5, verified: true, description: 'ai' });
  addLedgerEntry({ type: 'cost', amount: 50, verified: false, description: 'pending invoice' });
  addLedgerEntry({ type: 'revenue', amount: 100, verified: true, description: 'sale' });
  assert.equal(totalSpentSoFar(), 5);
});

test('totalLossSoFar nets verified revenue against verified cost', () => {
  __resetForTests();
  addLedgerEntry({ type: 'cost', amount: 20, verified: true, description: 'ai' });
  addLedgerEntry({ type: 'revenue', amount: 8, verified: true, description: 'sale' });
  assert.equal(totalLossSoFar(), 12);
});

test('totalLossSoFar is never negative when revenue exceeds cost', () => {
  // This is the invariant execution.js's budget gate relies on: a profitable
  // run must read as zero loss, never a negative number a caller could
  // mistakenly treat as available extra budget.
  __resetForTests();
  addLedgerEntry({ type: 'cost', amount: 10, verified: true, description: 'ai' });
  addLedgerEntry({ type: 'revenue', amount: 100, verified: true, description: 'sale' });
  assert.equal(totalLossSoFar(), 0);
});

test('totalLossSoFar ignores unverified revenue when computing the loss', () => {
  // Forecast/invoiced-but-unpaid revenue must never mask a real loss —
  // otherwise the kill-switch/maxLoss gate could be fooled into allowing
  // spend that isn't actually backed by money received.
  __resetForTests();
  addLedgerEntry({ type: 'cost', amount: 30, verified: true, description: 'ai' });
  addLedgerEntry({ type: 'revenue', amount: 30, verified: false, description: 'invoiced, not paid' });
  assert.equal(totalLossSoFar(), 30);
});
