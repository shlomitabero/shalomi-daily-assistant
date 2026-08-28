import { Router } from 'express';
import { db, makeId, getMarketState, setMarketState } from '../db/store.js';
import { STARTER_OPPORTUNITIES } from '../data/industries.js';
import { rollEvent } from '../data/events.js';
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
  pushWorldFeed,
  formatCompact,
} from '../services/playerState.js';

export const businessRouter = Router();

const MARKETING_COST_PER_LEVEL = 2000;
const HIRE_COST = 300;
const EVENT_PROBABILITY_PER_BUSINESS_DAY = 0.35;
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

businessRouter.post('/players/:id/businesses', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const { opportunityId } = req.body ?? {};
  const opportunity = STARTER_OPPORTUNITIES.find((o) => o.id === opportunityId);
  if (!opportunity) return res.status(400).json({ error: 'unknown opportunity' });
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
  pushWorldFeed(`${profile.display_name} sold ${business.name} for $${formatCompact(salePrice)}.`, profile.id, 'sale', salePrice);

  const result = recomputeNetWorthAndRank(profile.id);
  res.json({ salePrice, ...result });
});

businessRouter.post('/players/:id/advance-day', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;

  let cash = profile.cash;
  const dayEvents = [];
  const businesses = db.businesses.where((b) => b.owner_id === profile.id && b.stage === 'active');

  for (const business of businesses) {
    const employees = db.employees.where((e) => e.business_id === business.id && !e.terminated_at);
    const liveBusiness = { ...business, activeEffects: business.activeEffects ?? [] };
    const day = runDayForBusiness(liveBusiness, employees);
    const period = db.business_financials.where((f) => f.business_id === business.id).length + 1;
    db.business_financials.insert({
      id: makeId('fin'), business_id: business.id, ...day, period, created_at: new Date().toISOString(),
    });
    cash += day.ebitda;

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
  }

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
