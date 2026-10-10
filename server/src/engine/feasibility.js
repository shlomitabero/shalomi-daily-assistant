// Turns a revenue estimate + cost breakdown into a net-profit estimate.
// Never fabricates a number: any missing revenue estimate or cost field is
// reported as missing rather than treated as zero, per the "don't invent
// prices or demand" requirement.
export function computeNetProfit({ revenueEstimate, costs = {} }) {
  const missing = [];
  // Number.isFinite (not typeof) because typeof NaN is 'number' too — a
  // corrupted or malformed revenueEstimate.low/high must count as missing,
  // not pass this check and produce a NaN profit later.
  if (!revenueEstimate || !Number.isFinite(revenueEstimate.low) || !Number.isFinite(revenueEstimate.high)) {
    missing.push('revenueEstimate');
  }

  let totalCost = 0;
  for (const [key, value] of Object.entries(costs)) {
    if (value === null || value === undefined) missing.push(`cost:${key}`);
    // A non-numeric cost (e.g. a stray string) must never silently coerce
    // into string concatenation (0 + "abc") and poison every later total —
    // treat it the same as a missing cost instead.
    else if (!Number.isFinite(value)) missing.push(`cost:${key}`);
    else totalCost += value;
  }

  if (missing.length) {
    return { status: 'incomplete', missing, totalCost: null, netProfit: null };
  }

  // A non-finite mid must not corrupt netProfit.mid alone while low/high
  // stay valid — fall back to the midpoint instead of propagating a NaN.
  const mid = Number.isFinite(revenueEstimate.mid) ? revenueEstimate.mid : (revenueEstimate.low + revenueEstimate.high) / 2;
  return {
    status: 'complete',
    missing: [],
    totalCost: round2(totalCost),
    netProfit: {
      low: round2(revenueEstimate.low - totalCost),
      mid: round2(mid - totalCost),
      high: round2(revenueEstimate.high - totalCost),
    },
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
