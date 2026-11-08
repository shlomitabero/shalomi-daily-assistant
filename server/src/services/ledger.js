import { db, makeId } from '../db/store.js';
import { summarizeLedger } from '../engine/ledger.js';

// A bare new Date().toISOString().slice(0, 10) gives the UTC calendar date,
// not the owner's own - this app is built throughout for a Hebrew-speaking,
// Israel-based owner, and for roughly 2 hours every day (between Israel
// midnight and UTC midnight, since Israel is ahead of UTC) a sale or cost
// happening in that window would get dated "yesterday" here while the
// owner's own calendar had already moved on to "today" - silently
// undercounting the dashboard's "cash in/out today" for anything that
// landed in that gap. Every real-money date stamp in this app goes through
// this one function (addLedgerEntry's default below, and billing.js's
// webhook, which previously duplicated the UTC-only version inline).
export function todayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addLedgerEntry({ type, amount, verified, description, opportunityId = null, date = todayKey() }) {
  return db.ledger.insert({
    id: makeId('led'), type, amount, verified, description, opportunityId, date,
    createdAt: new Date().toISOString(),
  });
}

export function getLedgerSummary() {
  // spentSoFar/lossSoFar are the exact figures canSpend()'s real-money gate
  // already compares against settings.budget/maxLoss - until now the owner
  // had no way to see how close they were to either limit except by
  // waiting for a real action to actually get blocked. Dashboard.jsx uses
  // these to warn before that happens, not just after.
  return {
    ...summarizeLedger(db.ledger.all(), todayKey()),
    spentSoFar: totalSpentSoFar(), lossSoFar: totalLossSoFar(), unrecordedSales: countUnrecordedSales(),
    revenueBySource: revenueBySource(),
  };
}

// Dashboard.jsx used to fetch every ledger entry ever created via a
// separate /ledger/entries call and reduce them client-side just to show
// which source actually produced verified revenue - unlike actions/
// digests/approvals (capped "most recent N" lists, safe to truncate since
// an older row just scrolls off), this is a running sum over the ENTIRE
// lifetime ledger, so capping the entries sent to the client would
// silently understate a real total rather than just shortening a list -
// exactly the kind of wrong number this app promises never to show.
// Computing it here instead ships one small { source: total } object,
// with no correctness tradeoff: the server still sums every entry, it
// just never sends each raw row over the wire to do it.
function revenueBySource() {
  const bySource = {};
  for (const e of db.ledger.all()) {
    if (e.type !== 'revenue' || !e.verified || !e.opportunityId || !Number.isFinite(e.amount)) continue;
    const source = db.opportunities.get(e.opportunityId)?.source ?? 'unknown';
    bySource[source] = (bySource[source] ?? 0) + e.amount;
  }
  return bySource;
}

// billing.js's webhook handler logs a 'blocked: <error>' sale_confirmed
// entry when a real transaction.completed event's amount/fee couldn't be
// parsed - a real customer's real payment that never made it into the
// ledger above, and (unlike every other number on this page) no route
// ever retries or marks it resolved. Lives here, not just inside
// services/digest.js, so Dashboard.jsx can warn about it too without a
// second, separate API call - this is the one other place a real-money
// problem belongs alongside spentSoFar/lossSoFar.
function countUnrecordedSales() {
  return db.actions_log.where((a) => a.type === 'sale_confirmed' && String(a.result).startsWith('blocked')).length;
}

// A single non-numeric entry (corrupted data, a future caller that skips
// validation) must never turn the whole sum into NaN — canSpend() compares
// "spentSoFar + amount > budget", and NaN in that comparison is always
// false, so a poisoned total would silently let every spend through as if
// no budget cap existed at all. Entries that insert through this file's own
// addLedgerEntry()/billing.js's webhook already validate amount, but this
// is the actual value the real-money gate reads, so it gets the same
// fail-safe guard as summarizeLedger() rather than relying solely on every
// writer staying careful forever.
function sumVerifiedAmount(type) {
  return db.ledger
    .where((e) => e.type === type && e.verified)
    .reduce((t, e) => (Number.isFinite(e.amount) ? t + e.amount : t), 0);
}

export function totalSpentSoFar() {
  return sumVerifiedAmount('cost');
}

// Net realized loss: verified spend not yet recovered by verified revenue.
// Never negative — a profitable run has zero "loss" consumed, not a credit.
export function totalLossSoFar() {
  const cost = totalSpentSoFar();
  const revenue = sumVerifiedAmount('revenue');
  return Math.max(0, cost - revenue);
}
