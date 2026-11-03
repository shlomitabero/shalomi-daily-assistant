import { db } from '../db/store.js';
import { createOneTimePrice } from './paddle.js';
import { executeGatedAction, logAction } from './execution.js';

// The gated, idempotent action that actually makes a product public: creates
// a real Paddle price (if needed) and a slug for the public sales page.
// Shared by the owner's manual "publish" button and the autonomous scan loop
// so both go through the exact same mode/budget gate and audit trail.
export async function publishOpportunity(opportunity) {
  // A demo draft (productDraft.demo === true, created when ANTHROPIC_API_KEY
  // wasn't set) is placeholder content — its own guide text literally says
  // "connect ANTHROPIC_API_KEY for real content". ProductPage.jsx shows a
  // banner calling it out as demo, but that banner never disabled the real
  // "קנה עכשיו" button — without this, a demo draft could reach a real
  // Paddle checkout and charge a real customer real money for content this
  // app itself admits isn't real.
  if (opportunity.productDraft?.demo) {
    logAction({ type: 'publish_product', detail: { opportunityId: opportunity.id }, result: 'blocked: demo content can never be published for real money' });
    return { allowed: false, reason: 'מוצר דמו (ללא AI אמיתי מחובר) — אסור לפרסם ולגבות כסף על תוכן דמו' };
  }
  return executeGatedAction({
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
}
