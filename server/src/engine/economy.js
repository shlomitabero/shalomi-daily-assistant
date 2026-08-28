// Deterministic economy engine (section 42). The AI/negotiation layer never
// touches money directly — it only produces decisions (accept/counter price,
// hire/fire) that get passed through these pure functions. Every function
// here is a pure transform: same inputs -> same outputs (modulo the injected
// rng, which tests pin for determinism).
import { INDUSTRIES } from '../data/industries.js';

const VALUATION_MULTIPLE = {
  food: 2.5, car_detailing: 3, ecommerce: 4,
  retail: 2.8, services: 3.2, entertainment: 3.5, manufacturing: 4.5, tech: 6,
};
const MARKETING_COST_PER_LEVEL_PER_DAY = 15;
const MISC_EXPENSE_RATIO = 0.04;
// A business's valuation ramps from what the player paid for it (100% basis)
// toward its full trailing-EBITDA multiple over this many days of operating
// history. Without this, a fresh acquisition briefly shows $0 valuation
// (net worth craters right after a good deal) and a single lucky day of
// trailing data can otherwise inflate a brand-new business to full value.
const VALUATION_RAMP_DAYS = 30;

export function newBusinessFromOpportunity({ id, owner_id, opportunity, name, costBasis100, brand }) {
  const industry = INDUSTRIES[opportunity.industry];
  const resolvedName = name || opportunity.name;
  return {
    id,
    owner_id,
    name: resolvedName,
    brand: brand || resolvedName, // franchised locations of the same brand share this
    industry: opportunity.industry,
    city: 'Zero City',
    stage: 'active',
    ownership_pct: 100,
    quality: opportunity.startingQuality ?? industry.baseCustomerScore,
    marketing_level: 1,
    inventory_level: 50,
    brand_value: 0,
    baseRevenuePerDay: opportunity.baseRevenuePerDay,
    baseRentPerDay: Math.round((opportunity.cost * industry.rentRatio) / 30),
    activeEffects: [],
    // Full-company value implied by what was paid — starter opportunities are
    // bought at 100%, so their sticker cost already is the 100% basis.
    cost_basis_100: costBasis100 ?? opportunity.cost,
    founded_at: new Date().toISOString(),
  };
}

function activeMultiplier(business, type, fallback = 1) {
  return business.activeEffects
    .filter((e) => e.type === type)
    .reduce((acc, e) => acc * e.value, fallback);
}

function activeAdd(business, type, fallback = 0) {
  return business.activeEffects
    .filter((e) => e.type === type)
    .reduce((acc, e) => acc + e.value, fallback);
}

export function applyEventEffect(business, effect) {
  if (effect.type === 'quality_hit') {
    business.quality = clamp(business.quality + effect.value, 0, 100);
    return business;
  }
  if (effect.type === 'brand_value_add') {
    business.brand_value += effect.value;
    return business;
  }
  if (effect.durationDays) {
    business.activeEffects.push({ ...effect, remainingDays: effect.durationDays });
    return business;
  }
  return business;
}

function tickEffects(business) {
  business.activeEffects = business.activeEffects
    .map((e) => ({ ...e, remainingDays: e.remainingDays - 1 }))
    .filter((e) => e.remainingDays > 0);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Global economic cycles (section 21) — these create real winners and
// losers rather than just flavor text on the feed. tech_bubble specifically
// juices the tech sector on top of the broad multiplier.
const MARKET_CYCLE_MULTIPLIER = { stable: 1, recession: 0.85, boom: 1.15, tech_bubble: 1.02, shortage: 0.92 };

// One simulated business day. `employees` is the list of active employees.
export function runDayForBusiness(business, employees, rng = Math.random, marketCycle = 'stable') {
  const industry = INDUSTRIES[business.industry];
  const qualityFactor = 0.5 + business.quality / 100; // 0.5 - 1.5
  const marketingFactor = 1 + (business.marketing_level - 1) * 0.15;
  const revenueMultiplier = activeMultiplier(business, 'revenue_multiplier');
  const cycleMultiplier = MARKET_CYCLE_MULTIPLIER[marketCycle] ?? 1;
  const techBubbleBoost = marketCycle === 'tech_bubble' && business.industry === 'tech' ? 1.35 : 1;
  const noise = 1 + industry.volatility * (rng() - 0.5) * 2;

  const revenue = Math.max(
    0,
    Math.round(
      business.baseRevenuePerDay * qualityFactor * marketingFactor * revenueMultiplier
      * cycleMultiplier * techBubbleBoost * noise,
    ),
  );

  const cogsRatio = industry.cogsRatio + activeAdd(business, 'cogs_add');
  const cogs = Math.round(revenue * cogsRatio);
  const rent = Math.round(business.baseRentPerDay * activeMultiplier(business, 'rent_multiplier'));
  const payroll = Math.round(employees.reduce((s, e) => s + e.salary_monthly, 0) / 30);
  const marketing = business.marketing_level * MARKETING_COST_PER_LEVEL_PER_DAY;
  const otherExpenses = Math.round(revenue * MISC_EXPENSE_RATIO);
  const ebitda = revenue - cogs - rent - payroll - marketing - otherExpenses;

  const customerScoreHit = activeAdd(business, 'customer_score_hit');
  const customerScore = Math.round(
    clamp(
      industry.baseCustomerScore + business.quality * 0.3 + (business.marketing_level - 1) * 2 + customerScoreHit,
      0,
      100,
    ),
  );

  tickEffects(business);

  return {
    period: null, // filled by caller with the day index
    revenue,
    cogs,
    payroll,
    rent,
    marketing,
    other_expenses: otherExpenses,
    ebitda,
    customer_score: customerScore,
  };
}

export function valuation(business, trailingFinancials) {
  const multiple = VALUATION_MULTIPLE[business.industry] ?? 3;
  const avgDailyEbitda = trailingFinancials.length
    ? trailingFinancials.reduce((s, f) => s + f.ebitda, 0) / trailingFinancials.length
    : 0;
  const runRateValuation = Math.max(0, avgDailyEbitda) * 30 * multiple + business.brand_value;

  const costBasis = business.cost_basis_100 ?? 0;
  const ramp = Math.min(1, trailingFinancials.length / VALUATION_RAMP_DAYS);
  return Math.round(costBasis + (runRateValuation - costBasis) * ramp);
}

export function computeNetWorth({ cash, businessValuations, propertyValues, loanBalances, investmentValues }) {
  const businessTotal = businessValuations.reduce((s, v) => s + v, 0);
  const propertyTotal = propertyValues.reduce((s, v) => s + v, 0);
  const investmentTotal = investmentValues.reduce((s, v) => s + v, 0);
  const debtTotal = loanBalances.reduce((s, v) => s + v, 0);
  return Math.round(cash + businessTotal + propertyTotal + investmentTotal - debtTotal);
}

export function accrueLoanInterest(loan, days = 1) {
  const dailyRate = loan.annual_rate / 365;
  const interest = loan.balance * dailyRate * days;
  return Math.round((loan.balance + interest) * 100) / 100;
}

export function loanPayment(loan, amount) {
  return Math.max(0, Math.round((loan.balance - amount) * 100) / 100);
}

export function hireCostImpact(salaryMonthly, skill) {
  // Skilled hires lift quality faster but cost more — a real tradeoff.
  const qualityBoost = Math.round(2 + skill / 25);
  return { qualityBoost };
}
