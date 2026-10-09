import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLedger } from './ledger.js';

const TODAY = '2026-10-09';
const YESTERDAY = '2026-10-08';

test('only verified entries count toward cash in/out today', () => {
  const entries = [
    { type: 'revenue', amount: 100, verified: true, date: TODAY },
    { type: 'revenue', amount: 50, verified: false, date: TODAY }, // pending, not cash yet
    { type: 'cost', amount: 20, verified: true, date: TODAY },
    { type: 'cost', amount: 15, verified: false, date: TODAY }, // invoiced, not paid yet
  ];
  const summary = summarizeLedger(entries, TODAY);
  assert.equal(summary.cashInToday, 100);
  assert.equal(summary.cashOutToday, 20);
  assert.equal(summary.netProfitToday, 80);
});

test('unverified revenue anywhere counts as an outstanding receivable, not today-filtered', () => {
  const entries = [
    { type: 'revenue', amount: 30, verified: false, date: YESTERDAY },
    { type: 'revenue', amount: 20, verified: false, date: TODAY },
  ];
  const summary = summarizeLedger(entries, TODAY);
  assert.equal(summary.outstandingReceivables, 50);
});

test('unverified costs anywhere counts as a pending obligation', () => {
  const entries = [{ type: 'cost', amount: 40, verified: false, date: YESTERDAY }];
  const summary = summarizeLedger(entries, TODAY);
  assert.equal(summary.pendingObligations, 40);
});

test('entries from a different day do not leak into today\'s cash figures', () => {
  const entries = [{ type: 'revenue', amount: 999, verified: true, date: YESTERDAY }];
  const summary = summarizeLedger(entries, TODAY);
  assert.equal(summary.cashInToday, 0);
});

test('netProfitAllTime only counts verified entries across all time', () => {
  const entries = [
    { type: 'revenue', amount: 100, verified: true, date: YESTERDAY },
    { type: 'revenue', amount: 100, verified: true, date: TODAY },
    { type: 'revenue', amount: 500, verified: false, date: TODAY },
    { type: 'cost', amount: 30, verified: true, date: TODAY },
  ];
  const summary = summarizeLedger(entries, TODAY);
  assert.equal(summary.netProfitAllTime, 170);
});

test('an empty ledger produces all zeros, not an error', () => {
  const summary = summarizeLedger([], TODAY);
  assert.deepEqual(summary, {
    cashInToday: 0, cashOutToday: 0, netProfitToday: 0,
    outstandingReceivables: 0, pendingObligations: 0, netProfitAllTime: 0,
  });
});
