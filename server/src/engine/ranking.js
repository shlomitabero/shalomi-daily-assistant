// Ranks opportunities by a blend of profit, risk, capital tied up, time to
// cash, and data quality — never by raw revenue alone, per the explicit
// "don't just pick the highest possible income" requirement.
const RISK_WEIGHT = { low: 1, medium: 0.6, high: 0.25 };
const QUALITY_WEIGHT = { verified: 1, estimated: 0.6, unknown: 0.2 };

export function scoreOpportunity({ netProfitMid, capitalRequired, timeToCashDays, riskLevel, dataQuality }) {
  if (typeof netProfitMid !== 'number') return 0;
  const riskFactor = RISK_WEIGHT[riskLevel] ?? 0.2;
  const qualityFactor = QUALITY_WEIGHT[dataQuality] ?? 0.2;
  // A good opportunity ties up little capital and pays out soon — both
  // factors approach 0 as capital/time grow, so a big slow win is discounted
  // relative to a small fast one with the same profit.
  const capitalFactor = 1 / (1 + Math.max(0, capitalRequired ?? 0) / 100);
  const speedFactor = 1 / (1 + Math.max(0, timeToCashDays ?? 0) / 7);
  return netProfitMid * riskFactor * qualityFactor * capitalFactor * speedFactor;
}

export function rankOpportunities(opportunities) {
  return [...opportunities]
    .map((o) => ({ ...o, score: scoreOpportunity(o) }))
    .sort((a, b) => b.score - a.score);
}
