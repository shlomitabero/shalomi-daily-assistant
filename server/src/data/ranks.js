// The 100-rank progression system. Ranks represent BUSINESS STATUS, not XP.
// Net worth thresholds are computed geometrically within each tier so the
// curve feels exponential (matching real wealth distribution) while every
// number stays deterministic and reproducible.

const TIERS = [
  { name: 'HUSTLER', from: 1, to: 10, startNW: 0, endNW: 50_000 },
  { name: 'FOUNDER', from: 11, to: 20, startNW: 50_000, endNW: 250_000 },
  { name: 'OPERATOR', from: 21, to: 30, startNW: 250_000, endNW: 1_000_000 },
  { name: 'INVESTOR', from: 31, to: 40, startNW: 1_000_000, endNW: 5_000_000 },
  { name: 'DEAL MAKER', from: 41, to: 50, startNW: 5_000_000, endNW: 25_000_000 },
  { name: 'TYCOON', from: 51, to: 60, startNW: 25_000_000, endNW: 100_000_000 },
  { name: 'MOGUL', from: 61, to: 70, startNW: 100_000_000, endNW: 500_000_000 },
  { name: 'SHARK', from: 71, to: 80, startNW: 500_000_000, endNW: 2_000_000_000 },
  { name: 'TITAN', from: 81, to: 90, startNW: 2_000_000_000, endNW: 20_000_000_000 },
  { name: 'LEGEND', from: 91, to: 99, startNW: 20_000_000_000, endNW: 100_000_000_000 },
  { name: 'THE SHARK', from: 100, to: 100, startNW: 100_000_000_000, endNW: 100_000_000_000 },
];

const TITLES = [
  'Street Hustler', 'Side Hustler', 'Corner Vendor', 'Grinder', 'Bootstrapper',
  'Scrapper', 'Trading Hustler', 'Cash Runner', 'Rising Hustler', 'Prime Hustler',
  'First-Time Founder', 'Startup Founder', 'Brand Builder', 'Small Biz Owner', 'Local Founder',
  'Growing Founder', 'Team Builder', 'Emerging Founder', 'Established Founder', 'Founder Prime',
  'Junior Operator', 'Multi-Site Operator', 'Ops Manager', 'Regional Operator', 'Chain Operator',
  'Systems Operator', 'Senior Operator', 'Franchise Operator', 'Elite Operator', 'Operator Prime',
  'Angel Investor', 'Stakeholder', 'Minority Partner', 'Portfolio Builder', 'Property Investor',
  'Capital Allocator', 'Diversified Investor', 'Syndicate Investor', 'Senior Investor', 'Investor Prime',
  'Junior Dealmaker', 'Acquisition Specialist', 'Merger Broker', 'Structured Financier', 'Leveraged Buyer',
  'Cross-Border Dealmaker', 'Senior Dealmaker', 'Master Negotiator', 'Elite Dealmaker', 'Dealmaker Prime',
  'Regional Tycoon', 'Industry Tycoon', 'Holding Company Chief', 'Multi-Brand Tycoon', 'Empire Builder',
  'Capital Tycoon', 'Market Leader', 'Dominant Tycoon', 'Elite Tycoon', 'Tycoon Prime',
  'Rising Mogul', 'National Mogul', 'Media Mogul', 'Real Estate Mogul', 'Global Expansion Mogul',
  'Brand Mogul', 'Industry-Shaping Mogul', 'Senior Mogul', 'Elite Mogul', 'Mogul Prime',
  'Junior Shark', 'Hostile Acquirer', 'Market Maker', 'Circling Shark', 'Apex Predator',
  'Feared Shark', 'Senior Shark', 'Elite Shark', 'Legendary Shark', 'Shark Prime',
  'Rising Titan', 'Capital Titan', 'Industry Titan', 'Global Titan', 'Market-Moving Titan',
  'Institutional Titan', 'Senior Titan', 'Elite Titan', 'World-Renowned Titan', 'Titan Prime',
  'Rising Legend', 'National Legend', 'Global Legend', 'Historic Legend', 'Immortal Legend',
  'World-Elite Legend', 'Senior Legend', 'Supreme Legend', 'Final Legend',
  'THE SHARK',
];

const MILESTONE_UNLOCKS = {
  1: 'Your first $10,000 and a choice of first business.',
  11: 'Hire your first employees. Register a real brand.',
  21: 'Open a second location. Manage teams and budgets.',
  31: 'Buy minority stakes in other players’ companies. First real estate.',
  41: 'Acquisitions, company sales, and mergers unlock.',
  51: 'Build a holding company. Control hundreds of employees.',
  61: 'Expand internationally. Enter media and major real estate.',
  71: 'Hostile acquisitions. Shark Deals unlock.',
  81: 'Influence entire industries and capital markets.',
  91: 'Join the world’s elite. Legacy Hall of Fame eligibility.',
  100: 'Global #1 eligibility. The rarest status in FROM ZERO.',
};

function tierUnlock(tierName) {
  const map = {
    HUSTLER: 'Learn buying, selling, and cash flow.',
    FOUNDER: 'Build your first real company and brand.',
    OPERATOR: 'Manage multiple locations, teams, and inventory.',
    INVESTOR: 'Invest in partnerships, stakes, and real estate.',
    'DEAL MAKER': 'Negotiate acquisitions and complex financing.',
    TYCOON: 'Control regional companies and large assets.',
    MOGUL: 'Expand internationally into major brands and media.',
    SHARK: 'Perform hostile acquisitions and control markets.',
    TITAN: 'Influence industries and capital markets at scale.',
    LEGEND: 'Compete among the world’s business elite.',
    'THE SHARK': 'The most successful business player in the world.',
  };
  return map[tierName] ?? '';
}

function thresholdForRank(rank, tier) {
  const span = tier.to - tier.from;
  if (span === 0) return tier.startNW;
  const t = (rank - tier.from) / span;
  if (tier.startNW === 0) {
    // linear for the very first tier (geometric interpolation breaks at 0)
    return Math.round(tier.startNW + t * (tier.endNW - tier.startNW));
  }
  const ratio = tier.endNW / tier.startNW;
  return Math.round(tier.startNW * Math.pow(ratio, t));
}

export const RANKS = TITLES.map((title, i) => {
  const rank = i + 1;
  const tier = TIERS.find((t) => rank >= t.from && rank <= t.to);
  return {
    rank,
    tier: tier.name,
    title,
    netWorthThreshold: thresholdForRank(rank, tier),
    unlock: MILESTONE_UNLOCKS[rank] ?? tierUnlock(tier.name),
  };
});

export function rankForNetWorth(netWorth) {
  let current = RANKS[0];
  for (const r of RANKS) {
    if (netWorth >= r.netWorthThreshold) current = r;
    else break;
  }
  return current;
}

export function nextRank(currentRank) {
  return RANKS.find((r) => r.rank === currentRank + 1) ?? null;
}

export const MILLION_MOMENTS = [
  { amount: 1_000_000, label: 'YOU ARE A MILLIONAIRE.' },
  { amount: 10_000_000, label: 'DOUBLE-DIGIT MILLIONS.' },
  { amount: 100_000_000, label: 'CENTIMILLIONAIRE.' },
  { amount: 1_000_000_000, label: 'YOU ARE A BILLIONAIRE.' },
  { amount: 10_000_000_000, label: 'DECABILLIONAIRE.' },
  { amount: 100_000_000_000, label: 'YOU ARE THE SHARK.' },
];
