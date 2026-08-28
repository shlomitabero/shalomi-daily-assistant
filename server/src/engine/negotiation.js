// AI negotiation engine (section 6). Players write free-text offers instead
// of picking YES/NO. This is a deterministic, rule-based "AI" — it parses
// price/stake/conditions out of natural language and evaluates them against
// the NPC's personality, the deal's fair valuation, and the player's
// reputation. It is intentionally isolated behind this module's function
// signatures so a real LLM call can replace `evaluateNegotiationTurn`
// without touching routes or the economy engine (which still owns all money
// math — this module only ever proposes numbers, never moves them).

const MAX_TURNS = 6;

export function parseOffer(text) {
  const conditions = [];
  let price = null;
  let stakePct = null;

  const priceMatch = text.match(/\$\s?([\d,]+(?:\.\d+)?)\s?(k|m|million|thousand)?/i);
  if (priceMatch) {
    let amount = parseFloat(priceMatch[1].replace(/,/g, ''));
    const unit = (priceMatch[2] || '').toLowerCase();
    if (unit === 'k' || unit === 'thousand') amount *= 1_000;
    if (unit === 'm' || unit === 'million') amount *= 1_000_000;
    price = Math.round(amount);
  }

  const stakeMatch = text.match(/(\d{1,3}(?:\.\d+)?)\s?(%|percent)/i);
  if (stakeMatch) {
    stakePct = Math.min(100, parseFloat(stakeMatch[1]));
  }

  if (/\bceo\b/i.test(text)) conditions.push('seller_stays_ceo');
  if (/operational control|stay in control|keep control/i.test(text)) conditions.push('seller_retains_control');
  const yearsMatch = text.match(/(\d+)\s*year/i);
  if (yearsMatch) conditions.push(`term_${yearsMatch[1]}_years`);
  if (/earnout/i.test(text)) conditions.push('earnout');
  if (/walk away|no deal|forget it/i.test(text)) conditions.push('player_walked');

  return { price, stakePct, conditions };
}

function impliedValuation(price, stakePct) {
  if (!price || !stakePct) return null;
  return price / (stakePct / 100);
}

export function openingLine(npc, offer, business) {
  const askDisplay = `$${offer.ask_price.toLocaleString()}`;
  const lines = {
    'desperate founder': `I need out. I'm asking ${askDisplay} for ${offer.ask_stake_pct}% of ${business.name}.`,
    'cautious landlord': `Let's be precise. My price is ${askDisplay} for ${offer.ask_stake_pct}%, and I expect it to be respected.`,
    'desperate startup founder': `I'll be honest, we're burning cash. ${askDisplay} gets you ${offer.ask_stake_pct}%.`,
    'arrogant investor': `${askDisplay} for ${offer.ask_stake_pct}%. That's a gift, frankly.`,
    'conservative banker': `The number is ${askDisplay} for ${offer.ask_stake_pct}%. I don't negotiate on principle, only on terms.`,
    'aggressive founder': `Don't waste my time. ${askDisplay} for ${offer.ask_stake_pct}%, and that's already a favor.`,
    'loyal manager': `Before anything else — my team keeps their jobs. The price is ${askDisplay} for ${offer.ask_stake_pct}%.`,
    'ambitious employee': `I've been waiting for this. ${askDisplay} for ${offer.ask_stake_pct}% and I want to be part of what comes next.`,
    'dishonest partner': `The numbers speak for themselves — ${askDisplay} for ${offer.ask_stake_pct}%, and honestly, that's underselling it.`,
    'genius operator': `${askDisplay} for ${offer.ask_stake_pct}%. I built the model myself, so I already know what it's worth.`,
  };
  return lines[npc.archetype] ?? `I'm asking ${askDisplay} for ${offer.ask_stake_pct}%.`;
}

// trustBonus: 0-1, derived from the player's reputation.trust score elsewhere.
// previousNpcOffer: {price, stakePct} the NPC itself last proposed, if any —
// a real negotiator honors their own last number, so matching or beating it
// always closes the deal regardless of how the floor recomputes below.
export function evaluateNegotiationTurn({ npc, business, fairValuation, offer, turn, playerMessage, trustBonus = 0, previousNpcOffer = null }) {
  const parsed = parseOffer(playerMessage);

  if (parsed.conditions.includes('player_walked')) {
    return {
      decision: 'walk_away',
      npcMessage: `Your call. If you change your mind, you know where to find me.`,
      parsed,
    };
  }

  const price = parsed.price ?? Math.round(offer.ask_price * 0.9);
  const stakePct = parsed.stakePct ?? offer.ask_stake_pct;
  const offeredValuation = impliedValuation(price, stakePct) ?? price;

  if (previousNpcOffer?.price && previousNpcOffer?.stakePct) {
    const previousValuation = impliedValuation(previousNpcOffer.price, previousNpcOffer.stakePct);
    if (previousValuation && offeredValuation >= previousValuation * 0.98) {
      return {
        decision: 'accept',
        npcMessage: buildAcceptMessage(npc, price, stakePct, parsed.conditions),
        proposedPrice: price,
        proposedStakePct: stakePct,
        conditions: parsed.conditions,
        parsed,
      };
    }
  }

  // NPC's walk-away floor: desperation lowers it, greed raises it, and a
  // trusted player (good reputation) gets a small discount.
  const floorMultiplier = 1 - npc.desperation * 0.3 + npc.greed * 0.25 - trustBonus * 0.08;
  const npcFloor = fairValuation * Math.max(0.35, floorMultiplier);

  const gap = (npcFloor - offeredValuation) / npcFloor;

  const wantsSellerStaysCeo = parsed.conditions.includes('seller_stays_ceo');
  const conditionRelief = wantsSellerStaysCeo && npc.desperation > 0.5 ? 0.05 : 0;
  const effectiveGap = gap - conditionRelief;

  if (effectiveGap <= 0) {
    return {
      decision: 'accept',
      npcMessage: buildAcceptMessage(npc, price, stakePct, parsed.conditions),
      proposedPrice: price,
      proposedStakePct: stakePct,
      conditions: parsed.conditions,
      parsed,
    };
  }

  if (turn >= MAX_TURNS) {
    return {
      decision: 'walk_away',
      npcMessage: `We're too far apart. I'm done negotiating.`,
      parsed,
    };
  }

  // Counter: move from the NPC's floor toward the player's offer, less for
  // stubborn NPCs, more as turns progress (both sides fatigue toward middle).
  const flexibility = clamp(0.5 - npc.stubbornness * 0.3 + turn * 0.05, 0.15, 0.6);
  const counterValuation = npcFloor - (npcFloor - offeredValuation) * flexibility;
  const counterStake = stakePct;
  const counterPrice = Math.round((counterValuation * counterStake) / 100);

  if (effectiveGap > 0.55 && npc.stubbornness > 0.6 && turn >= 2) {
    return {
      decision: 'reject',
      npcMessage: `That's not close. ${buildCounterMessage(npc, counterPrice, counterStake)}`,
      proposedPrice: counterPrice,
      proposedStakePct: counterStake,
      conditions: parsed.conditions,
      parsed,
    };
  }

  return {
    decision: 'counter',
    npcMessage: buildCounterMessage(npc, counterPrice, counterStake, wantsSellerStaysCeo && npc.desperation > 0.5),
    proposedPrice: counterPrice,
    proposedStakePct: counterStake,
    conditions: parsed.conditions,
    parsed,
  };
}

function buildAcceptMessage(npc, price, stakePct, conditions) {
  const conditionText = conditions.includes('seller_stays_ceo')
    ? ` I'll stay on as CEO like you asked.`
    : '';
  const byArchetype = {
    'desperate founder': `Deal. $${price.toLocaleString()} for ${stakePct}%. Let's get the paperwork done.${conditionText}`,
    'cautious landlord': `Acceptable. $${price.toLocaleString()} for ${stakePct}%, formalized in writing.${conditionText}`,
    'desperate startup founder': `Yes — $${price.toLocaleString()} for ${stakePct}% saves us. Thank you.${conditionText}`,
    'arrogant investor': `Fine. $${price.toLocaleString()} for ${stakePct}%. Don't expect that again.${conditionText}`,
    'conservative banker': `Terms accepted: $${price.toLocaleString()} for ${stakePct}%.${conditionText}`,
    'aggressive founder': `Fine — $${price.toLocaleString()} for ${stakePct}%. Don't make me regret it.${conditionText}`,
    'loyal manager': `Deal, as long as my people are taken care of. $${price.toLocaleString()} for ${stakePct}%.${conditionText}`,
    'ambitious employee': `Yes! $${price.toLocaleString()} for ${stakePct}% — let's build something.${conditionText}`,
    'dishonest partner': `Deal. $${price.toLocaleString()} for ${stakePct}%. You're getting a bargain, trust me.${conditionText}`,
    'genius operator': `Acceptable. $${price.toLocaleString()} for ${stakePct}%. Don't waste what you're buying.${conditionText}`,
  };
  return byArchetype[npc.archetype] ?? `Deal. $${price.toLocaleString()} for ${stakePct}%.${conditionText}`;
}

function buildCounterMessage(npc, price, stakePct, offerCeoStay = false) {
  const stayText = offerCeoStay ? ` I'll agree to stay on as CEO for a transition period.` : '';
  const byArchetype = {
    'desperate founder': `I can come down to $${price.toLocaleString()} for ${stakePct}%, but that's close to my limit.${stayText}`,
    'cautious landlord': `I can consider $${price.toLocaleString()} for ${stakePct}%, provided the terms are airtight.${stayText}`,
    'desperate startup founder': `What about $${price.toLocaleString()} for ${stakePct}%? I need this to move fast.${stayText}`,
    'arrogant investor': `$${price.toLocaleString()} for ${stakePct}%. That's already generous of me.${stayText}`,
    'conservative banker': `Counter: $${price.toLocaleString()} for ${stakePct}%.${stayText}`,
    'aggressive founder': `Not even close. $${price.toLocaleString()} for ${stakePct}%, final offer territory.${stayText}`,
    'loyal manager': `I can move to $${price.toLocaleString()} for ${stakePct}%, but only with real guarantees for my team.${stayText}`,
    'ambitious employee': `I'll meet you at $${price.toLocaleString()} for ${stakePct}% — I want this to happen.${stayText}`,
    'dishonest partner': `$${price.toLocaleString()} for ${stakePct}%. That's still more than fair, believe me.${stayText}`,
    'genius operator': `$${price.toLocaleString()} for ${stakePct}%. The math doesn't move much past that.${stayText}`,
  };
  return byArchetype[npc.archetype] ?? `Counter: $${price.toLocaleString()} for ${stakePct}%.${stayText}`;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
