import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests, makeId } from '../db/store.js';
import { getProductBySlug } from './products.js';

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.statusCode ??= 200; return res; };
  return res;
}

function insertOpportunity(overrides = {}) {
  const opportunity = {
    id: makeId('opp'), slug: 'time-management-guide', status: 'published', priceUSD: 19,
    paddlePriceId: 'pri_123', productDraft: {
      title: 'מדריך ניהול זמן', salesHeadline: 'תפסיק לדחות', salesBullets: ['טיפ 1'],
      salesParagraph: 'פסקה', demo: false,
    }, ...overrides,
  };
  db.opportunities.insert(opportunity);
  return opportunity;
}

test('getProductBySlug 404s for a slug that does not exist', () => {
  __resetForTests();
  const res = makeRes();
  getProductBySlug({ params: { slug: 'does-not-exist' } }, res);
  assert.equal(res.statusCode, 404);
});

test('getProductBySlug never exposes a draft (unpublished) opportunity by its slug', () => {
  // This is the one thing standing between a customer and a product the
  // owner hasn't approved yet — a draft must 404 the same as a missing slug.
  __resetForTests();
  insertOpportunity({ status: 'draft' });
  const res = makeRes();
  getProductBySlug({ params: { slug: 'time-management-guide' } }, res);
  assert.equal(res.statusCode, 404);
});

test('getProductBySlug returns the public sales page shape for a published product', () => {
  __resetForTests();
  insertOpportunity();
  const res = makeRes();
  getProductBySlug({ params: { slug: 'time-management-guide' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.product.title, 'מדריך ניהול זמן');
  assert.equal(res.body.product.priceUSD, 19);
  assert.equal(res.body.product.paddlePriceId, 'pri_123');
  assert.equal(res.body.product.demo, false);
  assert.equal('clientToken' in res.body, true);
});

test('getProductBySlug always coerces demo to a real boolean, never a truthy/falsy stand-in', () => {
  __resetForTests();
  insertOpportunity({ productDraft: { title: 't', salesHeadline: 'h', salesBullets: [], salesParagraph: 'p', demo: undefined } });
  const res = makeRes();
  getProductBySlug({ params: { slug: 'time-management-guide' } }, res);
  assert.equal(res.body.product.demo, false);
});
