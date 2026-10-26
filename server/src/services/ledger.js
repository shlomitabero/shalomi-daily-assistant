import { db, makeId } from '../db/store.js';
import { summarizeLedger } from '../engine/ledger.js';

export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function addLedgerEntry({ type, amount, verified, description, opportunityId = null, date = todayKey() }) {
  return db.ledger.insert({
    id: makeId('led'), type, amount, verified, description, opportunityId, date,
    createdAt: new Date().toISOString(),
  });
}

export function getLedgerSummary() {
  return summarizeLedger(db.ledger.all(), todayKey());
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
