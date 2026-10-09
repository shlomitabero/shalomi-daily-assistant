import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { db, makeId } from '../db/store.js';
import { draftProduct } from '../engine/productDraft.js';
import { computeNetProfit } from '../engine/feasibility.js';
import { rankOpportunities } from '../engine/ranking.js';
import { createOneTimePrice, isPaddleConfigured } from '../services/paddle.js';
import { executeGatedAction, logAction } from '../services/execution.js';

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

  let draft;
  try {
    draft = await draftProduct({ topic: topic.trim(), audience: audience.trim() });
  } catch (err) {
    return res.status(502).json({ error: `product drafting failed: ${err.message}` });
  }

  const opportunity = db.opportunities.insert({
    id: makeId('opp'),
    source: 'ai_digital_products',
    title: draft.title,
    what: `מוצר דיגיטלי: ${draft.title}`,
    whoPays: 'לקוחות קצה שקונים את המוצר בדף המכירה',
    why: `עוזר ל: ${audience.trim()}`,
    sourceLink: null,
    capitalRequired: 0,
    timeToCashDays: 1,
    revenueEstimate: null, // unknown until the owner sets their own estimate
    costs: { aiUsage: 0.05, paymentProcessing: null }, // Paddle's % fee is unknown until a real sale happens
    riskLevel: 'medium',
    dataQuality: 'unknown',
    missingInfo: ['revenueEstimate — no real demand data connected yet; set your own estimate', 'cost:paymentProcessing — depends on Paddle\'s actual fee at sale time'],
    status: 'draft',
    productDraft: draft,
    priceUSD: Number(process.env.DEFAULT_PRODUCT_PRICE_USD ?? 9),
    paddlePriceId: null,
    slug: null,
    salesCount: 0,
    createdAt: new Date().toISOString(),
  });

  logAction({ type: 'draft_product', detail: { opportunityId: opportunity.id, topic, demo: draft.demo }, result: 'success' });
  res.status(201).json({ opportunity: withFeasibility(opportunity) });
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
// product public: creates a real Paddle price (if needed) and a slug for
// the public sales page. Blocked unless the mode/approval/budget gate
// allows it (research mode, no approval yet, or emergency stop).
opportunitiesRouter.post('/opportunities/:id/publish', requireOwner, async (req, res) => {
  const opportunity = db.opportunities.get(req.params.id);
  if (!opportunity) return res.status(404).json({ error: 'not found' });
  if (!isPaddleConfigured()) {
    logAction({ type: 'publish_product', detail: { opportunityId: opportunity.id }, result: 'blocked: Paddle is not configured yet' });
    return res.status(503).json({ error: 'Paddle is not configured yet — cannot open real checkout' });
  }

  let result;
  try {
    result = await executeGatedAction({
      opportunityId: opportunity.id,
      actionType: 'publish_product',
      amount: 0,
      perform: async () => {
        let { paddlePriceId, slug } = opportunity;
        if (!paddlePriceId) {
          const { priceId } = await createOneTimePrice({
            name: opportunity.title,
            amountCents: Math.round(opportunity.priceUSD * 100),
            currencyCode: 'USD',
          });
          paddlePriceId = priceId;
        }
        if (!slug) slug = `${opportunity.id}-${Date.now().toString(36)}`;
        db.opportunities.update(opportunity.id, { status: 'published', paddlePriceId, slug });
        return { paddlePriceId, slug };
      },
    });
  } catch (err) {
    // perform() failed (e.g. Paddle API unreachable) — executeGatedAction
    // already logged it; respond cleanly instead of crashing the process.
    return res.status(502).json({ error: `publish failed: ${err.message}` });
  }

  if (!result.allowed) return res.status(409).json({ error: result.reason, duplicate: Boolean(result.duplicate) });
  res.json({ opportunity: withFeasibility(db.opportunities.get(opportunity.id)) });
});
