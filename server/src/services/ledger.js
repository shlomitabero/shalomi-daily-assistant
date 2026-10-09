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

export function totalSpentSoFar() {
  return db.ledger.where((e) => e.type === 'cost' && e.verified).reduce((t, e) => t + e.amount, 0);
}

// Net realized loss: verified spend not yet recovered by verified revenue.
// Never negative — a profitable run has zero "loss" consumed, not a credit.
export function totalLossSoFar() {
  const cost = totalSpentSoFar();
  const revenue = db.ledger.where((e) => e.type === 'revenue' && e.verified).reduce((t, e) => t + e.amount, 0);
  return Math.max(0, cost - revenue);
}
