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

productsRouter.get('/products/:slug', getProductBySlug);
