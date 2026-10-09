# CopyBolt

AI marketing copy in one click — ad headlines, product descriptions, social captions, and email subject lines. Free tier (5/day), a $9/mo subscription, built-in referrals, and a daily streak.

## Running it yourself (no setup required)

```
npm install
npm run build
npm start
```

Then open http://localhost:4000. It works immediately with zero configuration:
- **AI generation**: without an Anthropic key, it uses a clearly-labeled "Demo mode" template so the whole product works end to end. Add a real key (see below) to get real AI-written copy.
- **Payments**: without Stripe keys, the "Upgrade to Pro" button is simply hidden and the app tells users billing isn't set up yet. Nothing breaks.

## Turning on the real stuff (optional)

Set these as environment variables (on Render: Dashboard → your service → Environment):

| Variable | What it's for | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Real AI-generated copy instead of demo templates | console.anthropic.com → API Keys |
| `ADMIN_EMAIL` | Which account can see the `/admin` analytics dashboard | Your own email, e.g. `shlomitabero79@gmail.com` |
| `STRIPE_SECRET_KEY` | Lets the app create real Stripe subscriptions | dashboard.stripe.com → Developers → API keys |
| `STRIPE_PRICE_ID` | Which Stripe Price to charge for the Pro plan | dashboard.stripe.com → Product catalog → create a $9/month recurring price, copy its ID (starts with `price_`) |
| `STRIPE_WEBHOOK_SECRET` | Lets Stripe securely tell the app when someone pays | dashboard.stripe.com → Developers → Webhooks → add endpoint `https://your-app.onrender.com/api/billing/webhook`, select events `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` |
| `JWT_SECRET` | Keeps people logged in across server restarts | Any long random string (Render can auto-generate this) |

None of these are required to see the full product working — they just turn on real money and real AI.

## Important: data storage

This app currently stores everything (users, generations, subscriptions) in a JSON file on disk, not a database. That means **all data is lost whenever the server restarts or redeploys** on most free hosting. This is fine for demoing and testing the product end to end, but before relying on this for real paying users, it should be migrated to a real database (e.g. Postgres/Supabase) — every place that touches data goes through one file (`server/src/db/store.js`), so that migration only requires rewriting that one file.

## How it's built

- `server/` — Express API. Pure business logic (paywall limits, referral crediting, streaks, AI prompt-building) lives in `server/src/engine/*.js` as plain functions with no I/O, each covered by unit tests in `server/src/engine/*.test.js`. Run them with `npm test`.
- `client/` — React (Vite) frontend: landing page, signup/login, the copy generator, account/billing page, and the admin analytics dashboard.
- `render.yaml` — one-click deploy blueprint for Render.
