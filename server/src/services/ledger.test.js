import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests } from '../db/store.js';
import { addLedgerEntry, totalSpentSoFar, totalLossSoFar, todayKey, getLedgerSummary } from './ledger.js';
import { makeId } from '../db/store.js';

test('todayKey returns the Israel-local calendar date, not the UTC one', () => {
  // This app is built throughout for a Hebrew-speaking, Israel-based owner
  // (Hebrew UI, ILS default currency, Paddle chosen for Israeli payouts).
  // For roughly 2 hours every day (Israel is ahead of UTC), the UTC
  // calendar date still reads "yesterday" while Israel's own has already
  // moved on to "today" - a bare toISOString().slice(0,10) would silently
  // undercount a sale or cost landing in that window from the dashboard's
  // "today" figures.
  assert.equal(todayKey(new Date('2026-01-01T22:30:00Z')), '2026-01-02'); // 00:30 Israel time (winter, UTC+2)
});

test('todayKey correctly accounts for Israel daylight saving (UTC+3 in summer)', () => {
  assert.equal(todayKey(new Date('2026-07-01T21:30:00Z')), '2026-07-02'); // 00:30 Israel time (summer, UTC+3)
});

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

test('totalSpentSoFar ignores a non-numeric amount instead of poisoning the total into NaN', () => {
  // canSpend() compares "spentSoFar + amount > budget" — NaN there is
  // always false, so a single corrupted entry would otherwise disable the
  // real-money budget gate entirely, letting every spend through.
  __resetForTests();
  addLedgerEntry({ type: 'cost', amount: 5, verified: true, description: 'ai' });
  db.ledger.insert({ id: 'led_bad', type: 'cost', amount: Number('not a number'), verified: true, description: 'corrupted', date: todayKey() });
  assert.equal(totalSpentSoFar(), 5);
  assert.ok(Number.isFinite(totalSpentSoFar()));
});

test('getLedgerSummary includes spentSoFar and lossSoFar, the exact figures canSpend() gates on', () => {
  // Until now the only way for the owner to see how close they were to
  // their configured budget/maxLoss was waiting for a real action to
  // actually get blocked - Dashboard.jsx needs these two figures to warn
  // before that happens.
  __resetForTests();
  addLedgerEntry({ type: 'cost', amount: 20, verified: true, description: 'ai' });
  addLedgerEntry({ type: 'revenue', amount: 8, verified: true, description: 'sale' });
  const summary = getLedgerSummary();
  assert.equal(summary.spentSoFar, 20);
  assert.equal(summary.lossSoFar, 12);
});

test('getLedgerSummary includes unrecordedSales, the count of real payments billing.js refused to record', () => {
  // billing.js's webhook handler logs a 'blocked: <error>' sale_confirmed
  // entry when a real transaction.completed event's amount/fee couldn't be
  // parsed - services/digest.js and Dashboard.jsx both need this count to
  // warn the owner that a real customer's real payment never made it into
  // the ledger above, with no route that ever retries or resolves it.
  __resetForTests();
  db.actions_log.insert({
    id: makeId('act'), type: 'sale_confirmed', detail: { opportunityId: 'opp_1', error: 'bad amount' },
    result: 'blocked: bad amount', createdAt: new Date().toISOString(),
  });
  db.actions_log.insert({
    id: makeId('act'), type: 'sale_confirmed', detail: { opportunityId: 'opp_2', amount: 10 },
    result: 'success', createdAt: new Date().toISOString(),
  });
  const summary = getLedgerSummary();
  assert.equal(summary.unrecordedSales, 1);
});

test('getLedgerSummary groups verified revenue by the opportunity source that produced it', () => {
  // Dashboard.jsx's "מקורות הכנסה" list needs to know which source
  // actually produced money vs. which only cost without result - this
  // sum has to cover the entire lifetime ledger (not just today), so it
  // must never silently drop an old entry the way a capped "recent N"
  // list safely could.
  __resetForTests();
  const oppA = db.opportunities.insert({ id: makeId('opp'), title: 'a', source: 'ai_digital_products' });
  const oppB = db.opportunities.insert({ id: makeId('opp'), title: 'b', source: 'financial_markets' });
  addLedgerEntry({ type: 'revenue', amount: 10, verified: true, description: 'sale 1', opportunityId: oppA.id });
  addLedgerEntry({ type: 'revenue', amount: 5, verified: true, description: 'sale 2', opportunityId: oppA.id });
  addLedgerEntry({ type: 'revenue', amount: 20, verified: true, description: 'sale 3', opportunityId: oppB.id });
  const summary = getLedgerSummary();
  assert.equal(summary.revenueBySource.ai_digital_products, 15);
  assert.equal(summary.revenueBySource.financial_markets, 20);
});

test('getLedgerSummary excludes unverified revenue and non-revenue entries from revenueBySource', () => {
  __resetForTests();
  const opp = db.opportunities.insert({ id: makeId('opp'), title: 'a', source: 'ai_digital_products' });
  addLedgerEntry({ type: 'revenue', amount: 100, verified: false, description: 'invoiced, not paid', opportunityId: opp.id });
  addLedgerEntry({ type: 'cost', amount: 5, verified: true, description: 'ai usage', opportunityId: opp.id });
  const summary = getLedgerSummary();
  assert.equal(summary.revenueBySource.ai_digital_products, undefined);
});

test('getLedgerSummary groups revenue with no matching opportunity under "unknown" instead of dropping it', () => {
  // There's no delete route for opportunities, but a corrupted/legacy
  // ledger entry pointing at an opportunityId that no longer resolves
  // must still be counted somewhere, not silently vanish from the total.
  __resetForTests();
  addLedgerEntry({ type: 'revenue', amount: 9, verified: true, description: 'sale', opportunityId: 'opp_missing' });
  const summary = getLedgerSummary();
  assert.equal(summary.revenueBySource.unknown, 9);
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
