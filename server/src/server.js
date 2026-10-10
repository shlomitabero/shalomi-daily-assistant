import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { generateDailyDigest } from './services/digest.js';
import { runAutonomousScan } from './services/autonomousScan.js';
import { classifyApiError } from './engine/apiError.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());

// Paddle needs the raw body to verify the webhook signature, so this is
// mounted before the global express.json() parser below.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), paddleWebhookHandler);

app.use(express.json());

app.get('/api/health', (req, res) => res.json({
  ok: true,
  name: 'PROFIT AI',
  aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
  billingConfigured: Boolean(process.env.PADDLE_API_KEY && process.env.PADDLE_CLIENT_TOKEN),
  marketDataConfigured: Boolean(process.env.MARKET_DATA_API_KEY),
  ownerPasswordConfigured: Boolean(process.env.OWNER_PASSWORD),
}));

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
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(join(clientDist, 'index.html')));
}

syncSources();

// In-process scheduler. This only runs while the Node process stays alive —
// on Render's free tier the service can spin down when idle, so this is not
// a guarantee of "runs even when nobody has the app open." See README for
// the free external-ping workaround.
cron.schedule('0 7 * * *', () => {
  try {
    syncSources();
    generateDailyDigest();
  } catch (err) {
    console.error('scheduled daily job failed', err);
  }
});

// The actual "keep looking for revenue" loop — runs every few hours, not
// just once a day, so the system is genuinely searching on its own rather
// than waiting for the owner to type in a topic.
cron.schedule('0 */4 * * *', () => {
  runAutonomousScan().catch((err) => console.error('autonomous scan failed', err));
});

app.listen(PORT, () => {
  console.log(`PROFIT AI server listening on http://localhost:${PORT}`);
});
