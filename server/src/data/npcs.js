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
};

export function getNpc(id) {
  return NPCS[id] ?? null;
}
