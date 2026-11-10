import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeId, __resetForTests } from '../db/store.js';
import { createDigitalProductOpportunity, createDigitalProductOpportunityUnderCap, MAX_PENDING_DRAFTS } from './opportunities.js';

function insertOpportunity(overrides = {}) {
  const opportunity = {
    id: makeId('opp'), status: 'draft', revenueEstimate: null, costs: {}, priceUSD: 9,
    riskLevel: 'medium', dataQuality: 'unknown', missingInfo: [], ...overrides,
  };
  db.opportunities.insert(opportunity);
  return opportunity;
}

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

test('createDigitalProductOpportunity propagates a drafting failure without inserting a partial row or logging a false success', async () => {
  // This function has no try/catch of its own — a failure from draftProduct
  // (a real Anthropic API error/timeout) must reach the caller as a real
  // rejection, never get swallowed into a half-built opportunity or a
  // draft_product log entry that claims it worked.
  __resetForTests();
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network unreachable'); };
  try {
    await assert.rejects(() => createDigitalProductOpportunity({ topic: 'x', audience: 'y' }));
    assert.equal(db.opportunities.all().length, 0);
    assert.equal(db.actions_log.where((a) => a.type === 'draft_product').length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    else delete process.env.ANTHROPIC_API_KEY;
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

test('createDigitalProductOpportunityUnderCap creates a draft normally when under the cap', async () => {
  __resetForTests();
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await createDigitalProductOpportunityUnderCap({ topic: 'a', audience: 'b', createdBy: 'owner' });
    assert.equal(result.ok, true);
    assert.equal(result.opportunity.status, 'draft');
    assert.equal(db.opportunities.all().length, 1);
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

test('createDigitalProductOpportunityUnderCap refuses once the pending-draft cap is reached', async () => {
  // Pre-fills the cap with direct inserts (demo: false), not real
  // createDigitalProductOpportunityUnderCap calls - a demo draft (the
  // ANTHROPIC_API_KEY-unset default) never counts toward the cap, same as
  // pendingDraftCount() itself, so filling it that way would never
  // actually trigger this case at all.
  __resetForTests();
  for (let i = 0; i < MAX_PENDING_DRAFTS; i += 1) {
    insertOpportunity({ status: 'draft', productDraft: { demo: false } });
  }
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await createDigitalProductOpportunityUnderCap({ topic: 'one too many', audience: 'a' });
    assert.equal(result.ok, false);
    assert.equal(result.concurrent, false);
    assert.equal(result.pendingDrafts, MAX_PENDING_DRAFTS);
    assert.equal(db.opportunities.all().length, MAX_PENDING_DRAFTS);
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

test('two near-simultaneous calls never both pass the cap check - exactly one creates a draft, the other is told to retry', async () => {
  // Calling both without awaiting either first mirrors the real bug this
  // function exists to close: a double-click, two open tabs, or a scripted
  // client looping routes/opportunities.js's manual create route, where two
  // requests both read pendingDraftCount() before either had written.
  // Without draftCreationInProgress, both would see 0 and both would
  // insert a draft, each one a real, billed AI call past what
  // MAX_PENDING_DRAFTS was meant to allow.
  __resetForTests();
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const [first, second] = await Promise.all([
      createDigitalProductOpportunityUnderCap({ topic: 'a', audience: 'x' }),
      createDigitalProductOpportunityUnderCap({ topic: 'b', audience: 'y' }),
    ]);
    const results = [first, second];
    assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one of the two simultaneous calls should have created a draft');
    assert.equal(results.filter((r) => !r.ok && r.concurrent).length, 1, 'the other must be told another creation was in progress, not silently dropped or allowed to double-create');
    assert.equal(db.opportunities.all().length, 1);
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

test('the lock is released after a call completes, so a later call is never stuck refusing forever', async () => {
  __resetForTests();
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const first = await createDigitalProductOpportunityUnderCap({ topic: 'a', audience: 'x' });
    assert.equal(first.ok, true);
    const second = await createDigitalProductOpportunityUnderCap({ topic: 'b', audience: 'y' });
    assert.equal(second.ok, true);
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

test('the lock is released even when the underlying draft creation throws, so one failed AI call cannot wedge every future one', async () => {
  __resetForTests();
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network unreachable'); };
  try {
    await assert.rejects(() => createDigitalProductOpportunityUnderCap({ topic: 'x', audience: 'y' }));
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
  }
  const after = await createDigitalProductOpportunityUnderCap({ topic: 'z', audience: 'w' });
  assert.equal(after.ok, true);
});
