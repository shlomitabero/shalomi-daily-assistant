// Turns a revenue estimate + cost breakdown into a net-profit estimate.
// Never fabricates a number: any missing revenue estimate or cost field is
// reported as missing rather than treated as zero, per the "don't invent
// prices or demand" requirement.
export function computeNetProfit({ revenueEstimate, costs = {} }) {
  const missing = [];
  if (!revenueEstimate || typeof revenueEstimate.low !== 'number' || typeof revenueEstimate.high !== 'number') {
    missing.push('revenueEstimate');
  }

  let totalCost = 0;
  for (const [key, value] of Object.entries(costs)) {
    if (value === null || value === undefined) missing.push(`cost:${key}`);
    else totalCost += value;
  }

  if (missing.length) {
    return { status: 'incomplete', missing, totalCost: null, netProfit: null };
  }

  const mid = revenueEstimate.mid ?? (revenueEstimate.low + revenueEstimate.high) / 2;
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
