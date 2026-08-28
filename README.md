# FROM ZERO

**Start with nothing. Own everything.**
מתחילים מכלום. בונים אימפריה.

A real-life business MMO. You start with $10,000, no company, no employees,
no connections — and build toward becoming **THE SHARK**, the most successful
business player in the world, through decisions, negotiation, risk, and
strategy rather than waiting on timers.

This is a playable vertical slice (section 31/47 of the design brief), not a
design document: create a player, choose a first business, run it, hire and
fire, negotiate a real acquisition in free text, take on debt, buy real
estate, climb a 100-rank ladder, and watch a simulated global economy move
around you.

## What's actually playable

- **Onboarding → first business in under a minute.** $10,000, 3 starter
  opportunities (Food, Car Detailing, Ecommerce), plus 8 growth-tier
  opportunities across Retail, Services, Entertainment, Manufacturing and
  Tech that unlock as your rank climbs.
- **Real operations.** Every business has a real daily P&L (revenue, COGS,
  payroll, rent, marketing, EBITDA, customer score). "Advance Day" is a
  player-triggered action, not a timer — there's always something to decide.
  Global market cycles (recession / boom / tech bubble) actually move
  revenue, not just flavor text on the feed.
- **AI negotiation.** Acquisitions are negotiated in free text, not YES/NO
  buttons. 10 persistent NPC personalities (greed, desperation,
  stubbornness) evaluate your offer's price, stake, and conditions
  ("stay on as CEO for 2 years") against a deterministic floor. See
  `server/src/engine/negotiation.js`.
- **Decision Engine.** Real events force a real choice — e.g. a manager
  asking for a raise — via fixed options (PAY / NEGOTIATE / OFFER EQUITY /
  REFUSE / FIRE) or your own free-text response, resolved by
  `server/src/engine/decisions.js` into concrete salary/loyalty/ownership
  effects, never just flavor text.
- **Server-authoritative economy.** The client never computes money. Every
  dollar — revenue, valuation, net worth, loan interest — is computed once,
  server-side, by pure functions in `server/src/engine/economy.js`. The
  "AI" layer only ever proposes decisions; it can't create or destroy money.
- **100 ranks**, Hustler → The Shark, each with a title and a real unlock,
  all visible from rank 1.
- **Franchising.** Open a second (third, fourth...) location of a business
  you already run once you hit rank 10.
- **Investing.** Take a minority stake (capped at 40%, so it can never buy
  control) in another player's — or a simulated competitor's — company.
- **Loans & leverage**, real estate (including scarce, one-owner landmark
  properties, and a renovate action that raises value and income), random
  business events, a global feed, leaderboards, and a permanent
  legacy/achievement log (first company, first million, first bankruptcy,
  first acquisition, first $100M company, biggest deal, biggest loss,
  reached #1, ...). Bankruptcy resets your businesses and debt, not your
  account — the comeback is part of the game.

## Architecture

```
client/   React + Vite, mobile-first (works as a desktop app frame too)
server/   Express API — the only place money math happens
schema.sql  Production Postgres schema (the target; see below)
```

### Server

```
server/src/
  data/        ranks.js (100 ranks), industries.js, npcs.js, events.js
  db/          store.js (persistence), seed.js
  engine/      economy.js (P&L/valuation/net worth), negotiation.js (AI deals)
  services/    playerState.js (net worth/rank recompute, legacy, world feed)
  routes/      players, business, deals (negotiation/loans/real estate), world
  server.js
```

**Persistence.** The MVP ships with a file-backed JSON store
(`server/src/db/store.js`) so it runs with zero infrastructure — clone and
play. Every table in `schema.sql` (the intended production Postgres schema)
has a matching in-memory collection with the same shape. Routes and engines
only ever call the store's functions (`get`/`where`/`insert`/`update`),
never touch the filesystem directly, so swapping in a real Postgres
repository behind the same function signatures is the entire production
migration — no route or engine code changes.

**Economy engine is deterministic.** `runDayForBusiness`, `valuation`,
`computeNetWorth`, and loan interest are pure functions of their inputs
(plus an injectable `rng` for tests). A business's valuation ramps from its
purchase price toward its trailing-EBITDA multiple over ~30 days of
operating history, rather than jumping to full value after one lucky day —
that's also what keeps a legitimate acquisition from crashing your net
worth to zero the instant it closes (the new business starts at what you
paid for it, not at zero).

**Negotiation engine is rule-based, not a live LLM call**, by design:
`parseOffer` extracts price / stake / conditions from free text, and
`evaluateNegotiationTurn` compares your offer to the NPC's personality-driven
floor. It's isolated behind one function boundary specifically so a real
model call can replace it later without touching routes or the money math —
the negotiation layer only ever *proposes* a price; `finalizeAcquisition` in
`routes/deals.js` is what actually moves money, and it re-validates cash
server-side no matter what the negotiation decided.

**Anti-cheat.** The client holds no source of truth for cash, valuation,
rank, or ownership — it only renders what `/api/players/:id` returns. All
mutations are POST endpoints that re-derive the current state from the
store, validate against it, and recompute net worth/rank server-side.

### Client

Single-page React app, no router library — a small `view` state machine in
`App.jsx` switches screens. Five-tab bottom nav (Home / Empire / Deals /
Estate / World) for primary destinations; drill-in screens (opportunities,
business detail, negotiation chat, ranks, legacy) use an explicit back
button and hide the nav to keep focus. Renders as a mobile app frame that
also centers nicely as a desktop card (see `index.css`).

## Running it

```bash
npm install                 # installs both workspaces
npm run seed --workspace=server   # optional — server also seeds on first boot
npm run dev                 # server on :4000, client on :5173 (proxies /api)
```

Open http://localhost:5173. The client always talks to `/api`; Vite proxies
that to the server in dev, and the server serves the built client directly
in production.

**Production build:**

```bash
npm run build     # builds client/dist
npm start          # serves client/dist + API from one Express process, :4000
```

Set `PORT` to change the listen port. No environment variables or external
services are required to run the MVP.

**Tests:**

```bash
npm test --workspace=server   # node:test — economy, negotiation, ranks
```

## Moving to production infrastructure

1. Stand up Postgres and run `schema.sql`.
2. Replace `server/src/db/store.js` with a repository module exposing the
   same `db.<table>.get/where/insert/update` shape, backed by SQL queries.
   Nothing in `routes/` or `engine/` needs to change.
3. Swap `engine/negotiation.js`'s `evaluateNegotiationTurn` for a real model
   call if you want live LLM negotiation instead of the rule-based engine —
   the function signature (business + offer + player message in, a decision
   + proposed price/stake out) is already the seam for it. The economy
   engine still owns all money math either way.
4. Add real auth (the MVP identifies players by the `profile_id` created at
   onboarding, stored in `localStorage` — fine for a demo, not for
   production multiplayer).

## What's intentionally not in this slice

Full spec sections not implemented in this pass: hostile takeovers between
real players, multiplayer investment/partnership between two live accounts,
franchising, the AI Game Master content pipeline, and the viral-content
export engine. The architecture (server-authoritative economy, isolated
negotiation seam, full schema) is built to grow into those rather than be
rewritten for them.
