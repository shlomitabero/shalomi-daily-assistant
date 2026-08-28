import { Router } from 'express';
import { db, makeId, getMarketState, setMarketState } from '../db/store.js';
import { STARTER_OPPORTUNITIES, GROWTH_OPPORTUNITIES } from '../data/industries.js';
import { rankForNetWorth } from '../data/ranks.js';
import { rollEvent } from '../data/events.js';
import { pickDecisionEvent } from '../data/decisionEvents.js';
import { resolveDecision } from '../engine/decisions.js';
import {
  newBusinessFromOpportunity,
  runDayForBusiness,
  applyEventEffect,
  accrueLoanInterest,
  valuation,
} from '../engine/economy.js';
import {
  getFullPlayerState,
  recomputeNetWorthAndRank,
  addLegacy,
  recordIfBigger,
  pushWorldFeed,
  formatCompact,
} from '../services/playerState.js';

export const businessRouter = Router();

const MARKETING_COST_PER_LEVEL = 2000;
const HIRE_COST = 300;
const EVENT_PROBABILITY_PER_BUSINESS_DAY = 0.35;
const DECISION_EVENT_PROBABILITY_PER_BUSINESS_DAY = 0.15;
const BANKRUPTCY_CASH_FLOOR = -5000;

function requireProfile(req, res) {
  const profile = db.profiles.get(req.params.id);
  if (!profile) {
    res.status(404).json({ error: 'player not found' });
    return null;
  }
  return profile;
}

businessRouter.get('/opportunities', (req, res) => {
  res.json({ opportunities: STARTER_OPPORTUNITIES });
});

businessRouter.get('/players/:id/opportunities', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const rank = rankForNetWorth(db.player_rank.get(profile.id)?.net_worth_at ?? 10000).rank;
  const unlocked = GROWTH_OPPORTUNITIES.filter((o) => rank >= o.minRank);
  const locked = GROWTH_OPPORTUNITIES.filter((o) => rank < o.minRank);
  res.json({ opportunities: [...STARTER_OPPORTUNITIES, ...unlocked], locked });
});

businessRouter.post('/players/:id/businesses', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const { opportunityId } = req.body ?? {};
  const opportunity = [...STARTER_OPPORTUNITIES, ...GROWTH_OPPORTUNITIES].find((o) => o.id === opportunityId);
  if (!opportunity) return res.status(400).json({ error: 'unknown opportunity' });
  const currentRank = rankForNetWorth(db.player_rank.get(profile.id)?.net_worth_at ?? 10000).rank;
  if (opportunity.minRank && currentRank < opportunity.minRank) {
    return res.status(400).json({ error: `requires rank ${opportunity.minRank} (you're rank ${currentRank})` });
  }
  if (profile.cash < opportunity.cost) return res.status(400).json({ error: 'not enough cash' });

  const isFirstEver = db.businesses.where((b) => b.owner_id === profile.id).length === 0;
  const business = newBusinessFromOpportunity({ id: makeId('biz'), owner_id: profile.id, opportunity });
  db.businesses.insert(business);
  db.profiles.update(profile.id, { cash: profile.cash - opportunity.cost });
  db.transactions.insert({
    id: makeId('txn'), profile_id: profile.id, kind: 'acquisition', amount: -opportunity.cost,
    memo: `Bought ${business.name}`, ref_id: business.id, created_at: new Date().toISOString(),
  });
  if (isFirstEver) addLegacy(profile.id, 'first_company', `First company: ${business.name}.`, opportunity.cost);
  recordIfBigger(profile.id, 'biggest_deal', `Biggest deal: bought ${business.name} for ${formatCompact(opportunity.cost)}.`, opportunity.cost);
  pushWorldFeed(`${profile.display_name} opened ${business.name}.`, profile.id, 'launch', opportunity.cost);

  const result = recomputeNetWorthAndRank(profile.id);
  res.status(201).json({ business, ...result });
});

businessRouter.get('/players/:id/businesses/:bizId', (req, res) => {
  const business = db.businesses.get(req.params.bizId);
  if (!business || business.owner_id !== req.params.id) return res.status(404).json({ error: 'business not found' });
  const financials = db.business_financials.where((f) => f.business_id === business.id).sort((a, b) => a.period - b.period);
  const employees = db.employees.where((e) => e.business_id === business.id);
  res.json({ business, financials: financials.slice(-30), employees });
});

businessRouter.post('/players/:id/businesses/:bizId/hire', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const business = db.businesses.get(req.params.bizId);
  if (!business || business.owner_id !== profile.id) return res.status(404).json({ error: 'business not found' });
  const { role, name, salaryMonthly, skill } = req.body ?? {};
  if (!role || !name || !(salaryMonthly > 0)) return res.status(400).json({ error: 'role, name, salaryMonthly required' });
  if (profile.cash < HIRE_COST) return res.status(400).json({ error: 'not enough cash to hire' });

  const boundedSkill = Math.max(1, Math.min(100, Number(skill) || 50));
  const employee = db.employees.insert({
    id: makeId('emp'), business_id: business.id, role, name, salary_monthly: Number(salaryMonthly),
    skill: boundedSkill, loyalty: 50, hired_at: new Date().toISOString(), terminated_at: null,
  });
  db.businesses.update(business.id, { quality: Math.min(100, business.quality + 2 + Math.round(boundedSkill / 25)) });
  db.profiles.update(profile.id, { cash: profile.cash - HIRE_COST });
  const result = recomputeNetWorthAndRank(profile.id);
  res.status(201).json({ employee, ...result });
});

businessRouter.post('/players/:id/businesses/:bizId/fire', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const business = db.businesses.get(req.params.bizId);
  if (!business || business.owner_id !== profile.id) return res.status(404).json({ error: 'business not found' });
  const { employeeId } = req.body ?? {};
  const employee = db.employees.get(employeeId);
  if (!employee || employee.business_id !== business.id) return res.status(404).json({ error: 'employee not found' });
  db.employees.update(employeeId, { terminated_at: new Date().toISOString() });
  db.businesses.update(business.id, { quality: Math.max(0, business.quality - 5) });
  const result = recomputeNetWorthAndRank(profile.id);
  res.json({ ok: true, ...result });
});

businessRouter.post('/players/:id/businesses/:bizId/marketing', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const business = db.businesses.get(req.params.bizId);
  if (!business || business.owner_id !== profile.id) return res.status(404).json({ error: 'business not found' });
  const cost = business.marketing_level * MARKETING_COST_PER_LEVEL;
  if (profile.cash < cost) return res.status(400).json({ error: 'not enough cash' });
  db.businesses.update(business.id, { marketing_level: business.marketing_level + 1 });
  db.profiles.update(profile.id, { cash: profile.cash - cost });
  const result = recomputeNetWorthAndRank(profile.id);
  res.json({ business: db.businesses.get(business.id), ...result });
});

businessRouter.post('/players/:id/businesses/:bizId/sell', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const business = db.businesses.get(req.params.bizId);
  if (!business || business.owner_id !== profile.id) return res.status(404).json({ error: 'business not found' });
  if (business.stage !== 'active') return res.status(400).json({ error: 'business not active' });

  const financials = db.business_financials.where((f) => f.business_id === business.id).slice(-30);
  const salePrice = valuation(business, financials);

  db.businesses.update(business.id, { stage: 'sold' });
  db.profiles.update(profile.id, { cash: profile.cash + salePrice });
  db.transactions.insert({
    id: makeId('txn'), profile_id: profile.id, kind: 'sale', amount: salePrice,
    memo: `Sold ${business.name}`, ref_id: business.id, created_at: new Date().toISOString(),
  });
  addLegacy(profile.id, 'first_sale', `Sold ${business.name} for $${formatCompact(salePrice)}.`, salePrice);
  recordIfBigger(profile.id, 'biggest_deal', `Biggest deal: sold ${business.name} for ${formatCompact(salePrice)}.`, salePrice);
  pushWorldFeed(`${profile.display_name} sold ${business.name} for $${formatCompact(salePrice)}.`, profile.id, 'sale', salePrice);

  const result = recomputeNetWorthAndRank(profile.id);
  res.json({ salePrice, ...result });
});

const FRANCHISE_MIN_RANK = 10;
const FRANCHISE_COST_MULTIPLIER = 0.85; // a proven concept costs a little less to replicate

businessRouter.post('/players/:id/businesses/:bizId/franchise', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const business = db.businesses.get(req.params.bizId);
  if (!business || business.owner_id !== profile.id) return res.status(404).json({ error: 'business not found' });
  if (business.stage !== 'active') return res.status(400).json({ error: 'business not active' });

  const currentRank = rankForNetWorth(db.player_rank.get(profile.id)?.net_worth_at ?? 10000).rank;
  if (currentRank < FRANCHISE_MIN_RANK) {
    return res.status(400).json({ error: `opening a second location requires rank ${FRANCHISE_MIN_RANK} (you're rank ${currentRank})` });
  }

  const cost = Math.round(business.cost_basis_100 * FRANCHISE_COST_MULTIPLIER);
  if (profile.cash < cost) return res.status(400).json({ error: 'not enough cash' });

  const brand = business.brand ?? business.name;
  const locationCount = db.businesses.where((b) => b.owner_id === profile.id && (b.brand ?? b.name) === brand).length;
  const newLocation = newBusinessFromOpportunity({
    id: makeId('biz'), owner_id: profile.id, brand,
    name: `${brand} #${locationCount + 1}`,
    opportunity: {
      industry: business.industry, cost: business.cost_basis_100, baseRevenuePerDay: business.baseRevenuePerDay,
      startingQuality: Math.max(30, business.quality - 15),
    },
    costBasis100: cost,
  });
  db.businesses.insert(newLocation);
  db.profiles.update(profile.id, { cash: profile.cash - cost });
  db.transactions.insert({
    id: makeId('txn'), profile_id: profile.id, kind: 'acquisition', amount: -cost,
    memo: `Franchised ${newLocation.name}`, ref_id: newLocation.id, created_at: new Date().toISOString(),
  });
  addLegacy(profile.id, 'first_franchise', `Opened a second location: ${newLocation.name}.`, cost);
  pushWorldFeed(`${profile.display_name} opened ${newLocation.name}, a new ${brand} location.`, profile.id, 'launch', cost);

  const result = recomputeNetWorthAndRank(profile.id);
  res.status(201).json({ business: newLocation, ...result });
});

businessRouter.post('/players/:id/advance-day', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;

  let cash = profile.cash;
  const dayEvents = [];
  const businesses = db.businesses.where((b) => b.owner_id === profile.id && b.stage === 'active');
  const marketCycle = getMarketState().cycle;

  for (const business of businesses) {
    const employees = db.employees.where((e) => e.business_id === business.id && !e.terminated_at);
    const liveBusiness = { ...business, activeEffects: business.activeEffects ?? [] };
    const day = runDayForBusiness(liveBusiness, employees, Math.random, marketCycle);
    const period = db.business_financials.where((f) => f.business_id === business.id).length + 1;
    db.business_financials.insert({
      id: makeId('fin'), business_id: business.id, ...day, period, created_at: new Date().toISOString(),
    });
    cash += day.ebitda;
    if (day.ebitda < 0) {
      recordIfBigger(profile.id, 'biggest_loss', `Lost ${formatCompact(-day.ebitda)} in a single day at ${business.name}.`, -day.ebitda);
    }

    if (Math.random() < EVENT_PROBABILITY_PER_BUSINESS_DAY) {
      const evt = rollEvent();
      applyEventEffect(liveBusiness, evt.effect);
      if (evt.effect.type === 'cash_loss') cash -= evt.effect.value;
      if (evt.effect.type === 'market_shift') setMarketState({ cycle: evt.effect.value });
      db.businesses.update(business.id, {
        quality: liveBusiness.quality,
        brand_value: liveBusiness.brand_value,
        activeEffects: liveBusiness.activeEffects,
      });
      const eventRow = db.events.insert({
        id: makeId('evt'), profile_id: profile.id, business_id: business.id, kind: evt.id,
        description: evt.headline(business), impact: evt.effect, resolved: false, created_at: new Date().toISOString(),
      });
      dayEvents.push(eventRow);
      if (['evt_viral_moment', 'evt_below_market_property', 'evt_recession_warning'].includes(evt.id)) {
        pushWorldFeed(evt.headline(business), profile.id, 'event');
      }
    } else {
      db.businesses.update(business.id, { activeEffects: liveBusiness.activeEffects });
    }

    const hasPendingDecision = db.events.where(
      (e) => e.business_id === business.id && !e.resolved && e.impact?.decisionId,
    ).length > 0;
    if (!hasPendingDecision && employees.length > 0 && Math.random() < DECISION_EVENT_PROBABILITY_PER_BUSINESS_DAY) {
      const template = pickDecisionEvent();
      const employee = employees[Math.floor(Math.random() * employees.length)];
      const decisionRow = db.events.insert({
        id: makeId('evt'), profile_id: profile.id, business_id: business.id, kind: template.id,
        description: template.headline(business, employee),
        impact: { decisionId: template.id, employeeId: employee.id, options: template.options },
        resolved: false, created_at: new Date().toISOString(),
      });
      dayEvents.push(decisionRow);
    }
  }

  // Economic cycles are self-correcting — a recession or boom eventually
  // gives way back to a stable market rather than compounding forever.
  if (marketCycle !== 'stable' && Math.random() < 0.08) setMarketState({ cycle: 'stable' });

  for (const property of db.properties.where((p) => p.owner_id === profile.id)) {
    cash += property.monthly_income / 30;
  }
  for (const loan of db.loans.where((l) => l.profile_id === profile.id && l.status === 'active')) {
    db.loans.update(loan.id, { balance: accrueLoanInterest(loan, 1) });
  }

  let bankrupt = false;
  if (cash < BANKRUPTCY_CASH_FLOOR) {
    for (const b of businesses) db.businesses.update(b.id, { stage: 'bankrupt' });
    for (const l of db.loans.where((l) => l.profile_id === profile.id && l.status === 'active')) {
      db.loans.update(l.id, { status: 'defaulted' });
    }
    cash = 1000;
    bankrupt = true;
    addLegacy(profile.id, 'first_bankruptcy', `${profile.display_name} went bankrupt and started over.`, 0);
    pushWorldFeed(`${profile.display_name} filed for bankruptcy.`, profile.id, 'bankruptcy');
  }

  db.profiles.update(profile.id, { cash: Math.round(cash * 100) / 100, age_days: profile.age_days + 1 });
  const result = recomputeNetWorthAndRank(profile.id);
  res.json({ dayEvents, bankrupt, market: getMarketState(), ...result, state: getFullPlayerState(profile.id) });
});

businessRouter.post('/players/:id/events/:eventId/dismiss', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const event = db.events.get(req.params.eventId);
  if (!event || event.profile_id !== profile.id) return res.status(404).json({ error: 'event not found' });
  db.events.update(event.id, { resolved: true });
  res.json({ ok: true });
});

// The Decision Engine (section 11): a fixed set of buttons, or free text —
// either way it resolves to one of the same deterministic outcomes.
businessRouter.post('/players/:id/events/:eventId/decide', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const event = db.events.get(req.params.eventId);
  if (!event || event.profile_id !== profile.id) return res.status(404).json({ error: 'event not found' });
  if (event.resolved) return res.status(400).json({ error: 'already resolved' });
  if (!event.impact?.decisionId) return res.status(400).json({ error: 'this event has no decision to make' });

  const business = db.businesses.get(event.business_id);
  const employee = db.employees.get(event.impact.employeeId);

  if (!business || !employee || employee.terminated_at) {
    db.events.update(event.id, { resolved: true });
    return res.json({ ok: true, resultText: 'This no longer applies — they already left.' });
  }

  const { choice, text } = req.body ?? {};
  const outcome = resolveDecision({ choice, freeText: text, employeeName: employee.name });

  if (outcome.fired) {
    db.employees.update(employee.id, { terminated_at: new Date().toISOString() });
  } else {
    db.employees.update(employee.id, {
      salary_monthly: Math.round(employee.salary_monthly * outcome.salaryMultiplier),
      loyalty: Math.max(0, Math.min(100, employee.loyalty + outcome.loyaltyDelta)),
    });
  }
  db.businesses.update(business.id, {
    quality: Math.max(0, Math.min(100, business.quality + outcome.qualityDelta)),
    ownership_pct: Math.max(1, Math.min(100, business.ownership_pct + outcome.ownershipDelta)),
  });
  db.events.update(event.id, { resolved: true, impact: { ...event.impact, outcome: outcome.key } });

  const result = recomputeNetWorthAndRank(profile.id);
  res.json({ ok: true, resultText: outcome.resultText, ...result });
});
