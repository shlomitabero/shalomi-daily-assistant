// Paddle sends money fields as a string of integer minor units (cents)
// under details.totals. A missing or malformed value must never silently
// become NaN and get written to the ledger — every future
// summarizeLedger()/totalSpentSoFar() reduce sums every entry's amount, so
// one NaN there would permanently poison every total derived from it, not
// just this one transaction.
function extractMinorUnitsField(raw, fieldLabel) {
  if (raw === undefined || raw === null) return 0;
  // Number('') is 0, which would hide a malformed payload as a real
  // zero-amount value instead of surfacing it — reject it explicitly.
  if (typeof raw === 'string' && raw.trim() === '') {
    throw new Error(`${fieldLabel} is not a valid number: ${JSON.stringify(raw)}`);
  }
  const amount = Number(raw) / 100;
  if (!Number.isFinite(amount)) {
    throw new Error(`${fieldLabel} is not a valid number: ${JSON.stringify(raw)}`);
  }
  // A completed sale's own total/fee can never legitimately be negative -
  // same reasoning already applied to a cost on PATCH /opportunities/:id
  // ("a cost is money going out and can never be negative"). Unlike that
  // owner-entered field, this comes from a third-party webhook payload, so
  // the risk is a malformed/corrupted response rather than a typo - but
  // billing.js inserts this value straight into the ledger as a verified,
  // real transaction, with no review step before it ever reaches
  // totalSpentSoFar()/cashInToday. A negative value slipping through would
  // silently flip a cost into a credit or a sale into a loss, poisoning
  // every total derived from it.
  if (amount < 0) {
    throw new Error(`${fieldLabel} is not a valid number: ${JSON.stringify(raw)}`);
  }
  return amount;
}

export function extractTransactionAmount(txn) {
  return extractMinorUnitsField(txn?.details?.totals?.total, 'transaction total');
}

// details.totals.fee is Paddle's own real platform fee for this sale —
// per Paddle's docs it stays null until the transaction actually completes
// (exactly the event this is read from), so a missing/null value here is
// normal, not a malformed payload, and safely resolves to "no fee" (0).
export function extractTransactionFee(txn) {
  return extractMinorUnitsField(txn?.details?.totals?.fee, 'transaction fee');
}
