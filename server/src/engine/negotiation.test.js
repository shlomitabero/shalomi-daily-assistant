import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOffer, evaluateNegotiationTurn } from './negotiation.js';
import { NPCS } from '../data/npcs.js';

test('parseOffer extracts price, stake and conditions from free text', () => {
  const parsed = parseOffer('I will give you $150,000 for 70%, but you stay as CEO for 2 years.');
  assert.equal(parsed.price, 150000);
  assert.equal(parsed.stakePct, 70);
  assert.ok(parsed.conditions.includes('seller_stays_ceo'));
  assert.ok(parsed.conditions.includes('term_2_years'));
});

test('parseOffer handles k/m suffixes', () => {
  assert.equal(parseOffer('$150k for 60%').price, 150000);
  assert.equal(parseOffer('$1.2m for 51%').price, 1200000);
});

test('an offer far below the NPC floor gets countered, not accepted', () => {
  const npc = NPCS.npc_arrogant_investor; // low desperation, high greed -> hard floor
  const offer = { ask_price: 250000, ask_stake_pct: 60 };
  const fairValuation = offer.ask_price / (offer.ask_stake_pct / 100);
  const result = evaluateNegotiationTurn({
    npc, business: {}, fairValuation, offer, turn: 0, playerMessage: '$50,000 for 60%',
  });
  assert.notEqual(result.decision, 'accept');
});

test('an offer at or above the fair valuation is accepted', () => {
  const npc = NPCS.npc_desperate_founder;
  const offer = { ask_price: 250000, ask_stake_pct: 60 };
  const fairValuation = offer.ask_price / (offer.ask_stake_pct / 100);
  const result = evaluateNegotiationTurn({
    npc, business: {}, fairValuation, offer, turn: 0, playerMessage: '$250,000 for 60%',
  });
  assert.equal(result.decision, 'accept');
});

test('matching the NPC own last counter-offer always closes the deal', () => {
  const npc = NPCS.npc_arrogant_investor;
  const offer = { ask_price: 250000, ask_stake_pct: 60 };
  const fairValuation = offer.ask_price / (offer.ask_stake_pct / 100);
  const previousNpcOffer = { price: 180000, stakePct: 60 };
  const result = evaluateNegotiationTurn({
    npc, business: {}, fairValuation, offer, turn: 2, playerMessage: 'Deal, $180,000 for 60%.', previousNpcOffer,
  });
  assert.equal(result.decision, 'accept');
});

test('saying "no deal" walks away immediately', () => {
  const npc = NPCS.npc_conservative_banker;
  const offer = { ask_price: 100000, ask_stake_pct: 50 };
  const fairValuation = offer.ask_price / (offer.ask_stake_pct / 100);
  const result = evaluateNegotiationTurn({
    npc, business: {}, fairValuation, offer, turn: 1, playerMessage: 'No deal, forget it.',
  });
  assert.equal(result.decision, 'walk_away');
});
