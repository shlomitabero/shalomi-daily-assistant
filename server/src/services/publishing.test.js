import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests, makeId } from '../db/store.js';
import { updateSettings } from './settings.js';
import { publishOpportunity } from './publishing.js';

function stubFetchOnce(responses) {
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url) => {
    const response = responses[call];
    call += 1;
    if (!response) throw new Error(`unexpected extra fetch call: ${url}`);
    return { ok: true, json: async () => response };
  };
  return () => { globalThis.fetch = original; };
}

function insertOpportunity(overrides = {}) {
  return db.opportunities.insert({
    id: makeId('opp'), title: 'מדריך', priceUSD: 9, paddlePriceId: null, slug: null,
    status: 'draft', ...overrides,
  });
}

test('publishOpportunity creates a real Paddle price and a slug on first publish', async () => {
  __resetForTests();
  updateSettings({ mode: 'auto_limited' });
  const opportunity = insertOpportunity();
  const restore = stubFetchOnce([
    { data: { id: 'pro_123' } },
    { data: { id: 'pri_456' } },
  ]);
  try {
    const result = await publishOpportunity(opportunity);
    assert.equal(result.allowed, true);
    assert.equal(result.outcome.paddlePriceId, 'pri_456');
    assert.ok(result.outcome.slug);
    const updated = db.opportunities.get(opportunity.id);
    assert.equal(updated.status, 'published');
    assert.equal(updated.paddlePriceId, 'pri_456');
  } finally {
    restore();
  }
});

test('publishOpportunity never calls Paddle again once a price already exists', async () => {
  // Re-publishing (e.g. the autonomous scan retrying) must not create a
  // second, orphaned Paddle price for the same product.
  __resetForTests();
  updateSettings({ mode: 'auto_limited' });
  const opportunity = insertOpportunity({ paddlePriceId: 'pri_existing', slug: 'existing-slug' });
  const restore = stubFetchOnce([]); // any fetch call is a failure here
  try {
    const result = await publishOpportunity(opportunity);
    assert.equal(result.outcome.paddlePriceId, 'pri_existing');
    assert.equal(result.outcome.slug, 'existing-slug');
  } finally {
    restore();
  }
});
