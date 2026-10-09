import { db } from '../db/store.js';
import { createOneTimePrice } from './paddle.js';
import { executeGatedAction } from './execution.js';

// The gated, idempotent action that actually makes a product public: creates
// a real Paddle price (if needed) and a slug for the public sales page.
// Shared by the owner's manual "publish" button and the autonomous scan loop
// so both go through the exact same mode/budget gate and audit trail.
export async function publishOpportunity(opportunity) {
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
