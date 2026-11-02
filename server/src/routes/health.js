import { Router } from 'express';

export const healthRouter = Router();

// Public, unauthenticated: used both by the owner (confirming which real
// integrations are actually wired up) and by an external pinger (see
// README's "Scheduler" section) to keep a free-tier host from spinning
// down. Never fabricates a "configured" flag — each one reads the exact
// same env var the thing it describes actually depends on.
export function getHealth(req, res) {
  res.json({
    ok: true,
    name: 'PROFIT AI',
    aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    billingConfigured: Boolean(process.env.PADDLE_API_KEY && process.env.PADDLE_CLIENT_TOKEN),
    marketDataConfigured: Boolean(process.env.MARKET_DATA_API_KEY),
    ownerPasswordConfigured: Boolean(process.env.OWNER_PASSWORD),
  });
}

healthRouter.get('/health', getHealth);
