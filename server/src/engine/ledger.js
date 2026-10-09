// Summarizes the ledger into the numbers the dashboard shows, keeping a
// strict line between money that has actually moved (verified) and money
// that's merely expected (forecast/invoiced but not yet paid) — the
// "never blur forecast, order, payment-received, and profit" requirement.
export function summarizeLedger(entries, todayKey) {
  const todays = entries.filter((e) => e.date === todayKey);

  const cashInToday = sumAmounts(todays.filter((e) => e.type === 'revenue' && e.verified));
  const cashOutToday = sumAmounts(todays.filter((e) => e.type === 'cost' && e.verified));

  const outstandingReceivables = sumAmounts(entries.filter((e) => e.type === 'revenue' && !e.verified));
  const pendingObligations = sumAmounts(entries.filter((e) => e.type === 'cost' && !e.verified));

  const allTimeVerifiedRevenue = sumAmounts(entries.filter((e) => e.type === 'revenue' && e.verified));
  const allTimeVerifiedCost = sumAmounts(entries.filter((e) => e.type === 'cost' && e.verified));

  return {
    cashInToday: round2(cashInToday),
    cashOutToday: round2(cashOutToday),
    netProfitToday: round2(cashInToday - cashOutToday),
    outstandingReceivables: round2(outstandingReceivables),
    pendingObligations: round2(pendingObligations),
    netProfitAllTime: round2(allTimeVerifiedRevenue - allTimeVerifiedCost),
  };
}

function sumAmounts(entries) {
  return entries.reduce((total, e) => total + e.amount, 0);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
