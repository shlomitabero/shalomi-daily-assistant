import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests, makeId } from '../db/store.js';
import { updateSettings } from '../services/settings.js';
import { createDigitalProduct, listOpportunities, getOpportunity, patchOpportunity, publishOpportunityRoute, rejectOpportunity, triggerAutonomousScan } from './opportunities.js';
import { MAX_PENDING_DRAFTS } from '../services/opportunities.js';

function withPaddleEnv(fn) {
  const vars = { PADDLE_API_KEY: 'fake', PADDLE_CLIENT_TOKEN: 'fake', PADDLE_WEBHOOK_SECRET: 'fake' };
  const originals = {};
  for (const key of Object.keys(vars)) {
    originals[key] = process.env[key];
    process.env[key] = vars[key];
  }
  return fn().finally(() => {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  });
}

function stubPaddleFetch(responses) {
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    const response = responses[call];
    call += 1;
    if (!response) throw new Error('unexpected extra fetch call');
    return response;
  };
  return () => { globalThis.fetch = original; };
}

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
  assert.equal(resNoTopic.body.error, 'נושא הוא שדה חובה');

  const resBlankAudience = makeRes();
  await createDigitalProduct({ body: { topic: 'ניהול זמן', audience: '   ' } }, resBlankAudience);
  assert.equal(resBlankAudience.statusCode, 400);
  assert.equal(resBlankAudience.body.error, 'קהל מטרה הוא שדה חובה');
  assert.equal(db.opportunities.all().length, 0);
});

test('createDigitalProduct rejects a request with no body at all instead of throwing', async () => {
  // req.body is undefined, not {}, when body-parser didn't run for this
  // request at all (e.g. a missing/wrong content-type) - every other test
  // here always supplies a body object, even an empty one.
  __resetForTests();
  const res = makeRes();
  await createDigitalProduct({}, res);
  assert.equal(res.statusCode, 400);
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

test('createDigitalProduct responds 502 instead of crashing when the AI returns a malformed draft', async () => {
  __resetForTests();
  const originalEnv = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify({ title: 'only a title' }) }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const res = makeRes();
    await createDigitalProduct({ body: { topic: 'ניהול זמן', audience: 'יזמים' } }, res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body.error, /יצירת הטיוטה נכשלה/);
    assert.equal(db.opportunities.all().length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalEnv;
  }
});

test('createDigitalProduct refuses to draft another one once the pending-draft cap is already reached', async () => {
  // runAutonomousScan already refused a new draft past this same cap - this
  // manual route had no limit at all before, even though each draft here
  // is the exact same real, billed AI call. Never actually calls the AI
  // once blocked: a stubFetchOnce-style unset fetch would throw if it did.
  __resetForTests();
  for (let i = 0; i < MAX_PENDING_DRAFTS; i += 1) {
    insertOpportunity({ status: 'draft', productDraft: { demo: false } });
  }
  const res = makeRes();
  await createDigitalProduct({ body: { topic: 'ניהול זמן', audience: 'יזמים' } }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /טיוטות שממתינות לסקירה/);
  assert.equal(db.opportunities.all().length, MAX_PENDING_DRAFTS);
});

test('createDigitalProduct ignores demo drafts when counting toward the pending-draft cap', async () => {
  // A demo draft (from an earlier run with no ANTHROPIC_API_KEY) can never
  // be published and has no delete route - it must not permanently eat
  // into this cap.
  __resetForTests();
  for (let i = 0; i < MAX_PENDING_DRAFTS; i += 1) {
    insertOpportunity({ status: 'draft', productDraft: { demo: true } });
  }
  await withoutAnthropicKey(async () => {
    const res = makeRes();
    await createDigitalProduct({ body: { topic: 'ניהול זמן', audience: 'יזמים' } }, res);
    assert.equal(res.statusCode, 201);
  });
});

test('triggerAutonomousScan runs the scan and returns its result as-is', async () => {
  __resetForTests();
  const res = makeRes();
  await triggerAutonomousScan({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ran, false); // source not connected in this test env
  assert.match(res.body.reason, /not connected/);
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
  assert.equal(missingRes.body.error, 'לא נמצא');
});

test('patchOpportunity 404s for an id that does not exist', () => {
  __resetForTests();
  const res = makeRes();
  patchOpportunity({ params: { id: 'opp_missing' }, body: { priceUSD: 20 } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'לא נמצא');
});

test('patchOpportunity treats a request with no body at all as an empty patch instead of throwing', () => {
  // req.body is undefined, not {}, when body-parser didn't run for this
  // request at all - every other test here always supplies a body
  // object. An empty patch is a legitimate no-op, not an error.
  __resetForTests();
  const opp = insertOpportunity({ riskLevel: 'low' });
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.opportunity.riskLevel, 'low');
});

test('patchOpportunity rejects a non-finite revenueEstimate instead of letting it corrupt the profit math', () => {
  __resetForTests();
  const opp = insertOpportunity();
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { revenueEstimate: { low: 100, mid: 'lots', high: 300 } } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /הערכת ההכנסה/);
  assert.equal(db.opportunities.get(opp.id).revenueEstimate, null);
});

test('patchOpportunity rejects an inverted revenueEstimate range (low greater than high)', () => {
  // Each of low/mid/high individually passing finiteness doesn't catch
  // this - computeNetProfit would still run the subtraction and show it
  // as-is (e.g. "$400 – $100"), reading as a display bug rather than
  // what it actually is: bad input data that was never rejected.
  __resetForTests();
  const opp = insertOpportunity();
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { revenueEstimate: { low: 400, mid: 250, high: 100 } } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /הערכת ההכנסה הנמוכה לא יכולה להיות גבוהה/);
  assert.equal(db.opportunities.get(opp.id).revenueEstimate, null);
});

test('patchOpportunity accepts revenueEstimate when low equals high (a single-point estimate)', () => {
  __resetForTests();
  const opp = insertOpportunity();
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { revenueEstimate: { low: 100, mid: 100, high: 100 } } }, res);
  assert.equal(res.statusCode, 200);
});

test('patchOpportunity accepts a partial revenueEstimate with only low filled in, mid/high left null', () => {
  // The client's own form only sent an estimate at all when BOTH low and
  // high were filled in, silently discarding a one-sided estimate (e.g.
  // just typing a low bound before filling in high) back to null on save.
  // This confirms the server side of that fix has always been correct -
  // each field is already independently finite-or-null here.
  __resetForTests();
  const opp = insertOpportunity();
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { revenueEstimate: { low: 50, mid: null, high: null } } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.opportunity.revenueEstimate, { low: 50, mid: null, high: null });
});

test('patchOpportunity rejects a non-finite cost field', () => {
  __resetForTests();
  const opp = insertOpportunity();
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { costs: { hosting: 'free-ish' } } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /העלות "hosting" חייבת להיות מספר סופי/);
});

test('patchOpportunity rejects a negative cost - a single typo must not silently inflate the shown profit', () => {
  __resetForTests();
  const opp = insertOpportunity();
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { costs: { aiUsage: -5 } } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /העלות "aiUsage" חייבת להיות מספר לא שלילי/);
  assert.equal(db.opportunities.get(opp.id).costs.aiUsage, undefined);
});

test('patchOpportunity still accepts a zero or null cost - unlike negative, both are legitimate', () => {
  __resetForTests();
  const opp = insertOpportunity();
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { costs: { aiUsage: 0, paymentProcessing: null } } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.opportunity.costs.aiUsage, 0);
  assert.equal(res.body.opportunity.costs.paymentProcessing, null);
});

test('patchOpportunity rejects an invalid riskLevel or dataQuality instead of storing it', () => {
  __resetForTests();
  const opp1 = insertOpportunity();
  const res1 = makeRes();
  patchOpportunity({ params: { id: opp1.id }, body: { riskLevel: 'veryhigh' } }, res1);
  assert.equal(res1.statusCode, 400);
  assert.match(res1.body.error, /רמת הסיכון חייבת להיות אחת מ/);

  const opp2 = insertOpportunity();
  const res2 = makeRes();
  patchOpportunity({ params: { id: opp2.id }, body: { dataQuality: 'confirmed' } }, res2);
  assert.equal(res2.statusCode, 400);
  assert.match(res2.body.error, /איכות הנתונים חייבת להיות אחת מ/);
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
  assert.equal(resNull.body.error, 'מחיר המוצר חייב להיות מספר חיובי');

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
  assert.match(res.body.error, /לא ניתן לשנות מחיר אחרי פרסום/);
  assert.equal(db.opportunities.get(opp.id).priceUSD, 9);
});

test('patchOpportunity allows saving other fields on a published opportunity even though priceUSD is resent unchanged', () => {
  // OpportunityDetail.jsx's save form is a controlled form that always
  // resends every field, including priceUSD (shown in a disabled input
  // once published) — a bare 'priceUSD' in patch check would 400 this
  // exact, ordinary save with "priceUSD cannot be changed after
  // publishing", even though the owner never touched the price and only
  // meant to update the revenue estimate below.
  __resetForTests();
  const opp = insertOpportunity({ status: 'published', paddlePriceId: 'pri_123', slug: 'already-live', priceUSD: 9 });
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { priceUSD: 9, riskLevel: 'low' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.opportunity.riskLevel, 'low');
  assert.equal(res.body.opportunity.priceUSD, 9);
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

test('patchOpportunity ignores missingInfo - a one-time creation snapshot, never meant to be edited through here', () => {
  // Unlike every other field this endpoint accepts, missingInfo used to
  // have zero validation at all: any value - a string, a number, null -
  // could be stored through it with no check, even though nothing reads
  // it back and the client never sends it. Removed from the allow-list
  // entirely rather than bolting on validation for a field nothing
  // legitimately edits.
  __resetForTests();
  const opp = insertOpportunity({ missingInfo: ['revenueEstimate'] });
  const res = makeRes();
  patchOpportunity({ params: { id: opp.id }, body: { missingInfo: 'not an array', priceUSD: 29 } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.opportunity.missingInfo, ['revenueEstimate']);
  assert.equal(res.body.opportunity.priceUSD, 29);
});

test('publishOpportunityRoute 404s for an id that does not exist', async () => {
  __resetForTests();
  const res = makeRes();
  await publishOpportunityRoute({ params: { id: 'opp_missing' } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'לא נמצא');
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
  assert.equal(res.body.error, 'כבר פורסם');
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

test('rejectOpportunity 404s for an id that does not exist', () => {
  __resetForTests();
  const res = makeRes();
  rejectOpportunity({ params: { id: 'opp_missing' } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'לא נמצא');
});

test('rejectOpportunity marks a draft opportunity rejected', () => {
  __resetForTests();
  const opp = insertOpportunity();
  const res = makeRes();
  rejectOpportunity({ params: { id: opp.id } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.opportunity.status, 'rejected');
  assert.ok(db.opportunities.get(opp.id).rejectedAt);

  const logged = db.actions_log.where((a) => a.type === 'reject_opportunity');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].detail.opportunityId, opp.id);
});

test('rejectOpportunity refuses to reject an already-published opportunity', () => {
  __resetForTests();
  const opp = insertOpportunity({ status: 'published', paddlePriceId: 'pri_123', slug: 'already-live' });
  const res = makeRes();
  rejectOpportunity({ params: { id: opp.id } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'אי אפשר לדחות הזדמנות שכבר פורסמה');
  assert.equal(db.opportunities.get(opp.id).status, 'published');
});

test('rejectOpportunity is idempotent — rejecting an already-rejected opportunity is a no-op 409, not a duplicate log entry', () => {
  __resetForTests();
  const opp = insertOpportunity({ status: 'rejected' });
  const res = makeRes();
  rejectOpportunity({ params: { id: opp.id } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'כבר נדחה');
  assert.equal(res.body.duplicate, true);
  assert.equal(db.actions_log.where((a) => a.type === 'reject_opportunity').length, 0);
});

test('rejectOpportunity also invalidates a stale "approve"-mode approval for this opportunity', () => {
  // Mirrors patchOpportunity's stale-approval invalidation on a price
  // change: an approval has no memory of the opportunity being rejected
  // afterward, so without this it would sit there as "approved" forever
  // even though publishing is now permanently blocked.
  __resetForTests();
  const opp = insertOpportunity();
  const approval = db.approvals.insert({
    id: makeId('appr'), opportunityId: opp.id, actionType: 'publish_product', status: 'approved', createdAt: '2026-01-01T00:00:00.000Z', approvedAt: '2026-01-01T00:00:00.000Z',
  });
  rejectOpportunity({ params: { id: opp.id } }, makeRes());
  assert.equal(db.approvals.get(approval.id).status, 'rejected');
});

test('publishOpportunityRoute refuses to publish an opportunity the owner already rejected', async () => {
  __resetForTests();
  const opp = insertOpportunity({ status: 'rejected' });
  const res = makeRes();
  await publishOpportunityRoute({ params: { id: opp.id } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'ההזדמנות הזו נדחתה ולא ניתן לפרסם אותה');
  assert.equal(db.opportunities.get(opp.id).status, 'rejected');
});

test('publishOpportunityRoute responds 503 and never calls Paddle when Paddle is not configured yet', async () => {
  // The owner's "פרסם מוצר" click before PADDLE_API_KEY/CLIENT_TOKEN/
  // WEBHOOK_SECRET are all set must get an honest "not set up" error, not
  // a confusing failure from inside publishOpportunity.
  __resetForTests();
  const opp = insertOpportunity();
  const restore = stubPaddleFetch([]); // any fetch call is a failure here
  try {
    const res = makeRes();
    await publishOpportunityRoute({ params: { id: opp.id } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(db.opportunities.get(opp.id).status, 'draft');
    const logged = db.actions_log.where((a) => a.type === 'publish_product')[0];
    assert.match(logged.result, /blocked: Paddle עדיין לא מוגדר/);
  } finally {
    restore();
  }
});

test('publishOpportunityRoute responds 409 without ever calling Paddle when the mode gate blocks it', async () => {
  // Default mode is 'research' - the gate must reject before perform() ever
  // runs, even once Paddle itself is fully configured.
  __resetForTests();
  const opp = insertOpportunity();
  const restore = stubPaddleFetch([]); // any fetch call means the gate didn't block in time - a failure
  await withPaddleEnv(async () => {
    try {
      const res = makeRes();
      await publishOpportunityRoute({ params: { id: opp.id } }, res);
      assert.equal(res.statusCode, 409);
      assert.equal(db.opportunities.get(opp.id).status, 'draft');
    } finally {
      restore();
    }
  });
});

test('publishOpportunityRoute publishes for real and returns the updated opportunity', async () => {
  __resetForTests();
  updateSettings({ mode: 'auto_limited' });
  const opp = insertOpportunity();
  const restore = stubPaddleFetch([
    { ok: true, json: async () => ({ data: { id: 'pro_123' } }) },
    { ok: true, json: async () => ({ data: { id: 'pri_456' } }) },
  ]);
  await withPaddleEnv(async () => {
    try {
      const res = makeRes();
      await publishOpportunityRoute({ params: { id: opp.id } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.opportunity.status, 'published');
      assert.equal(res.body.opportunity.paddlePriceId, 'pri_456');
      assert.ok(res.body.opportunity.slug);
    } finally {
      restore();
    }
  });
});

test('publishOpportunityRoute responds 502 and leaves the opportunity a draft when the Paddle API call fails', async () => {
  // A Paddle outage (or a bad API key) during perform() must surface as a
  // clean error response instead of crashing the request, and must never
  // leave the opportunity half-published.
  __resetForTests();
  updateSettings({ mode: 'auto_limited' });
  const opp = insertOpportunity();
  const restore = stubPaddleFetch([
    { ok: false, text: async () => 'Paddle is down' }, // the product-creation call fails
  ]);
  await withPaddleEnv(async () => {
    try {
      const res = makeRes();
      await publishOpportunityRoute({ params: { id: opp.id } }, res);
      assert.equal(res.statusCode, 502);
      assert.match(res.body.error, /הפרסום נכשל/);
      assert.equal(db.opportunities.get(opp.id).status, 'draft');
      assert.ok(!db.opportunities.get(opp.id).paddlePriceId);
    } finally {
      restore();
    }
  });
});
