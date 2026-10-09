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
- **Payments**: without Paddle keys, the "Upgrade to Pro" button is simply hidden and the app tells users billing isn't set up yet. Nothing breaks.

## Why Paddle and not Stripe

Stripe does not support payouts to Israeli merchant accounts, so this app uses **Paddle** instead. Paddle is a "merchant of record" — Paddle itself is legally the seller, it handles VAT/sales tax worldwide for you, and it pays *you* out directly (bank transfer or PayPal), so you don't need a US or EU company to sell internationally. Setup is similar to Stripe: create a Paddle account, create one subscription product/price, and copy a few keys below.

## Turning on the real stuff (optional)

Set these as environment variables (on Render: Dashboard → your service → Environment):

| Variable | What it's for | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Real AI-generated copy instead of demo templates | console.anthropic.com → API Keys |
| `ADMIN_EMAIL` | Which account can see the `/admin` analytics dashboard | Your own email, e.g. `shlomitabero79@gmail.com` |
| `PADDLE_API_KEY` | Lets the server open the "manage billing" portal for subscribers | vendors.paddle.com → Developer tools → Authentication → API keys |
| `PADDLE_CLIENT_TOKEN` | Lets the checkout popup open in the browser (safe to be public) | vendors.paddle.com → Developer tools → Authentication → Client-side tokens |
| `PADDLE_PRICE_ID` | Which Paddle Price to charge for the Pro plan | vendors.paddle.com → Catalog → Products → create a $9/month recurring price, copy its ID (starts with `pri_`) |
| `PADDLE_WEBHOOK_SECRET` | Lets Paddle securely tell the app when someone pays | vendors.paddle.com → Developer tools → Notifications → add a destination `https://your-app.onrender.com/api/billing/webhook`, subscribe to `subscription.created`, `subscription.updated`, `subscription.canceled`, then copy its secret key |
| `PADDLE_ENV` | `sandbox` while testing (fake cards, no real money), `production` once Paddle approves your account and you're ready for real payments | set it yourself |
| `JWT_SECRET` | Keeps people logged in across server restarts | Any long random string (Render can auto-generate this) |

None of these are required to see the full product working — they just turn on real money and real AI.

Note: Paddle reviews every new account before letting it take real payments (usually within a day or so) — while that's pending, use `PADDLE_ENV=sandbox` with Paddle's test card numbers to try the entire paid flow for free.

## Important: data storage

This app currently stores everything (users, generations, subscriptions) in a JSON file on disk, not a database. That means **all data is lost whenever the server restarts or redeploys** on most free hosting. This is fine for demoing and testing the product end to end, but before relying on this for real paying users, it should be migrated to a real database (e.g. Postgres/Supabase) — every place that touches data goes through one file (`server/src/db/store.js`), so that migration only requires rewriting that one file.

## How it's built

- `server/` — Express API. Pure business logic (paywall limits, referral crediting, streaks, AI prompt-building) lives in `server/src/engine/*.js` as plain functions with no I/O, each covered by unit tests in `server/src/engine/*.test.js`. Run them with `npm test`.
- `client/` — React (Vite) frontend: landing page, signup/login, the copy generator, account/billing page, and the admin analytics dashboard.
- `render.yaml` — one-click deploy blueprint for Render.
