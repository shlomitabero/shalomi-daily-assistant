import { Router } from 'express';
import { db } from '../db/store.js';
import { paddleClientConfig } from '../services/paddle.js';

// Public, unauthenticated: this is the actual sales page customers land on.
export const productsRouter = Router();

// status === 'published' is load-bearing: a draft opportunity (one the
// owner hasn't approved and published yet) must never be reachable by its
// slug, even if a customer somehow guesses or is given the URL early.
export function getProductBySlug(req, res) {
  const opportunity = db.opportunities.where((o) => o.slug === req.params.slug && o.status === 'published')[0];
  if (!opportunity) return res.status(404).json({ error: 'not found' });
  res.json({
    product: {
      title: opportunity.productDraft.title,
      salesHeadline: opportunity.productDraft.salesHeadline,
      salesBullets: opportunity.productDraft.salesBullets,
      salesParagraph: opportunity.productDraft.salesParagraph,
      priceUSD: opportunity.priceUSD,
      paddlePriceId: opportunity.paddlePriceId,
      opportunityId: opportunity.id,
      demo: Boolean(opportunity.productDraft.demo),
    },
    ...paddleClientConfig(),
  });
}

// The actual paid content was never reachable by a real customer anywhere
// before this: ProductPage.jsx only ever showed sales copy, and the guide
// text itself was only ever rendered in the owner's own authenticated
// OpportunityDetail.jsx. A real sale closed the Paddle checkout and
// charged real money, then delivered nothing — this is the missing
// fulfillment step. It only ever releases the guide once a verified
// ledger entry for this exact Paddle transaction exists (written by the
// webhook in billing.js), never on the strength of a client-side
// "checkout completed" event alone, which a browser could fake.
export function getProductGuide(req, res) {
  const { transactionId } = req.query ?? {};
  if (!transactionId) return res.status(400).json({ error: 'transactionId is required' });
  const opportunity = db.opportunities.where((o) => o.slug === req.params.slug && o.status === 'published')[0];
  if (!opportunity) return res.status(404).json({ error: 'not found' });

  const paid = db.ledger.where(
    (e) => e.type === 'revenue' && e.verified && e.opportunityId === opportunity.id && e.externalId === transactionId
  ).length > 0;
  if (!paid) return res.status(402).json({ error: 'payment not verified yet' });

  res.json({ guide: opportunity.productDraft.guide });
}

productsRouter.get('/products/:slug', getProductBySlug);
productsRouter.get('/products/:slug/guide', getProductGuide);
