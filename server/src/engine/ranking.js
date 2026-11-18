// Ranks opportunities by a blend of profit, risk, capital tied up, time to
// cash, and data quality — never by raw revenue alone, per the explicit
// "don't just pick the highest possible income" requirement.
const RISK_WEIGHT = { low: 1, medium: 0.6, high: 0.25 };
const QUALITY_WEIGHT = { verified: 1, estimated: 0.6, unknown: 0.2 };

export function scoreOpportunity({ netProfitMid, capitalRequired, timeToCashDays, riskLevel, dataQuality }) {
  // Number.isFinite, not typeof — typeof NaN is 'number' too, and a NaN
  // here (e.g. from a corrupted record) would otherwise propagate through
  // every factor below and make this opportunity sort unpredictably instead
  // of being treated the same as "no profit data".
  if (!Number.isFinite(netProfitMid)) return 0;
  const riskFactor = RISK_WEIGHT[riskLevel] ?? 0.2;
  const qualityFactor = QUALITY_WEIGHT[dataQuality] ?? 0.2;
  const safeCapital = Number.isFinite(capitalRequired) ? capitalRequired : 0;
  const safeTime = Number.isFinite(timeToCashDays) ? timeToCashDays : 0;
  // A good opportunity ties up little capital and pays out soon — both
  // factors approach 0 as capital/time grow, so a big slow win is discounted
  // relative to a small fast one with the same profit.
  const capitalFactor = 1 / (1 + Math.max(0, safeCapital) / 100);
  const speedFactor = 1 / (1 + Math.max(0, safeTime) / 7);
  const qualityMultiplier = riskFactor * qualityFactor * capitalFactor * speedFactor;
  // qualityMultiplier is always in (0, 1] - multiplying a PROFIT by it
  // correctly discounts a worse risk/quality/capital/speed profile (closer
  // to 0, scoring lower). But multiplying a LOSS (netProfitMid < 0) by the
  // same fraction does the opposite of what's intended: it pulls the loss
  // CLOSER to 0, so a worse profile would score a loss as "better" than an
  // equally-sized loss with a clean profile - the single worst draft by
  // every other measure could outrank the single best one, purely from
  // this sign artifact. services/digest.js's own `ranked[0]?.netProfitMid
  // > 0` guard was added specifically to keep that inverted ordering from
  // reaching its one recommendation slot, but said nothing about every
  // OTHER active opportunity still silently reordered by it - including on
  // routes/opportunities.js's listOpportunities, the API this app's own
  // Opportunities page and Dashboard preview render their display order
  // from directly, with no guard of their own. Dividing instead for a loss
  // keeps the direction consistent on both sides of zero: a worse profile
  // always makes the score worse, never better.
  return netProfitMid >= 0 ? netProfitMid * qualityMultiplier : netProfitMid / qualityMultiplier;
}

export function rankOpportunities(opportunities) {
  return [...opportunities]
    .map((o) => ({ ...o, score: scoreOpportunity(o) }))
    .sort((a, b) => b.score - a.score);
}
