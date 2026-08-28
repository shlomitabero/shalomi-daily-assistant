// Persistent NPC personalities for negotiation (section 7). Traits drive the
// rule-based negotiation engine's accept/counter/reject thresholds. NPCs
// remember prior interactions per-player via reputation (section 24) —
// trustScoreByProfile is populated at runtime, not seeded.

export const NPCS = {
  npc_desperate_founder: {
    id: 'npc_desperate_founder',
    name: 'Marcus Cole',
    archetype: 'desperate founder',
    voice: 'blunt, tired, wants out fast',
    // 0-1 scales: greed (wants top dollar) vs desperation (will fold faster)
    greed: 0.35,
    desperation: 0.75,
    stubbornness: 0.3,
    trustsEasily: 0.6,
  },
  npc_cautious_landlord: {
    id: 'npc_cautious_landlord',
    name: 'Diane Whitfield',
    archetype: 'cautious landlord',
    voice: 'formal, risk-averse, protective of legacy',
    greed: 0.55,
    desperation: 0.2,
    stubbornness: 0.7,
    trustsEasily: 0.35,
  },
  npc_desperate_startup_founder: {
    id: 'npc_desperate_startup_founder',
    name: 'Priya Nandan',
    archetype: 'desperate startup founder',
    voice: 'fast-talking, optimistic, burning runway',
    greed: 0.5,
    desperation: 0.8,
    stubbornness: 0.25,
    trustsEasily: 0.7,
  },
  npc_arrogant_investor: {
    id: 'npc_arrogant_investor',
    name: 'Victor Kessler',
    archetype: 'arrogant investor',
    voice: 'condescending, name-drops, expects deference',
    greed: 0.75,
    desperation: 0.1,
    stubbornness: 0.8,
    trustsEasily: 0.2,
  },
  npc_conservative_banker: {
    id: 'npc_conservative_banker',
    name: 'Harold Reyes',
    archetype: 'conservative banker',
    voice: 'procedural, numbers-first, no small talk',
    greed: 0.4,
    desperation: 0.05,
    stubbornness: 0.65,
    trustsEasily: 0.4,
  },
  npc_aggressive_founder: {
    id: 'npc_aggressive_founder',
    name: 'Dante Russo',
    archetype: 'aggressive founder',
    voice: 'combative, treats every offer as an insult until proven otherwise',
    greed: 0.7,
    desperation: 0.15,
    stubbornness: 0.75,
    trustsEasily: 0.25,
  },
  npc_loyal_manager: {
    id: 'npc_loyal_manager',
    name: 'Renata Silva',
    archetype: 'loyal manager',
    voice: 'protective of her team, negotiates on their behalf as much as the price',
    greed: 0.3,
    desperation: 0.35,
    stubbornness: 0.5,
    trustsEasily: 0.65,
  },
  npc_ambitious_employee: {
    id: 'npc_ambitious_employee',
    name: 'Jordan Ade',
    archetype: 'ambitious employee',
    voice: 'eager, sees the deal as their own ticket up',
    greed: 0.45,
    desperation: 0.55,
    stubbornness: 0.3,
    trustsEasily: 0.6,
  },
  npc_dishonest_partner: {
    id: 'npc_dishonest_partner',
    name: 'Wesley Okoro',
    archetype: 'dishonest partner',
    voice: 'smooth, overstates the numbers, gets defensive when questioned',
    greed: 0.8,
    desperation: 0.4,
    stubbornness: 0.55,
    trustsEasily: 0.15,
  },
  npc_genius_operator: {
    id: 'npc_genius_operator',
    name: 'Mei Lindqvist',
    archetype: 'genius operator',
    voice: 'precise, unemotional, respects competence more than money',
    greed: 0.5,
    desperation: 0.1,
    stubbornness: 0.6,
    trustsEasily: 0.45,
  },
};

export function getNpc(id) {
  return NPCS[id] ?? null;
}
