// Shared presentational data for the "living city" layer (section 22, 29).
// Pure, DOM-free — deliberately kept separate from api.js so the city map,
// Home preview strip, and Empire tier icons all read from one source.

export const DISTRICTS = [
  { id: 'downtown', name: 'Downtown', icon: '🏙️', color: '#8b7cff', industries: ['retail', 'services'] },
  { id: 'food', name: 'Food District', icon: '🍔', color: '#fb923c', industries: ['food'] },
  { id: 'tech', name: 'Tech District', icon: '💻', color: '#38bdf8', industries: ['ecommerce', 'tech'] },
  { id: 'industrial', name: 'Industrial District', icon: '🏭', color: '#94a3b8', industries: ['car_detailing', 'manufacturing'] },
  { id: 'entertainment', name: 'Entertainment District', icon: '🎭', color: '#f472b6', industries: ['entertainment'] },
  { id: 'luxury', name: 'Luxury District', icon: '🏛️', color: '#f0b93d', industries: [], propertyKinds: ['landmark', 'hotel'] },
  { id: 'residential', name: 'Residential', icon: '🏘️', color: '#34d399', industries: [], propertyKinds: ['apartment'] },
  { id: 'port', name: 'Port & Logistics', icon: '🚢', color: '#60a5fa', industries: [], propertyKinds: ['office', 'retail'] },
];

export function districtForIndustry(industry) {
  return DISTRICTS.find((d) => d.industries.includes(industry)) ?? null;
}

export function districtForProperty(kind) {
  return DISTRICTS.find((d) => d.propertyKinds?.includes(kind)) ?? null;
}

// Visual progression of a business as it proves itself (section 29). Purely
// cosmetic — driven by the same valuation the economy engine already computes.
export const BUSINESS_TIERS = [
  { min: 0, icon: '🏪', label: 'Small Shop' },
  { min: 25_000, icon: '🏬', label: 'Premium Location' },
  { min: 150_000, icon: '⭐', label: 'Flagship' },
  { min: 750_000, icon: '🏢', label: 'Multi-Location Brand' },
  { min: 5_000_000, icon: '🏙️', label: 'International Franchise' },
];

export function businessTier(valuation) {
  let tier = BUSINESS_TIERS[0];
  for (const t of BUSINESS_TIERS) {
    if (valuation >= t.min) tier = t;
  }
  return tier;
}

// Visual status progression tied purely to rank tier — never purchasable,
// so it can never become pay-to-win (section 5).
export const STATUS_BY_TIER = {
  HUSTLER: { home: '🏠 Studio apartment', vehicle: '🚌 Public transit', hq: '📱 Kitchen table' },
  FOUNDER: { home: '🏠 Downtown rental', vehicle: '🚗 Used sedan', hq: '☕ Coffee shop desk' },
  OPERATOR: { home: '🏡 Nice apartment', vehicle: '🚙 Reliable SUV', hq: '🏢 Shared office' },
  INVESTOR: { home: '🏡 Loft', vehicle: '🚘 New car', hq: '🏢 Private office' },
  'DEAL MAKER': { home: '🏘️ Townhouse', vehicle: '🏎️ Sports car', hq: '🏢 Professional suite' },
  TYCOON: { home: '🏰 Luxury condo', vehicle: '🚁 Helicopter on call', hq: '🏢 Full office floor' },
  MOGUL: { home: '🏯 Penthouse', vehicle: '✈️ Chartered jet', hq: '🌆 Corporate tower' },
  SHARK: { home: '🌇 Sky penthouse', vehicle: '🛩️ Private jet', hq: '🌆 Signature tower' },
  TITAN: { home: '🏝️ Private estate', vehicle: '🛥️ Yacht + jet', hq: '🌇 Iconic headquarters' },
  LEGEND: { home: '🏝️ Private island', vehicle: '🚀 Fleet of everything', hq: '🌇 Global headquarters' },
  'THE SHARK': { home: '👑 The world', vehicle: '👑 The world', hq: '👑 The Shark Tower' },
};

export function statusForTier(tier) {
  return STATUS_BY_TIER[tier] ?? STATUS_BY_TIER.HUSTLER;
}
