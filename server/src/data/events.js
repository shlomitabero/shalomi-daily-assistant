// Random business events (section 10). Each event has an `effect` the events
// engine applies deterministically — the event ROLL is random, the ECONOMIC
// CONSEQUENCE never is (section 40: the AI/event layer cannot create or
// destroy money outside these rules).

export const EVENTS = [
  {
    id: 'evt_rent_increase',
    weight: 3,
    headline: (b) => `Your landlord is raising rent 20% at ${b.name}.`,
    effect: { type: 'rent_multiplier', value: 1.2, durationDays: 30 },
  },
  {
    id: 'evt_manager_resigns',
    weight: 2,
    headline: (b) => `Your best manager at ${b.name} just resigned.`,
    effect: { type: 'quality_hit', value: -12 },
  },
  {
    id: 'evt_competitor_opens',
    weight: 3,
    headline: (b) => `A competitor opened next door to ${b.name}.`,
    effect: { type: 'customer_score_hit', value: -10, durationDays: 20 },
  },
  {
    id: 'evt_viral_moment',
    weight: 2,
    headline: (b) => `A video about ${b.name} is going viral.`,
    effect: { type: 'revenue_multiplier', value: 2.1, durationDays: 3 },
  },
  {
    id: 'evt_supplier_price_hike',
    weight: 3,
    headline: (b) => `Your supplier raised prices for ${b.name}.`,
    effect: { type: 'cogs_add', value: 0.05, durationDays: 45 },
  },
  {
    id: 'evt_celebrity_visit',
    weight: 1,
    headline: (b) => `A local celebrity was spotted at ${b.name}.`,
    effect: { type: 'brand_value_add', value: 4000 },
  },
  {
    id: 'evt_employee_theft',
    weight: 1,
    headline: (b) => `An employee was caught stealing from ${b.name}.`,
    effect: { type: 'cash_loss', value: 1800 },
  },
  {
    id: 'evt_acquisition_interest',
    weight: 1,
    headline: (b) => `An investor wants to talk about acquiring part of ${b.name}.`,
    effect: { type: 'spawn_offer_interest' },
  },
  {
    id: 'evt_below_market_property',
    weight: 1,
    headline: () => `A property just hit the market below fair value.`,
    effect: { type: 'spawn_property_deal' },
  },
  {
    id: 'evt_recession_warning',
    weight: 1,
    headline: () => `Economists are warning of a recession.`,
    effect: { type: 'market_shift', value: 'recession' },
  },
];

export function rollEvent(rng = Math.random) {
  const total = EVENTS.reduce((s, e) => s + e.weight, 0);
  let roll = rng() * total;
  for (const e of EVENTS) {
    roll -= e.weight;
    if (roll <= 0) return e;
  }
  return EVENTS[0];
}
