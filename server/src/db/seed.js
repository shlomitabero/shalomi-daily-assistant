// Seed data (deliverable #16): scarce real estate, and a handful of
// simulated competitor players so the world feed and leaderboards feel alive
// from a brand-new player's very first session (section 18/38).
import { db, makeId } from './store.js';
import { newBusinessFromOpportunity } from '../engine/economy.js';
import { STARTER_OPPORTUNITIES } from '../data/industries.js';

const CITIES = ['Zero City', 'Port Meridian', 'New Ashford', 'Delta Bay'];

const PROPERTIES = [
  { neighborhood: 'Old Town', kind: 'retail', value: 180_000, monthly_income: 2200, is_scarce: false },
  { neighborhood: 'Riverside', kind: 'apartment', value: 240_000, monthly_income: 2600, is_scarce: false },
  { neighborhood: 'Industrial Row', kind: 'office', value: 310_000, monthly_income: 3400, is_scarce: false },
  { neighborhood: 'Harbor District', kind: 'hotel', value: 1_450_000, monthly_income: 18_000, is_scarce: false },
  { neighborhood: 'Meridian Tower', kind: 'landmark', value: 8_500_000, monthly_income: 62_000, is_scarce: true },
  { neighborhood: 'The Crown Building', kind: 'landmark', value: 12_000_000, monthly_income: 84_000, is_scarce: true },
];

const COMPETITORS = [
  { name: 'Dana Okafor', netWorth: 640_000, rank: 24 },
  { name: 'Ravi Malhotra', netWorth: 2_100_000, rank: 33 },
  { name: 'Lena Sørensen', netWorth: 18_400_000, rank: 47 },
  { name: 'Carlos Vega', netWorth: 84_700_000, rank: 64 },
  { name: 'Yuki Tanaka', netWorth: 340_000_000, rank: 73 },
  { name: 'Amara Johnson', netWorth: 1_900_000, rank: 32 },
];

const FEED_FLAVOR = [
  { headline: 'Carlos Vega just sold a company for $184M.', kind: 'sale', amount: 184_000_000 },
  { headline: 'Lena Sørensen lost $4.2M today on a bad supply bet.', kind: 'loss', amount: 4_200_000 },
  { headline: 'Yuki Tanaka just bought the most expensive building in Port Meridian.', kind: 'property', amount: 22_000_000 },
  { headline: 'A hostile takeover is unfolding in the ecommerce sector.', kind: 'takeover', amount: null },
  { headline: 'Ravi Malhotra became a millionaire.', kind: 'milestone', amount: 1_000_000 },
];

export function seedIfEmpty() {
  if (db.properties.all().length > 0) return false;

  for (const p of PROPERTIES) {
    db.properties.insert({
      id: makeId('prop'), owner_id: null, city: CITIES[0], mortgage_id: null, acquired_at: null, ...p,
    });
  }

  for (const c of COMPETITORS) {
    const userId = makeId('user');
    const profileId = makeId('profile');
    db.users.insert({ id: userId, email: null, created_at: new Date().toISOString(), last_login_at: new Date().toISOString() });
    db.profiles.insert({
      id: profileId, user_id: userId, display_name: c.name, avatar: '🧑‍💼',
      city: CITIES[Math.floor(Math.random() * CITIES.length)], archetype: null,
      cash: Math.round(c.netWorth * 0.08), rank: c.rank, age_days: 30, created_at: new Date().toISOString(),
    });
    db.reputation.insert({ profile_id: profileId, trust: 50, dealmaking: 60, leadership: 55, execution: 60, innovation: 50, risk: 55, social_impact: 50 });
    db.player_rank.insert({ profile_id: profileId, rank: c.rank, net_worth_at: c.netWorth, updated_at: new Date().toISOString() });

    const opp = STARTER_OPPORTUNITIES[Math.floor(Math.random() * STARTER_OPPORTUNITIES.length)];
    const business = newBusinessFromOpportunity({ id: makeId('biz'), owner_id: profileId, opportunity: opp });
    business.brand_value = Math.round(c.netWorth * 0.5);
    db.businesses.insert(business);
  }

  for (let i = 0; i < FEED_FLAVOR.length; i++) {
    const f = FEED_FLAVOR[i];
    db.world_feed.insert({
      id: makeId('feed'), headline: f.headline, profile_id: null, kind: f.kind, amount: f.amount,
      created_at: new Date(Date.now() - (FEED_FLAVOR.length - i) * 1000 * 60 * 40).toISOString(),
    });
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seeded = seedIfEmpty();
  console.log(seeded ? 'Seeded FROM ZERO world data.' : 'World data already present — skipped.');
}
