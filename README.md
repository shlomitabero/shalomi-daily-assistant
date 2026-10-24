# PROFIT AI

An honest, auditable engine for finding, evaluating, and — only with your explicit permission — acting on real revenue opportunities. It never invents prices, demand, or customers; anything it doesn't actually know is shown as **missing**, not guessed.

## Running it yourself (no setup required)

```
npm install
npm run build
npm start
```

Open http://localhost:4000 and log in (see `OWNER_PASSWORD` below — without it, login is refused rather than silently open).

This is a **personal console for one owner**, not a public app — there's a single password, not user accounts.

## What's actually live right now

**One proven revenue path end to end**: AI drafts a real digital product (a short guide) and its sales copy. You review it, set your own price/profit estimate (the system never invents demand numbers), and — once you approve it — it publishes a real sales page with a real Paddle checkout. When someone actually buys, a signed webhook from Paddle confirms the sale and it shows up as **verified** revenue on the dashboard, not a guess.

Everything else — financial markets, affiliate programs, supplier price gaps, tenders — has a real, working *framework* (feasibility scoring, budget gating, the approval workflow) but is honestly marked **not connected** until you supply real credentials for it. The app never pretends to scan sources it has no actual access to.

## The three modes (set in Settings)

- **מחקר (research)** — the system only drafts and analyzes. Nothing is ever published or charged.
- **אישור לביצוע (approve)** — the system prepares a ready action (e.g. "publish this product, price $9") and waits for you to approve that *specific* action before it runs.
- **אוטומטי מוגבל (auto-limited)** — pre-approved actions run automatically, but always still inside your budget and max-loss limits.

**The spending budget is zero until you explicitly set one.** No borrowing, no leverage, no reinvesting revenue automatically — ever.

There's also a big **emergency stop** button in Settings that blocks every action immediately, regardless of mode.

## Turning on the real stuff (optional)

| Variable | What it's for | Where to get it |
|---|---|---|
| `OWNER_PASSWORD` | Your login password — required, there is no default | Pick your own |
| `JWT_SECRET` | Keeps you logged in across server restarts | Any long random string (set it explicitly — if unset, a new random secret is generated on every boot, which logs you out on every redeploy) |
| `DATA_DIR` | Where `db.json` is stored | Point this at a mounted persistent volume on your host (e.g. Railway's volume mount path) so data survives a redeploy |
| `ANTHROPIC_API_KEY` | Real AI-written product content instead of demo placeholders | console.anthropic.com → API Keys |
| `PADDLE_API_KEY` | Lets the server create real checkout prices and open the billing portal | vendors.paddle.com → Developer tools → Authentication |
| `PADDLE_CLIENT_TOKEN` | Lets the checkout popup open in the browser (safe to be public) | same page, "Client-side tokens" |
| `PADDLE_WEBHOOK_SECRET` | Lets Paddle securely confirm a real sale happened | vendors.paddle.com → Notifications → add destination `https://<your-deployed-domain>/api/billing/webhook`, subscribe to `transaction.completed` |
| `PADDLE_ENV` | `sandbox` for fake test purchases (default), `production` once Paddle approves your account | set it yourself |
| `MARKET_DATA_API_KEY` | Turns on real stock-price tracking for the financial module (simulated trading only — see below) | a free-tier provider such as twelvedata.com |

Paddle is used here (not Stripe) because Stripe does not support payouts to Israeli merchant accounts — Paddle is the seller of record and pays you out directly.

## The financial markets module

This tracks real prices (once `MARKET_DATA_API_KEY` is set) and lets you run **simulated** trades that calculate realistic fees and slippage. It **never places a real trade and never touches your real ledger** — there is no broker connection in this build. Real trading would require connecting a real broker account with its own explicit authorization, which this build deliberately does not include.

## Data storage

Everything (opportunities, the ledger, the audit log) is stored in a JSON file on disk (`db.json`), not a real database — every place that touches data goes through one file (`server/src/db/store.js`), so that's the only file a future migration to a real database would touch. Each write goes to a temp file first and is renamed into place, so a crash or redeploy mid-write can't leave a half-written, corrupted file.

Whether data actually survives a redeploy depends entirely on where this runs: on **Render's free tier** (or any host with an ephemeral filesystem), the container's disk is thrown away on every redeploy, so all data is lost unless `DATA_DIR` points at a persistent volume. The deployed instance runs on **Railway** with a volume mounted at `/data` and `DATA_DIR` set to it, so data there does survive redeploys.

## The scheduler

A daily job (source re-check + digest) and the autonomous scan (every 4 hours) run inside the server process via `node-cron`. This only works while the process is alive — on a host that spins the service down when idle (e.g. Render's free tier), this is not a guarantee it runs unattended. A free workaround on such a host: use an external pinger (e.g. cron-job.org) to hit `/api/health` periodically, which keeps the service awake long enough for the scheduled job to fire. Railway's always-on plans don't need this.

## How it's built

- `server/src/engine/*.js` — pure, dependency-free business logic (feasibility math, multi-factor ranking, budget gating, mode gating, ledger math, paper-trading simulation, the daily digest text, idempotency keys, Paddle signature verification).
- `server/src/services/*.js` — the I/O layer (file-backed store, the gated+idempotent+audit-logged execution choke point every paid action goes through, Paddle API calls, market data).
- `server/src/routes/*.js` — thin Express route handlers over the services/engine above.
- `client/` — React (Vite) Hebrew RTL mobile-first dashboard: today's cash in/out, verified net profit (kept separate from forecasts), outstanding receivables, active opportunities, pending approvals, and which sources are actually producing money vs. costing without result.
- `npm test` (run from `server/`) runs the full unit test suite across engine, services and routes.
- `render.yaml` — a one-click deploy blueprint for Render, kept for anyone who prefers that host. The deployed instance actually runs on Railway (see Data storage above).
