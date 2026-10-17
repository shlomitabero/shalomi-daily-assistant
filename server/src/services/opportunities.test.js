import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests } from '../db/store.js';
import { createDigitalProductOpportunity } from './opportunities.js';

test('createDigitalProductOpportunity stores a draft with no fabricated demand or revenue', async () => {
  // This is the one path shared by the owner's manual form and the
  // autonomous scan loop — it must never invent a revenue estimate or a
  // "verified" cost just because a real draft was produced.
  __resetForTests();
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const opportunity = await createDigitalProductOpportunity({ topic: 'ניהול זמן', audience: 'יזמים', createdBy: 'owner' });

    assert.equal(opportunity.source, 'ai_digital_products');
    assert.equal(opportunity.status, 'draft');
    assert.equal(opportunity.revenueEstimate, null);
    assert.equal(opportunity.costs.paymentProcessing, null);
    assert.equal(opportunity.dataQuality, 'unknown');
    assert.ok(opportunity.priceUSD > 0);
    assert.equal(opportunity.paddlePriceId, null);
    assert.equal(opportunity.slug, null);
    assert.equal(opportunity.salesCount, 0);
    assert.ok(opportunity.productDraft.demo, 'demo draft must be clearly marked, never passed off as real');
    assert.ok(opportunity.missingInfo.some((m) => m.includes('revenueEstimate')));

    assert.deepEqual(db.opportunities.get(opportunity.id), opportunity);
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

test('createDigitalProductOpportunity logs a draft_product action recording who triggered it', async () => {
  __resetForTests();
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const opportunity = await createDigitalProductOpportunity({ topic: 'שיווק', audience: 'סטארטאפים', createdBy: 'autonomous_scan' });
    const logged = db.actions_log.where((a) => a.type === 'draft_product');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].result, 'success');
    assert.equal(logged[0].detail.opportunityId, opportunity.id);
    assert.equal(logged[0].detail.createdBy, 'autonomous_scan');
    assert.equal(logged[0].detail.demo, true);
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

test('createDigitalProductOpportunity defaults createdBy to "owner" when omitted', async () => {
  __resetForTests();
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const opportunity = await createDigitalProductOpportunity({ topic: 'תכנון פרישה', audience: 'גמלאים' });
    assert.equal(opportunity.createdBy, 'owner');
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});
