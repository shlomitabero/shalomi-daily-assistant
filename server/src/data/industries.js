// MVP industries (section 32): FOOD, CAR DETAILING, ECOMMERCE.
// Each opportunity template drives the deterministic economy engine —
// baseline P&L ratios that quality/marketing/inventory/employees modify.

export const INDUSTRIES = {
  food: {
    name: 'Food',
    unit: 'stand',
    cogsRatio: 0.30,
    rentRatio: 0.09,
    baseCustomerScore: 62,
    volatility: 0.18,
  },
  car_detailing: {
    name: 'Car Detailing',
    unit: 'bay',
    cogsRatio: 0.18,
    rentRatio: 0.07,
    baseCustomerScore: 68,
    volatility: 0.14,
  },
  ecommerce: {
    name: 'Online Store',
    unit: 'store',
    cogsRatio: 0.42,
    rentRatio: 0.02,
    baseCustomerScore: 58,
    volatility: 0.22,
  },
};

// The 3 starter opportunities shown in the first 60 seconds (section 2).
export const STARTER_OPPORTUNITIES = [
  {
    id: 'opp_food_stand',
    industry: 'food',
    name: 'Small Food Stand',
    description:
      'A busy corner spot selling grilled sandwiches. Loyal lunch crowd, cash-only, needs a hands-on owner.',
    cost: 6000,
    risk: 'Medium',
    potential: 'High',
    baseRevenuePerDay: 420,
    startingQuality: 55,
  },
  {
    id: 'opp_online_store',
    industry: 'ecommerce',
    name: 'Online Store',
    description:
      'A dropship storefront for phone accessories. Low overhead, scales with marketing spend.',
    cost: 3000,
    risk: 'Low',
    potential: 'Medium',
    baseRevenuePerDay: 260,
    startingQuality: 48,
  },
  {
    id: 'opp_detailing',
    industry: 'car_detailing',
    name: 'Car Detailing Business',
    description:
      'A mobile detailing van with two regular commercial contracts already lined up.',
    cost: 8000,
    risk: 'Medium',
    potential: 'High',
    baseRevenuePerDay: 520,
    startingQuality: 60,
  },
];

// Later-game acquisition targets used to seed AI-negotiated deals.
export const ACQUISITION_TARGETS = [
  {
    id: 'target_burger_joint',
    industry: 'food',
    name: 'Shark Burger Downtown',
    description: 'A single-location burger restaurant with strong repeat customers but a tired kitchen.',
    askPrice: 250_000,
    askStakePct: 60,
    monthlyRevenue: 320_000 / 12 * 12, // seed value, refined by engine on creation
    npcId: 'npc_desperate_founder',
  },
  {
    id: 'target_detail_chain',
    industry: 'car_detailing',
    name: 'Prestige Auto Spa (3 bays)',
    description: 'A 3-location detailing chain, founder wants to retire but keep a board seat.',
    askPrice: 140_000,
    askStakePct: 70,
    npcId: 'npc_cautious_landlord',
  },
  {
    id: 'target_dtc_brand',
    industry: 'ecommerce',
    name: 'Northline DTC Apparel',
    description: 'A venture-backed apparel brand burning cash, founder needs a bridge before the next raise.',
    askPrice: 95_000,
    askStakePct: 55,
    npcId: 'npc_desperate_startup_founder',
  },
];
