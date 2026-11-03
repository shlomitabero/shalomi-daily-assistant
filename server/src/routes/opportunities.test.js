import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests, makeId } from '../db/store.js';
import { createDigitalProduct, listOpportunities, getOpportunity, patchOpportunity, publishOpportunityRoute } from './opportunities.js';

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.statusCode ??= 200; return res; };
  return res;
}

function withoutAnthropicKey(fn) {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  return fn().finally(() => {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  });
}

function insertOpportunity(overrides = {}) {
  const opportunity = {
    id: makeId('opp'), status: 'draft', revenueEstimate: null, costs: {}, priceUSD: 9,
    riskLevel: 'medium', dataQuality: 'unknown', missingInfo: [], ...overrides,
  };
  db.opportunities.insert(opportunity);
  return opportunity;
}

test('createDigitalProduct rejects a missing topic or audience before drafting anything', async () => {
  __resetForTests();
  const resNoTopic = makeRes();
  await createDigitalProduct({ body: { audience: 'יזמים' } }, resNoTopic);
  assert.equal(resNoTopic.statusCode, 400);

  const resBlankAudience = makeRes();
  await createDigitalProduct({ body: { topic: 'ניהול זמן', audience: '   ' } }, resBlankAudience);
  assert.equal(resBlankAudience.statusCode, 400);
  assert.equal(db.opportunities.all().length, 0);
});

test('createDigitalProduct creates a real draft with honest feasibility data when given a topic and audience', async () => {
  __resetForTests();
  await withoutAnthropicKey(async () => {
    const res = makeRes();
    await createDigitalProduct({ body: { topic: 'ניהול זמן', audience: 'יזמים' } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.opportunity.revenueEstimate, null);
    // No revenue estimate yet means feasibility must report it as missing,
    // never silently compute a profit against an absent number.
    assert.equal(res.body.opportunity.feasibility.status, 'incomplete');
    assert.equal(res.body.opportunity.netProfitMid, null);
  });
});

test('listOpportunities and getOpportunity attach feasibility and 404 for a missing id', () => {
  __resetForTests();
  const opp = insertOpportunity({ revenueEstimate: { low: 100, mid: 150, high: 200 }, costs: { hosting: 10 } });

  const listRes = makeRes();
  listOpportunities({}, listRes);
  assert.equal(listRes.body.opportunities.length, 1);
  assert.equal(listRes.body.opportunities[0].feasibility.status, 'complete');

  const getRes = makeRes();
  getOpportunity({ params: { id: opp.id } }, getRes);
  assert.equal(getRes.body.opportunity.netProfitMid, 140);

  const missingRes = makeRes();
  getOpportunity({ params: { id: 'opp_missing' } }, missingRes);
  assert.equal(missingRes.statusCode, 404);
});

test('patchOpportunity 404s for an id that does not exist', () => {
  __resetForTests();
  const res = makeRes();
  patchOpportunity({ params: { id: 'opp_missing' }, body: { priceUSD: 20 } }, res);
  assert.equal(res.statusCode, 404);
});

test('patchOpportunity rejects a non-finite revenueEstimate instead of letting it corrupt the profit math', () => {
  __resetForTests();
  const opp = insertOpportunity();
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { revenueEstimate: { low: 100, mid: 'lots', high: 300 } } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(db.opportunities.get(opp.id).revenueEstimate, null);
});

test('patchOpportunity rejects a non-finite cost field', () => {
  __resetForTests();
  const opp = insertOpportunity();
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { costs: { hosting: 'free-ish' } } }, res);
  assert.equal(res.statusCode, 400);
});

test('patchOpportunity rejects an invalid riskLevel or dataQuality instead of storing it', () => {
  __resetForTests();
  const opp1 = insertOpportunity();
  const res1 = makeRes();
  patchOpportunity({ params: { id: opp1.id }, body: { riskLevel: 'veryhigh' } }, res1);
  assert.equal(res1.statusCode, 400);

  const opp2 = insertOpportunity();
  const res2 = makeRes();
  patchOpportunity({ params: { id: opp2.id }, body: { dataQuality: 'confirmed' } }, res2);
  assert.equal(res2.statusCode, 400);
});

test('patchOpportunity accepts each valid riskLevel and dataQuality', () => {
  __resetForTests();
  for (const riskLevel of ['low', 'medium', 'high']) {
    const opp = insertOpportunity();
    const res = makeRes();
    patchOpportunity({ params: { id: opp.id }, body: { riskLevel } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.opportunity.riskLevel, riskLevel);
  }
  for (const dataQuality of ['unknown', 'estimated', 'verified']) {
    const opp = insertOpportunity();
    const res = makeRes();
    patchOpportunity({ params: { id: opp.id }, body: { dataQuality } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.opportunity.dataQuality, dataQuality);
  }
});

test('patchOpportunity rejects a null or non-positive priceUSD — a product always has a real price', () => {
  __resetForTests();
  const opp = insertOpportunity();
  const resNull = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { priceUSD: null } }, resNull);
  assert.equal(resNull.statusCode, 400);

  const resZero = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { priceUSD: 0 } }, resZero);
  assert.equal(resZero.statusCode, 400);
});

test('patchOpportunity rejects changing priceUSD after publishing — the live Paddle price is already fixed', () => {
  // publishing.js never updates an existing Paddle price (there's no API
  // for that) — editing priceUSD post-publish would desync the dashboard's
  // number from what a real customer is actually charged on the live
  // sales page.
  __resetForTests();
  const opp = insertOpportunity({ status: 'published', paddlePriceId: 'pri_123', slug: 'already-live', priceUSD: 9 });
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { priceUSD: 29 } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(db.opportunities.get(opp.id).priceUSD, 9);
});

test('patchOpportunity rejects a stale "approve"-mode approval when priceUSD actually changes', () => {
  // The approval has no memory of what priceUSD was when it was given -
  // without this, approving at $9 then changing the price to $29 would
  // leave the approval sitting there as "approved" for a price that was
  // never the one actually approved.
  __resetForTests();
  const opp = insertOpportunity({ priceUSD: 9 });
  const approval = db.approvals.insert({
    id: makeId('appr'), opportunityId: opp.id, actionType: 'publish_product', status: 'approved', createdAt: '2026-01-01T00:00:00.000Z', approvedAt: '2026-01-01T00:00:00.000Z',
  });
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { priceUSD: 29 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.approvals.get(approval.id).status, 'rejected');
});

test('patchOpportunity leaves an existing approval alone when priceUSD is unchanged or not touched', () => {
  __resetForTests();
  const opp = insertOpportunity({ priceUSD: 9 });
  const approval = db.approvals.insert({
    id: makeId('appr'), opportunityId: opp.id, actionType: 'publish_product', status: 'approved', createdAt: '2026-01-01T00:00:00.000Z', approvedAt: '2026-01-01T00:00:00.000Z',
  });
  patchOpportunity({ params: { id: opp.id }, body: { priceUSD: 9 } }, makeRes());
  assert.equal(db.approvals.get(approval.id).status, 'approved');
  patchOpportunity({ params: { id: opp.id }, body: { riskLevel: 'low' } }, makeRes());
  assert.equal(db.approvals.get(approval.id).status, 'approved');
});

test('patchOpportunity still allows editing other fields (riskLevel, revenueEstimate) after publishing', () => {
  __resetForTests();
  const opp = insertOpportunity({ status: 'published', paddlePriceId: 'pri_123', slug: 'already-live' });
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { riskLevel: 'low' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.opportunity.riskLevel, 'low');
});

test('patchOpportunity ignores fields outside the editable allow-list, e.g. status or slug', () => {
  __resetForTests();
  const opp = insertOpportunity({ status: 'draft', slug: null });
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { status: 'published', slug: 'hacked', priceUSD: 29 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.opportunity.status, 'draft');
  assert.equal(res.body.opportunity.slug, null);
  assert.equal(res.body.opportunity.priceUSD, 29);
});

test('publishOpportunityRoute 404s for an id that does not exist', async () => {
  __resetForTests();
  const res = makeRes();
  await publishOpportunityRoute({ params: { id: 'opp_missing' } }, res);
  assert.equal(res.statusCode, 404);
});

test('publishOpportunityRoute rejects publishing an opportunity that is already published', async () => {
  // A stray repeat request (or a next-day retry, once the per-day
  // idempotency key no longer matches) must not sail through and write a
  // confusing extra "success" entry to the audit log for a no-op.
  __resetForTests();
  const opp = insertOpportunity({ status: 'published', paddlePriceId: 'pri_123', slug: 'already-live' });
  const res = makeRes();
  await publishOpportunityRoute({ params: { id: opp.id } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.duplicate, true);
});

test('patchOpportunity merges a valid patch without dropping untouched fields', () => {
  __resetForTests();
  const opp = insertOpportunity({ riskLevel: 'low' });
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { priceUSD: 15 } }, res);
  assert.equal(res.body.opportunity.priceUSD, 15);
  assert.equal(res.body.opportunity.riskLevel, 'low');
});
