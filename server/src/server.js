import express from 'express';
import cron from 'node-cron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { settingsRouter } from './routes/settings.js';
import { sourcesRouter } from './routes/sources.js';
import { opportunitiesRouter } from './routes/opportunities.js';
import { productsRouter } from './routes/products.js';
import { approvalsRouter } from './routes/approvals.js';
import { ledgerRouter } from './routes/ledger.js';
import { actionsRouter } from './routes/actions.js';
import { billingRouter, paddleWebhookHandler } from './routes/billing.js';
import { financialRouter } from './routes/financial.js';
import { digestRouter } from './routes/digest.js';
import { syncSources } from './services/sources.js';
import { generateDailyDigest, catchUpDailyDigestIfMissed } from './services/digest.js';
import { runAutonomousScan, catchUpAutonomousScanIfMissed } from './services/autonomousScan.js';
import { classifyApiError } from './engine/apiError.js';
import { securityHeaders } from './middleware/securityHeaders.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;

// asyncHandler.js already solves this for every Express route handler - a
// rejected promise anywhere else (a dependency's own internal async code,
// a future call site that forgets its own .catch()) would otherwise crash
// the entire process by default, taking down the owner's autonomous
// engine for however long it takes Railway to notice and restart it, over
// one failure anywhere in the process. Log it loudly instead, matching
// every other failure path in this app, and keep running - an unhandled
// rejection on its own doesn't mean the process's state is actually
// corrupted. A genuinely uncaught synchronous exception is the different,
// riskier case Node's own docs warn about: by the time it's caught here
// the process may already be in a broken state, so log it and exit
// instead of trying to keep serving requests from it - Railway restarts a
// crashed process automatically.
process.on('unhandledRejection', (reason) => {
  console.error('unhandled promise rejection', reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaught exception — exiting so the platform can restart cleanly', err);
  process.exit(1);
});

const app = express();
// Railway (like Render/Heroku) terminates TLS at its own edge and forwards
// requests through a reverse proxy — without this, req.ip on every request
// reads as that proxy's own address, not the real client's, which would
// turn the login route's per-source rate limiter below into one shared
// global bucket (an attacker and the real owner indistinguishable, each
// exhausting the other's allowance) instead of tracking each source
// separately. Trusting exactly 1 hop reads the real client IP from
// X-Forwarded-For as set by Railway's own edge, not an arbitrary header an
// attacker could forge directly.
app.set('trust proxy', 1);
// No app.use(cors()) here on purpose: the client only ever calls this API
// as a relative /api/... path - fetch('/api/...') in client/src/api.js, and
// client/vite.config.js's dev-server proxy forwards /api requests to this
// server too - so every real request this app's own client ever makes is
// same-origin, in both development and production. CORS only governs
// cross-origin requests; leaving it enabled here (the previous default,
// `cors()` with no options, allows ANY origin) served no purpose for this
// app's own usage and only widened who could read a response from this
// API's two unauthenticated routes (the public product page, the Paddle
// webhook) from a browser running on some other site.
app.use(securityHeaders);

// Paddle needs the raw body to verify the webhook signature, so this is
// mounted before the global express.json() parser below.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), paddleWebhookHandler);

app.use(express.json());

app.use('/api', healthRouter);
app.use('/api', authRouter);
app.use('/api', settingsRouter);
app.use('/api', sourcesRouter);
app.use('/api', opportunitiesRouter);
app.use('/api', productsRouter);
app.use('/api', approvalsRouter);
app.use('/api', ledgerRouter);
app.use('/api', actionsRouter);
app.use('/api', billingRouter);
app.use('/api', financialRouter);
app.use('/api', digestRouter);

app.use((err, req, res, next) => {
  console.error(err);
  const { status, message } = classifyApiError(err);
  res.status(status).json({ error: message });
});

const clientDist = join(__dirname, '..', '..', 'client', 'dist');
if (existsSync(clientDist)) {
  // This app redeploys roughly hourly (its own upgrade routine), and each
  // Vite build gives every JS/CSS bundle a fresh content hash but
  // index.html always keeps the same name - without an explicit
  // Cache-Control, express.static sets none at all, leaving browsers to
  // their own heuristic caching of index.html. A browser that caches an
  // old index.html past the next deploy then requests a bundle filename
  // (e.g. index-OLDHASH.js) that no longer exists in the new dist folder,
  // breaking the app with a 404 until a hard refresh - a real, recurring
  // risk given how often this specific app redeploys. The hashed asset
  // files themselves are the opposite case: once built, that exact
  // filename's content never changes, so they're safe to cache for a year.
  app.use(express.static(clientDist, {
    setHeaders: (res, filePath) => {
      res.setHeader('Cache-Control', filePath.endsWith('index.html')
        ? 'no-cache'
        : 'public, max-age=31536000, immutable');
    },
  }));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(clientDist, 'index.html'));
  });
}

syncSources();

// This app gets redeployed roughly hourly by its own upgrade routine, so
// the 7am cron tick below has a real chance of landing in the middle of a
// restart and never firing that day. Self-heal on boot instead of silently
// skipping a day's digest - generateDailyDigest() is idempotent per day, so
// this is always safe even if the process happens to restart again later
// the same morning.
try {
  catchUpDailyDigestIfMissed();
} catch (err) {
  console.error('catch-up daily digest failed', err);
}

// Same self-healing reasoning as the digest catch-up above, for the
// autonomous scan's own '0 */4 * * *' cron tick: don't let the single most
// important recurring action this app takes go quiet for longer than its
// normal 4-hour cadence just because a restart happened to land near the
// wrong minute.
catchUpAutonomousScanIfMissed().catch((err) => console.error('catch-up autonomous scan failed', err));

// In-process scheduler. This only runs while the Node process stays alive —
// on Render's free tier the service can spin down when idle, so this is not
// a guarantee of "runs even when nobody has the app open." See README for
// the free external-ping workaround.
//
// node-cron's default timezone is the server process's own local time,
// which on Railway (and most hosts) is UTC, not the owner's - this app is
// built for a Hebrew-speaking, Israel-based owner throughout (currency,
// language, Paddle chosen for Israeli payouts), so "7am" without this
// would actually fire at 9-10am Israel time depending on daylight saving,
// not the owner's real morning. catchUpDailyDigestIfMissed's own hour
// check below is kept in sync with this via israelHour().
cron.schedule('0 7 * * *', () => {
  try {
    syncSources();
    generateDailyDigest();
  } catch (err) {
    console.error('scheduled daily job failed', err);
  }
}, { timezone: 'Asia/Jerusalem' });

// The actual "keep looking for revenue" loop — runs every few hours, not
// just once a day, so the system is genuinely searching on its own rather
// than waiting for the owner to type in a topic.
cron.schedule('0 */4 * * *', () => {
  runAutonomousScan().catch((err) => console.error('autonomous scan failed', err));
});

app.listen(PORT, () => {
  console.log(`PROFIT AI server listening on http://localhost:${PORT}`);
});
