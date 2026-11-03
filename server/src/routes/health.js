import { Router } from 'express';
import { isPaddleConfigured } from '../services/paddle.js';

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
    // Reuses the exact same check the real publish/checkout gate uses
    // (services/paddle.js) rather than its own separate copy, which had
    // drifted to only check two of the three vars Paddle actually needs.
    billingConfigured: isPaddleConfigured(),
    marketDataConfigured: Boolean(process.env.MARKET_DATA_API_KEY),
    ownerPasswordConfigured: Boolean(process.env.OWNER_PASSWORD),
  });
}

healthRouter.get('/health', getHealth);
