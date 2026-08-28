import { Router } from 'express';
import { db, makeId } from '../db/store.js';
import { ACQUISITION_TARGETS, INDUSTRIES } from '../data/industries.js';
import { getNpc } from '../data/npcs.js';
import { openingLine, evaluateNegotiationTurn } from '../engine/negotiation.js';
import { newBusinessFromOpportunity, accrueLoanInterest, loanPayment } from '../engine/economy.js';
import { recomputeNetWorthAndRank, addLegacy, pushWorldFeed, formatCompact } from '../services/playerState.js';

export const dealsRouter = Router();

const LOAN_RATES = {
  business_loan: 0.14,
  mortgage: 0.06,
  credit_line: 0.18,
  bridge_loan: 0.22,
  investor_financing: 0.10,
};
const MAX_LEVERAGE_MULTIPLE = 3; // total debt can't exceed 3x current cash+valuations

function requireProfile(req, res) {
  const profile = db.profiles.get(req.params.id);
  if (!profile) {
    res.status(404).json({ error: 'player not found' });
    return null;
  }
  return profile;
}

// ---------------------------------------------------------------- NEGOTIATION
dealsRouter.get('/negotiation/targets', (req, res) => {
  res.json({ targets: ACQUISITION_TARGETS });
});

dealsRouter.post('/players/:id/negotiations/start', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const { targetId } = req.body ?? {};
  const target = ACQUISITION_TARGETS.find((t) => t.id === targetId);
  if (!target) return res.status(400).json({ error: 'unknown target' });

  const offer = db.offers.insert({
    id: makeId('offer'), business_id: targetId, seller_npc_id: target.npcId, seller_profile_id: null,
    ask_price: target.askPrice, ask_stake_pct: target.askStakePct, status: 'negotiating',
    buyer_id: profile.id, created_at: new Date().toISOString(),
  });

  const npc = getNpc(target.npcId);
  const opening = openingLine(npc, offer, target);
  const turn = db.negotiations.insert({
    id: makeId('neg'), offer_id: offer.id, buyer_id: profile.id, turn: 0, speaker: 'seller',
    message: opening, proposed_price: offer.ask_price, proposed_stake: offer.ask_stake_pct,
    conditions: null, outcome: null, created_at: new Date().toISOString(),
  });

  res.status(201).json({ offer, target, npc: publicNpc(npc), transcript: [turn] });
});

dealsRouter.get('/players/:id/negotiations/:offerId', (req, res) => {
  const offer = db.offers.get(req.params.offerId);
  if (!offer || offer.buyer_id !== req.params.id) return res.status(404).json({ error: 'negotiation not found' });
  const transcript = db.negotiations.where((n) => n.offer_id === offer.id).sort((a, b) => a.turn - b.turn);
  const target = ACQUISITION_TARGETS.find((t) => t.id === offer.business_id);
  res.json({ offer, target, npc: publicNpc(getNpc(offer.seller_npc_id)), transcript });
});

dealsRouter.post('/players/:id/negotiations/:offerId/message', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const offer = db.offers.get(req.params.offerId);
  if (!offer || offer.buyer_id !== profile.id) return res.status(404).json({ error: 'negotiation not found' });
  if (offer.status !== 'negotiating') return res.status(400).json({ error: 'negotiation already closed' });

  const { text } = req.body ?? {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'message text required' });

  const target = ACQUISITION_TARGETS.find((t) => t.id === offer.business_id);
  const npc = getNpc(offer.seller_npc_id);
  const priorTurns = db.negotiations.where((n) => n.offer_id === offer.id);
  const turnNumber = priorTurns.length;
  const fairValuation = offer.ask_price / (offer.ask_stake_pct / 100);
  const reputation = db.reputation.get(profile.id);
  const trustBonus = (reputation?.trust ?? 50) / 100 - 0.5; // -0.5..0.5

  const lastSellerTurn = [...priorTurns].reverse().find((t) => t.speaker === 'seller');
  const previousNpcOffer = lastSellerTurn?.proposed_price
    ? { price: lastSellerTurn.proposed_price, stakePct: lastSellerTurn.proposed_stake }
    : null;

  db.negotiations.insert({
    id: makeId('neg'), offer_id: offer.id, buyer_id: profile.id, turn: turnNumber, speaker: 'buyer',
    message: text.trim(), proposed_price: null, proposed_stake: null, conditions: null, outcome: null,
    created_at: new Date().toISOString(),
  });

  const evalResult = evaluateNegotiationTurn({
    npc, business: target, fairValuation, offer, turn: turnNumber, playerMessage: text.trim(), trustBonus, previousNpcOffer,
  });

  db.negotiations.insert({
    id: makeId('neg'), offer_id: offer.id, buyer_id: profile.id, turn: turnNumber + 1, speaker: 'seller',
    message: evalResult.npcMessage, proposed_price: evalResult.proposedPrice ?? null,
    proposed_stake: evalResult.proposedStakePct ?? null, conditions: evalResult.conditions ?? null,
    outcome: evalResult.decision, created_at: new Date().toISOString(),
  });

  let closedResult = null;
  if (evalResult.decision === 'accept') {
    closedResult = finalizeAcquisition(profile, offer, target, evalResult, reputation);
  } else if (evalResult.decision === 'walk_away' || evalResult.decision === 'reject_final') {
    db.offers.update(offer.id, { status: 'rejected' });
    if (reputation) db.reputation.update(profile.id, { trust: Math.max(0, reputation.trust - 2) });
  } else if (evalResult.decision === 'reject') {
    if (reputation) db.reputation.update(profile.id, { dealmaking: Math.min(100, reputation.dealmaking + 1) });
  }

  const transcript = db.negotiations.where((n) => n.offer_id === offer.id).sort((a, b) => a.turn - b.turn);
  res.json({ decision: evalResult.decision, offer: db.offers.get(offer.id), transcript, acquisition: closedResult });
});

function finalizeAcquisition(profile, offer, target, evalResult, reputation) {
  if (profile.cash < evalResult.proposedPrice) {
    return { error: 'not enough cash to close — deal expired' };
  }
  const impliedFullValue = Math.round((evalResult.proposedPrice / evalResult.proposedStakePct) * 100);
  const business = newBusinessFromOpportunity({
    id: makeId('biz'), owner_id: profile.id,
    opportunity: {
      industry: target.industry, name: target.name,
      cost: impliedFullValue, baseRevenuePerDay: Math.round((impliedFullValue * 0.9) / 90),
      startingQuality: INDUSTRIES[target.industry].baseCustomerScore + 8,
    },
    costBasis100: impliedFullValue,
  });
  business.ownership_pct = evalResult.proposedStakePct;
  db.businesses.insert(business);
  db.profiles.update(profile.id, { cash: profile.cash - evalResult.proposedPrice });
  db.offers.update(offer.id, { status: 'accepted' });
  db.transactions.insert({
    id: makeId('txn'), profile_id: profile.id, kind: 'acquisition', amount: -evalResult.proposedPrice,
    memo: `Acquired ${evalResult.proposedStakePct}% of ${target.name}`, ref_id: business.id, created_at: new Date().toISOString(),
  });
  addLegacy(profile.id, 'first_acquisition', `Acquired ${target.name} for $${formatCompact(evalResult.proposedPrice)}.`, evalResult.proposedPrice);
  pushWorldFeed(`${profile.display_name} acquired ${evalResult.proposedStakePct}% of ${target.name} for $${formatCompact(evalResult.proposedPrice)}.`, profile.id, 'acquisition', evalResult.proposedPrice);
  if (reputation) db.reputation.update(profile.id, { trust: Math.min(100, reputation.trust + 2), dealmaking: Math.min(100, reputation.dealmaking + 3) });

  const rankResult = recomputeNetWorthAndRank(profile.id);
  return { business, ...rankResult };
}

function publicNpc(npc) {
  if (!npc) return null;
  return { id: npc.id, name: npc.name, archetype: npc.archetype, voice: npc.voice };
}

// ---------------------------------------------------------------------- LOANS
dealsRouter.get('/players/:id/loans', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  res.json({ loans: db.loans.where((l) => l.profile_id === profile.id), rates: LOAN_RATES });
});

dealsRouter.post('/players/:id/loans', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const { kind, amount } = req.body ?? {};
  const rate = LOAN_RATES[kind];
  if (!rate) return res.status(400).json({ error: 'unknown loan kind' });
  const requested = Number(amount);
  if (!(requested > 0)) return res.status(400).json({ error: 'amount must be positive' });

  const existingDebt = db.loans.where((l) => l.profile_id === profile.id && l.status === 'active').reduce((s, l) => s + l.balance, 0);
  const { netWorth } = recomputeNetWorthAndRank(profile.id);
  const capacity = Math.max(10_000, netWorth) * MAX_LEVERAGE_MULTIPLE;
  if (existingDebt + requested > capacity) {
    return res.status(400).json({ error: 'lenders won’t extend that much leverage against your current net worth' });
  }

  const loan = db.loans.insert({
    id: makeId('loan'), profile_id: profile.id, principal: requested, balance: requested,
    annual_rate: rate, kind, status: 'active', issued_at: new Date().toISOString(),
  });
  db.profiles.update(profile.id, { cash: profile.cash + requested });
  db.transactions.insert({ id: makeId('txn'), profile_id: profile.id, kind: 'loan_draw', amount: requested, memo: `${kind} drawn`, ref_id: loan.id, created_at: new Date().toISOString() });
  const result = recomputeNetWorthAndRank(profile.id);
  res.status(201).json({ loan, ...result });
});

dealsRouter.post('/players/:id/loans/:loanId/repay', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const loan = db.loans.get(req.params.loanId);
  if (!loan || loan.profile_id !== profile.id) return res.status(404).json({ error: 'loan not found' });
  const { amount } = req.body ?? {};
  const pay = Math.min(Number(amount) || 0, profile.cash, loan.balance);
  if (!(pay > 0)) return res.status(400).json({ error: 'invalid repayment amount' });

  const newBalance = loanPayment(loan, pay);
  db.loans.update(loan.id, { balance: newBalance, status: newBalance <= 0 ? 'paid' : 'active' });
  db.profiles.update(profile.id, { cash: profile.cash - pay });
  db.transactions.insert({ id: makeId('txn'), profile_id: profile.id, kind: 'loan_payment', amount: -pay, memo: `${loan.kind} payment`, ref_id: loan.id, created_at: new Date().toISOString() });
  const result = recomputeNetWorthAndRank(profile.id);
  res.json({ loan: db.loans.get(loan.id), ...result });
});

// ----------------------------------------------------------------- REAL ESTATE
dealsRouter.get('/properties', (req, res) => {
  res.json({ properties: db.properties.all() });
});

dealsRouter.post('/players/:id/properties/:propId/buy', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const property = db.properties.get(req.params.propId);
  if (!property) return res.status(404).json({ error: 'property not found' });
  if (property.owner_id) return res.status(400).json({ error: 'property already owned' });
  if (profile.cash < property.value) return res.status(400).json({ error: 'not enough cash' });

  db.properties.update(property.id, { owner_id: profile.id, acquired_at: new Date().toISOString() });
  db.profiles.update(profile.id, { cash: profile.cash - property.value });
  db.transactions.insert({ id: makeId('txn'), profile_id: profile.id, kind: 'property', amount: -property.value, memo: `Bought ${property.neighborhood} ${property.kind}`, ref_id: property.id, created_at: new Date().toISOString() });
  if (property.is_scarce) pushWorldFeed(`${profile.display_name} just bought the landmark ${property.neighborhood} ${property.kind}.`, profile.id, 'property', property.value);
  const result = recomputeNetWorthAndRank(profile.id);
  res.json({ property: db.properties.get(property.id), ...result });
});

dealsRouter.post('/players/:id/properties/:propId/sell', (req, res) => {
  const profile = requireProfile(req, res);
  if (!profile) return;
  const property = db.properties.get(req.params.propId);
  if (!property || property.owner_id !== profile.id) return res.status(404).json({ error: 'property not found' });

  db.properties.update(property.id, { owner_id: null, acquired_at: null });
  db.profiles.update(profile.id, { cash: profile.cash + property.value });
  db.transactions.insert({ id: makeId('txn'), profile_id: profile.id, kind: 'property', amount: property.value, memo: `Sold ${property.neighborhood} ${property.kind}`, ref_id: property.id, created_at: new Date().toISOString() });
  const result = recomputeNetWorthAndRank(profile.id);
  res.json({ ...result });
});
