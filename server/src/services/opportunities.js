import { db, makeId } from '../db/store.js';
import { draftProduct } from '../engine/productDraft.js';
import { resolveDefaultPriceUSD } from '../engine/pricing.js';
import { logAction } from './execution.js';

// Caps how many unpublished, non-demo drafts can pile up before a new one
// is drafted — the owner still has to look at each one eventually, so this
// avoids churning out drafts nobody will ever review. Originally only
// enforced by the autonomous scan loop; shared here so the owner's own
// manual "new digital product" form respects the same limit, since it has
// no cap of its own otherwise and each draft is a real, billed AI call —
// an API client bug or a stolen owner token looping this route would
// otherwise have no limit at all on real-money AI spend.
export const MAX_PENDING_DRAFTS = 5;

export function pendingDraftCount() {
  // A demo draft (created while ANTHROPIC_API_KEY wasn't set) can never
  // actually be published - publishing.js refuses it - and there's no
  // route to delete an opportunity, so it would sit as 'draft' forever and
  // permanently eat into this cap for no reason if counted.
  return db.opportunities.where((o) => o.status === 'draft' && !o.productDraft?.demo).length;
}

// Guards the gap between reading pendingDraftCount() and actually
// inserting the new draft below. Without this, two near-simultaneous calls
// into createDigitalProductOpportunityUnderCap (the owner's own manual
// form double-clicked or left open in two tabs, or a scripted client
// looping the route) could each read the count before either had written —
// letting through more real, billed AI calls than MAX_PENDING_DRAFTS was
// ever meant to allow, exactly the risk createDigitalProduct's own comment
// in routes/opportunities.js warns about. autonomousScan.js's own
// scanInProgress flag already closes the equivalent race between ITS two
// triggers (the startup catch-up and the 4-hour cron tick), but never
// covered this path — both callers used to do their own separate
// "check pendingDraftCount, then create" instead of going through one
// shared, locked chokepoint.
let draftCreationInProgress = false;

// The one chokepoint both callers (the manual route and the autonomous
// scan) now go through for the actual check-and-create — see the comment
// on draftCreationInProgress above for why a plain pendingDraftCount()
// check immediately before this call isn't enough on its own.
export async function createDigitalProductOpportunityUnderCap({ topic, audience, createdBy }) {
  if (draftCreationInProgress) {
    return { ok: false, concurrent: true };
  }
  draftCreationInProgress = true;
  try {
    const pendingDrafts = pendingDraftCount();
    if (pendingDrafts >= MAX_PENDING_DRAFTS) {
      return { ok: false, concurrent: false, pendingDrafts };
    }
    const opportunity = await createDigitalProductOpportunity({ topic, audience, createdBy });
    return { ok: true, opportunity };
  } finally {
    draftCreationInProgress = false;
  }
}

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
    priceUSD: resolveDefaultPriceUSD(process.env.DEFAULT_PRODUCT_PRICE_USD),
    paddlePriceId: null,
    slug: null,
    salesCount: 0,
    createdAt: new Date().toISOString(),
    createdBy,
  });

  logAction({ type: 'draft_product', detail: { opportunityId: opportunity.id, topic, demo: draft.demo, createdBy }, result: 'success' });
  return opportunity;
}
