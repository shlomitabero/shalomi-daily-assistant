// Paddle sends the transaction total as a string of integer minor units
// (cents) in details.totals.total. A missing or malformed value must never
// silently become NaN and get written to the ledger — every future
// summarizeLedger()/totalSpentSoFar() reduce sums every entry's amount, so
// one NaN there would permanently poison every total derived from it, not
// just this one transaction.
export function extractTransactionAmount(txn) {
  const raw = txn?.details?.totals?.total;
  if (raw === undefined || raw === null) return 0;
  // Number('') is 0, which would hide a malformed payload as a real
  // zero-amount sale instead of surfacing it — reject it explicitly.
  if (typeof raw === 'string' && raw.trim() === '') {
    throw new Error(`transaction total is not a valid number: ${JSON.stringify(raw)}`);
  }
  const amount = Number(raw) / 100;
  if (!Number.isFinite(amount)) {
    throw new Error(`transaction total is not a valid number: ${JSON.stringify(raw)}`);
  }
  return amount;
}
