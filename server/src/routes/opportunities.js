import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
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
export async function createDigitalProduct(req, res) {
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
}

// Manually trigger the same scan the scheduler runs periodically — useful to
// test the autonomous loop without waiting for the next scheduled run.
export async function triggerAutonomousScan(req, res) {
  const result = await runAutonomousScan();
  res.json(result);
}

export function listOpportunities(req, res) {
  const withFeas = db.opportunities.all().map(withFeasibility);
  res.json({ opportunities: rankOpportunities(withFeas) });
}

export function getOpportunity(req, res) {
  const opportunity = db.opportunities.get(req.params.id);
  if (!opportunity) return res.status(404).json({ error: 'not found' });
  res.json({ opportunity: withFeasibility(opportunity) });
}

const EDITABLE_FIELDS = ['revenueEstimate', 'costs', 'riskLevel', 'dataQuality', 'priceUSD', 'missingInfo'];

// A non-finite value here wouldn't crash anything — it would silently
// corrupt computeNetProfit's totals (NaN propagating through the profit
// math) instead of being rejected, so the dashboard would show "₪NaN" to
// the owner instead of a clear error. Reject it at the door.
function isFiniteOrNullish(value) {
  return value == null || (typeof value === 'number' && Number.isFinite(value));
}

export function patchOpportunity(req, res) {
  const opportunity = db.opportunities.get(req.params.id);
  if (!opportunity) return res.status(404).json({ error: 'not found' });
  const patch = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in (req.body ?? {})) patch[field] = req.body[field];
  }

  if ('revenueEstimate' in patch && patch.revenueEstimate !== null) {
    const { low, mid, high } = patch.revenueEstimate ?? {};
    if (!isFiniteOrNullish(low) || !isFiniteOrNullish(mid) || !isFiniteOrNullish(high)) {
      return res.status(400).json({ error: 'revenueEstimate.low/mid/high must each be a finite number (or omitted)' });
    }
  }
  if ('costs' in patch && patch.costs != null) {
    for (const [key, value] of Object.entries(patch.costs)) {
      if (!isFiniteOrNullish(value)) {
        return res.status(400).json({ error: `costs.${key} must be a finite number or null (unknown)` });
      }
    }
  }
  // priceUSD, unlike revenueEstimate/costs, is never meaningfully "unknown" —
  // a product always has a real price — so null is rejected here too, not
  // just non-numbers; `patch.priceUSD <= 0` alone would wrongly let null
  // slip through on the "null <= 0" coercion.
  if ('priceUSD' in patch && !(typeof patch.priceUSD === 'number' && Number.isFinite(patch.priceUSD) && patch.priceUSD > 0)) {
    return res.status(400).json({ error: 'priceUSD must be a positive number' });
  }
  // Once published, priceUSD is baked into a real Paddle price object
  // (publishing.js never updates an existing one — there's no API for
  // that) — the live sales page and the actual checkout amount are fixed
  // to whatever it was at publish time. Letting it be edited afterward
  // would silently desync the dashboard's number from what a real
  // customer is actually charged.
  if ('priceUSD' in patch && opportunity.status === 'published') {
    return res.status(400).json({ error: 'priceUSD cannot be changed after publishing — the live price is already fixed in Paddle' });
  }

  const updated = db.opportunities.update(req.params.id, patch);
  res.json({ opportunity: withFeasibility(updated) });
}

// The gated, idempotent, audit-logged action that actually makes the
// product public. Blocked unless the mode/approval/budget gate allows it
// (research mode, no approval yet, or emergency stop).
export async function publishOpportunityRoute(req, res) {
  const opportunity = db.opportunities.get(req.params.id);
  if (!opportunity) return res.status(404).json({ error: 'not found' });
  // Without this, hitting publish again on an already-live opportunity (a
  // stray repeat request, a retried script) would sail through the
  // idempotency check — that key is scoped per day, so a next-day call
  // slips past it — and write a fresh "publish_product: success" entry to
  // the audit log even though nothing actually happened: perform() finds
  // paddlePriceId/slug already set and just re-saves the same status.
  if (opportunity.status === 'published') {
    return res.status(409).json({ error: 'already published', duplicate: true });
  }
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
}

opportunitiesRouter.post('/opportunities/digital-product', requireOwner, asyncHandler(createDigitalProduct));
opportunitiesRouter.post('/opportunities/autonomous-scan', requireOwner, asyncHandler(triggerAutonomousScan));
opportunitiesRouter.get('/opportunities', requireOwner, listOpportunities);
opportunitiesRouter.get('/opportunities/:id', requireOwner, getOpportunity);
opportunitiesRouter.patch('/opportunities/:id', requireOwner, patchOpportunity);
opportunitiesRouter.post('/opportunities/:id/publish', requireOwner, asyncHandler(publishOpportunityRoute));
