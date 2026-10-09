import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { authRouter } from './routes/auth.js';
import { generateRouter } from './routes/generate.js';
import { billingRouter, stripeWebhookHandler } from './routes/billing.js';
import { adminRouter } from './routes/admin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());

// Stripe needs the raw body to verify the webhook signature, so this is
// mounted before the global express.json() parser below.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

app.use(express.json());

app.get('/api/health', (req, res) => res.json({
  ok: true,
  name: 'CopyBolt',
  aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
  billingConfigured: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID),
}));

app.use('/api', authRouter);
app.use('/api', generateRouter);
app.use('/api', billingRouter);
app.use('/api', adminRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const clientDist = join(__dirname, '..', '..', 'client', 'dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(join(clientDist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`CopyBolt server listening on http://localhost:${PORT}`);
});
