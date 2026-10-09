import { db, makeId } from '../db/store.js';
import { draftProduct } from '../engine/productDraft.js';
import { logAction } from './execution.js';

// Shared by the owner's manual "new digital product" form and the
// autonomous scan loop, so both produce identically-shaped, honest
// opportunity cards — demand is never fabricated here, only drafted.
export async function createDigitalProductOpportunity({ topic, audience, createdBy = 'owner' }) {
  const draft = await draftProduct({ topic, audience });

  const opportunity = db.opportunities.insert({
    id: makeId('opp'),
    source: 'ai_digital_products',
    title: draft.title,
    what: `מוצר דיגיטלי: ${draft.title}`,
    whoPays: 'לקוחות קצה שקונים את המוצר בדף המכירה',
    why: `עוזר ל: ${audience}`,
    sourceLink: null,
    capitalRequired: 0,
    timeToCashDays: 1,
    revenueEstimate: null, // unknown until the owner sets their own estimate
    costs: { aiUsage: 0.05, paymentProcessing: null }, // Paddle's % fee is unknown until a real sale happens
    riskLevel: 'medium',
    dataQuality: 'unknown',
    missingInfo: [
      'revenueEstimate — no real demand data connected yet; set your own estimate',
      "cost:paymentProcessing — depends on Paddle's actual fee at sale time",
    ],
    status: 'draft',
    productDraft: draft,
    priceUSD: Number(process.env.DEFAULT_PRODUCT_PRICE_USD ?? 9),
    paddlePriceId: null,
    slug: null,
    salesCount: 0,
    createdAt: new Date().toISOString(),
    createdBy,
  });

  logAction({ type: 'draft_product', detail: { opportunityId: opportunity.id, topic, demo: draft.demo, createdBy }, result: 'success' });
  return opportunity;
}
