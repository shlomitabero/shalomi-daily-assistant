-- FROM ZERO — production database schema (PostgreSQL)
--
-- This is the target production schema referenced by section 41 of the design
-- doc. The shipped MVP (server/src/db/store.js) implements the same entities
-- and relationships against a file-backed store so the game is playable
-- without provisioning infrastructure; swapping store.js for a Postgres
-- repository backed by this schema is a drop-in replacement (the route layer
-- only calls repository functions, never raw storage).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================ USERS / PROFILE
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ
);

CREATE TABLE profiles (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name      TEXT NOT NULL,
  avatar            TEXT NOT NULL,
  city              TEXT NOT NULL,
  archetype         TEXT, -- operator | investor | negotiator | builder | marketer | real_estate_king | tech_founder | shark
  cash              NUMERIC(18,2) NOT NULL DEFAULT 10000,
  rank              INTEGER NOT NULL DEFAULT 1,
  age_days          INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reputation is multi-axis, not a single trust score (section 24).
CREATE TABLE reputation (
  profile_id      UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  trust           INTEGER NOT NULL DEFAULT 50,
  dealmaking      INTEGER NOT NULL DEFAULT 50,
  leadership      INTEGER NOT NULL DEFAULT 50,
  execution       INTEGER NOT NULL DEFAULT 50,
  innovation      INTEGER NOT NULL DEFAULT 50,
  risk            INTEGER NOT NULL DEFAULT 50,
  social_impact   INTEGER NOT NULL DEFAULT 50
);

-- ============================================================ BUSINESSES
CREATE TABLE businesses (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id        UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  brand           TEXT NOT NULL, -- shared across franchised locations of the same concept
  origin          TEXT NOT NULL DEFAULT 'founded', -- founded | acquired | franchised — drives specialization inference
  industry        TEXT NOT NULL, -- food | car_detailing | ecommerce | ...
  city            TEXT NOT NULL,
  stage           TEXT NOT NULL DEFAULT 'active', -- active | closed | bankrupt | sold
  ownership_pct   NUMERIC(5,2) NOT NULL DEFAULT 100,
  quality         INTEGER NOT NULL DEFAULT 50, -- 0-100, drives customer score
  marketing_level INTEGER NOT NULL DEFAULT 1,
  inventory_level INTEGER NOT NULL DEFAULT 50,
  brand_value     NUMERIC(18,2) NOT NULL DEFAULT 0,
  base_revenue_per_day NUMERIC(18,2) NOT NULL, -- opportunity baseline the engine scales from
  base_rent_per_day    NUMERIC(18,2) NOT NULL,
  cost_basis_100       NUMERIC(18,2) NOT NULL, -- implied 100%-ownership value at purchase; valuation ramps from here
  active_effects  JSONB NOT NULL DEFAULT '[]', -- temporary event modifiers, see engine/economy.js
  founded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Monthly (per game-day-tick) P&L snapshots — the source of truth for
-- valuation, EBITDA and net worth. Never overwritten, only appended.
CREATE TABLE business_financials (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  period          INTEGER NOT NULL, -- game day index
  revenue         NUMERIC(18,2) NOT NULL,
  cogs            NUMERIC(18,2) NOT NULL,
  payroll         NUMERIC(18,2) NOT NULL,
  rent            NUMERIC(18,2) NOT NULL,
  marketing       NUMERIC(18,2) NOT NULL,
  other_expenses  NUMERIC(18,2) NOT NULL,
  ebitda          NUMERIC(18,2) NOT NULL,
  customer_score  INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE employees (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  name            TEXT NOT NULL,
  salary_monthly  NUMERIC(18,2) NOT NULL,
  skill           INTEGER NOT NULL DEFAULT 50,
  loyalty         INTEGER NOT NULL DEFAULT 50,
  hired_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminated_at   TIMESTAMPTZ
);

-- ============================================================ REAL ESTATE
CREATE TABLE properties (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id        UUID REFERENCES profiles(id) ON DELETE SET NULL,
  city            TEXT NOT NULL,
  neighborhood    TEXT NOT NULL,
  kind            TEXT NOT NULL, -- apartment | retail | office | hotel | landmark
  is_scarce       BOOLEAN NOT NULL DEFAULT false, -- landmark/limited assets, section 13
  value           NUMERIC(18,2) NOT NULL,
  monthly_income  NUMERIC(18,2) NOT NULL DEFAULT 0,
  mortgage_id     UUID,
  acquired_at     TIMESTAMPTZ
);

-- ============================================================ FINANCING
CREATE TABLE loans (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id        UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  principal         NUMERIC(18,2) NOT NULL,
  balance           NUMERIC(18,2) NOT NULL,
  annual_rate       NUMERIC(6,4) NOT NULL,
  kind              TEXT NOT NULL, -- business_loan | mortgage | credit_line | bridge_loan | investor_financing
  status            TEXT NOT NULL DEFAULT 'active', -- active | paid | defaulted
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE investments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  investor_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  stake_pct       NUMERIC(5,2) NOT NULL,
  amount          NUMERIC(18,2) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================ DEALS
CREATE TABLE offers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  seller_npc_id   TEXT, -- NULL when the seller is another player
  seller_profile_id UUID REFERENCES profiles(id),
  buyer_id        UUID REFERENCES profiles(id),
  ask_price       NUMERIC(18,2) NOT NULL,
  ask_stake_pct   NUMERIC(5,2) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open', -- open | negotiating | accepted | rejected | expired
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE negotiations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  offer_id        UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  buyer_id        UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  turn            INTEGER NOT NULL,
  speaker         TEXT NOT NULL, -- buyer | seller
  message         TEXT NOT NULL,
  proposed_price  NUMERIC(18,2),
  proposed_stake  NUMERIC(5,2),
  conditions      JSONB,
  outcome         TEXT, -- NULL while open | accepted | rejected | countered | walked_away
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL, -- revenue | expense | loan_draw | loan_payment | acquisition | sale | investment | property
  amount          NUMERIC(18,2) NOT NULL, -- signed
  memo            TEXT,
  ref_id          UUID, -- business_id / property_id / loan_id / negotiation_id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================ PROGRESSION
CREATE TABLE player_rank (
  profile_id      UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  rank            INTEGER NOT NULL DEFAULT 1,
  net_worth_at    NUMERIC(18,2) NOT NULL DEFAULT 10000,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE legacy (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL, -- first_company | first_million | first_bankruptcy | first_acquisition | ...
  headline        TEXT NOT NULL,
  amount          NUMERIC(18,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================ WORLD SIMULATION
CREATE TABLE events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id      UUID REFERENCES profiles(id) ON DELETE CASCADE,
  business_id     UUID REFERENCES businesses(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  description     TEXT NOT NULL,
  impact          JSONB,
  resolved        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE market_state (
  id              INTEGER PRIMARY KEY DEFAULT 1,
  cycle           TEXT NOT NULL DEFAULT 'stable', -- recession | stable | boom | tech_bubble | shortage
  interest_rate   NUMERIC(6,4) NOT NULL DEFAULT 0.06,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

CREATE TABLE world_feed (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  headline        TEXT NOT NULL,
  profile_id      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL, -- sale | loss | acquisition | ipo | bankruptcy | milestone | takeover
  amount          NUMERIC(18,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE leaderboards (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category        TEXT NOT NULL, -- net_worth | best_operator | best_investor | biggest_deal | fastest_to_1m | ...
  profile_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  value           NUMERIC(18,2) NOT NULL,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_conversations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  npc_id          TEXT NOT NULL,
  context         TEXT NOT NULL, -- negotiation | staff | event
  ref_id          UUID,
  transcript      JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_businesses_owner ON businesses(owner_id);
CREATE INDEX idx_financials_business ON business_financials(business_id, period);
CREATE INDEX idx_transactions_profile ON transactions(profile_id, created_at);
CREATE INDEX idx_negotiations_offer ON negotiations(offer_id, turn);
CREATE INDEX idx_world_feed_created ON world_feed(created_at DESC);
CREATE INDEX idx_leaderboards_category ON leaderboards(category, value DESC);
