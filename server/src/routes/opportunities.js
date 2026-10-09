import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { db } from '../db/store.js';
import { computeNetProfit } from '../engine/feasibility.js';
import { rankOpportunities } from '../engine/ranking.js';
import { isPaddleConfigured } from '../services/paddle.js';
import { logAction } from '../services/execution.js';
import { createDigitalProductOpportunity } from '../services/opportunities.js';
import { publishOpportunity } from '../services/publishing.js';
import { runAutonomousScan } from '../services/autonomousScan.js';

export const opportunitiesRouter = Router();

function withFeasibility(opportunity) {
  const feasibility = computeNetProfit({ revenueEstimate: opportunity.revenueEstimate, costs: opportunity.costs });
  const netProfitMid = feasibility.netProfit?.mid ?? null;
  return { ...opportunity, feasibility, netProfitMid };
}

// The one proven end-to-end path: AI drafts a real digital product + sales
// copy. Demand/revenue is left as missing data (never fabricated) until the
// owner sets their own estimate on the card.
opportunitiesRouter.post('/opportunities/digital-product', requireOwner, async (req, res) => {
  const { topic, audience } = req.body ?? {};
  if (!topic || !topic.trim()) return res.status(400).json({ error: 'topic is required' });
  if (!audience || !audience.trim()) return res.status(400).json({ error: 'audience is required' });

  let opportunity;
  try {
    opportunity = await createDigitalProductOpportunity({ topic: topic.trim(), audience: audience.trim(), createdBy: 'owner' });
  } catch (err) {
    return res.status(502).json({ error: `product drafting failed: ${err.message}` });
  }

  res.status(201).json({ opportunity: withFeasibility(opportunity) });
});

// Manually trigger the same scan the scheduler runs periodically — useful to
// test the autonomous loop without waiting for the next scheduled run.
opportunitiesRouter.post('/opportunities/autonomous-scan', requireOwner, async (req, res) => {
  const result = await runAutonomousScan();
  res.json(result);
});

opportunitiesRouter.get('/opportunities', requireOwner, (req, res) => {
  const withFeas = db.opportunities.all().map(withFeasibility);
  res.json({ opportunities: rankOpportunities(withFeas) });
});

opportunitiesRouter.get('/opportunities/:id', requireOwner, (req, res) => {
  const opportunity = db.opportunities.get(req.params.id);
  if (!opportunity) return res.status(404).json({ error: 'not found' });
  res.json({ opportunity: withFeasibility(opportunity) });
});

const EDITABLE_FIELDS = ['revenueEstimate', 'costs', 'riskLevel', 'dataQuality', 'priceUSD', 'missingInfo'];

opportunitiesRouter.patch('/opportunities/:id', requireOwner, (req, res) => {
  const opportunity = db.opportunities.get(req.params.id);
  if (!opportunity) return res.status(404).json({ error: 'not found' });
  const patch = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in (req.body ?? {})) patch[field] = req.body[field];
  }
  const updated = db.opportunities.update(req.params.id, patch);
  res.json({ opportunity: withFeasibility(updated) });
});

// The gated, idempotent, audit-logged action that actually makes the
// product public. Blocked unless the mode/approval/budget gate allows it
// (research mode, no approval yet, or emergency stop).
opportunitiesRouter.post('/opportunities/:id/publish', requireOwner, async (req, res) => {
  const opportunity = db.opportunities.get(req.params.id);
  if (!opportunity) return res.status(404).json({ error: 'not found' });
  if (!isPaddleConfigured()) {
    logAction({ type: 'publish_product', detail: { opportunityId: opportunity.id }, result: 'blocked: Paddle is not configured yet' });
    return res.status(503).json({ error: 'Paddle is not configured yet — cannot open real checkout' });
  }

  let result;
  try {
    result = await publishOpportunity(opportunity);
  } catch (err) {
    // perform() failed (e.g. Paddle API unreachable) — executeGatedAction
    // already logged it; respond cleanly instead of crashing the process.
    return res.status(502).json({ error: `publish failed: ${err.message}` });
  }

  if (!result.allowed) return res.status(409).json({ error: result.reason, duplicate: Boolean(result.duplicate) });
  res.json({ opportunity: withFeasibility(db.opportunities.get(opportunity.id)) });
});
