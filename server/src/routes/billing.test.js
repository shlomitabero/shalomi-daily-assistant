import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { db, __resetForTests, makeId } from '../db/store.js';
import { paddleWebhookHandler, getBillingConfigured } from './billing.js';
import { todayKey } from '../services/ledger.js';

function withEnv(vars, fn) {
  const originals = {};
  for (const key of Object.keys(vars)) {
    originals[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  }
}

function sign(body, ts, secret) {
  return createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
}

function makeReq(payload, secret) {
  const rawBody = JSON.stringify(payload);
  const ts = '1700000000';
  return { headers: { 'paddle-signature': `ts=${ts};h1=${sign(rawBody, ts, secret)}` }, body: Buffer.from(rawBody) };
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.statusCode ??= 200; return res; };
  res.send = (body) => { res.body = body; return res; };
  return res;
}

function completedTxn({ id = 'txn_1', opportunityId, totalCents = '900', feeCents } = {}) {
  return {
    event_type: 'transaction.completed',
    data: { id, custom_data: { opportunityId }, details: { totals: { total: totalCents, fee: feeCents } } },
  };
}

test('getBillingConfigured reports honestly when Paddle is not set up', () => {
  withEnv({ PADDLE_API_KEY: undefined, PADDLE_CLIENT_TOKEN: undefined, PADDLE_ENV: undefined }, () => {
    const res = makeRes();
    getBillingConfigured({}, res);
    assert.deepEqual(res.body, { configured: false, clientToken: null, sandbox: false });
  });
});

test('getBillingConfigured reports configured once the API key, client token, and webhook secret are all set', () => {
  withEnv({ PADDLE_API_KEY: 'key', PADDLE_CLIENT_TOKEN: 'tok', PADDLE_WEBHOOK_SECRET: 'whsec', PADDLE_ENV: 'sandbox' }, () => {
    const res = makeRes();
    getBillingConfigured({}, res);
    assert.deepEqual(res.body, { configured: true, clientToken: 'tok', sandbox: true });
  });
});

test('a webhook with an invalid signature is rejected and never touches the ledger', () => {
  __resetForTests();
  withEnv({ PADDLE_WEBHOOK_SECRET: 'whsec_real' }, () => {
    const req = makeReq(completedTxn({ opportunityId: 'opp_1' }), 'whsec_wrong');
    const res = makeRes();
    paddleWebhookHandler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(db.ledger.all().length, 0);
  });
});

test('a verified transaction.completed records real revenue and bumps the opportunity sales count', () => {
  __resetForTests();
  withEnv({ PADDLE_WEBHOOK_SECRET: 'whsec_real' }, () => {
    const opportunity = db.opportunities.insert({ id: makeId('opp'), title: 'מדריך', salesCount: 0 });
    const req = makeReq(completedTxn({ id: 'txn_1', opportunityId: opportunity.id, totalCents: '900' }), 'whsec_real');
    const res = makeRes();
    paddleWebhookHandler(req, res);

    assert.deepEqual(res.body, { received: true });
    const entries = db.ledger.where((e) => e.externalId === 'txn_1');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].amount, 9);
    assert.equal(entries[0].verified, true);
    // This used to duplicate its own UTC-only date computation inline
    // instead of sharing ledger.js's todayKey() - must date a real sale by
    // the same Israel-local "today" every other part of the app uses, not
    // its own separate, out-of-sync notion of the day boundary.
    assert.equal(entries[0].date, todayKey());
    assert.equal(db.opportunities.get(opportunity.id).salesCount, 1);
  });
});

test('the same Paddle transaction id replayed is never recorded twice', () => {
  // Paddle retries webhook delivery on anything but a 2xx — without this,
  // a flaky response would double-count real revenue for one real sale.
  __resetForTests();
  withEnv({ PADDLE_WEBHOOK_SECRET: 'whsec_real' }, () => {
    const opportunity = db.opportunities.insert({ id: makeId('opp'), title: 'מדריך', salesCount: 0 });
    const txn = completedTxn({ id: 'txn_1', opportunityId: opportunity.id, totalCents: '900' });
    paddleWebhookHandler(makeReq(txn, 'whsec_real'), makeRes());
    paddleWebhookHandler(makeReq(txn, 'whsec_real'), makeRes());

    assert.equal(db.ledger.where((e) => e.externalId === 'txn_1').length, 1);
    assert.equal(db.opportunities.get(opportunity.id).salesCount, 1);
  });
});

test('a verified transaction.completed with a real Paddle fee records it as a cost and backfills the opportunity', () => {
  __resetForTests();
  withEnv({ PADDLE_WEBHOOK_SECRET: 'whsec_real' }, () => {
    const opportunity = db.opportunities.insert({ id: makeId('opp'), title: 'מדריך', salesCount: 0, costs: { aiUsage: 0.05, paymentProcessing: null } });
    const req = makeReq(completedTxn({ id: 'txn_1', opportunityId: opportunity.id, totalCents: '900', feeCents: '83' }), 'whsec_real');
    paddleWebhookHandler(req, makeRes());

    const feeEntries = db.ledger.where((e) => e.externalId === 'txn_1:fee');
    assert.equal(feeEntries.length, 1);
    assert.equal(feeEntries[0].type, 'cost');
    assert.equal(feeEntries[0].amount, 0.83);
    assert.equal(feeEntries[0].verified, true);

    const updated = db.opportunities.get(opportunity.id);
    // The real fee replaces the null "unknown" placeholder — aiUsage must
    // stay untouched, this isn't a full overwrite of costs.
    assert.equal(updated.costs.paymentProcessing, 0.83);
    assert.equal(updated.costs.aiUsage, 0.05);
  });
});

test('a transaction.completed with no fee reported records revenue only, exactly as before', () => {
  __resetForTests();
  withEnv({ PADDLE_WEBHOOK_SECRET: 'whsec_real' }, () => {
    const opportunity = db.opportunities.insert({ id: makeId('opp'), title: 'מדריך', salesCount: 0, costs: { paymentProcessing: null } });
    const req = makeReq(completedTxn({ id: 'txn_1', opportunityId: opportunity.id, totalCents: '900' }), 'whsec_real');
    paddleWebhookHandler(req, makeRes());

    assert.equal(db.ledger.where((e) => e.type === 'cost').length, 0);
    assert.equal(db.opportunities.get(opportunity.id).costs.paymentProcessing, null);
  });
});

test('replaying the same transaction never double-records its fee either', () => {
  __resetForTests();
  withEnv({ PADDLE_WEBHOOK_SECRET: 'whsec_real' }, () => {
    const opportunity = db.opportunities.insert({ id: makeId('opp'), title: 'מדריך', salesCount: 0 });
    const txn = completedTxn({ id: 'txn_1', opportunityId: opportunity.id, totalCents: '900', feeCents: '83' });
    paddleWebhookHandler(makeReq(txn, 'whsec_real'), makeRes());
    paddleWebhookHandler(makeReq(txn, 'whsec_real'), makeRes());

    assert.equal(db.ledger.where((e) => e.externalId === 'txn_1:fee').length, 1);
  });
});

test('a sandbox transaction is never recorded as real revenue, even with a valid signature', () => {
  // PADDLE_ENV=sandbox is the README's own documented default while
  // testing — a test purchase made during that setup still sends a real,
  // validly-signed webhook here (signed with the sandbox's own secret),
  // and must never be mistaken for a real sale.
  __resetForTests();
  withEnv({ PADDLE_WEBHOOK_SECRET: 'whsec_sandbox', PADDLE_ENV: 'sandbox' }, () => {
    const opportunity = db.opportunities.insert({ id: makeId('opp'), title: 'מדריך', salesCount: 0 });
    const req = makeReq(completedTxn({ id: 'txn_1', opportunityId: opportunity.id, totalCents: '900' }), 'whsec_sandbox');
    const res = makeRes();
    paddleWebhookHandler(req, res);

    assert.deepEqual(res.body, { received: true });
    assert.equal(db.ledger.all().length, 0);
    assert.equal(db.opportunities.get(opportunity.id).salesCount, 0);
    const logged = db.actions_log.where((a) => a.type === 'sale_confirmed')[0];
    assert.match(logged.result, /skipped: sandbox/);
  });
});

test('a production transaction is still recorded normally when PADDLE_ENV is unset or production', () => {
  __resetForTests();
  withEnv({ PADDLE_WEBHOOK_SECRET: 'whsec_real', PADDLE_ENV: 'production' }, () => {
    const opportunity = db.opportunities.insert({ id: makeId('opp'), title: 'מדריך', salesCount: 0 });
    const req = makeReq(completedTxn({ id: 'txn_1', opportunityId: opportunity.id, totalCents: '900' }), 'whsec_real');
    paddleWebhookHandler(req, makeRes());

    assert.equal(db.ledger.where((e) => e.externalId === 'txn_1').length, 1);
    assert.equal(db.opportunities.get(opportunity.id).salesCount, 1);
  });
});

test('a malformed transaction amount is refused instead of poisoning the ledger with NaN', () => {
  __resetForTests();
  withEnv({ PADDLE_WEBHOOK_SECRET: 'whsec_real' }, () => {
    const opportunity = db.opportunities.insert({ id: makeId('opp'), title: 'מדריך', salesCount: 0 });
    const txn = completedTxn({ id: 'txn_1', opportunityId: opportunity.id, totalCents: 'not-a-number' });
    const res = makeRes();
    paddleWebhookHandler(makeReq(txn, 'whsec_real'), res);

    assert.deepEqual(res.body, { received: true });
    assert.equal(db.ledger.all().length, 0);
    assert.equal(db.opportunities.get(opportunity.id).salesCount, 0);
  });
});

test('a malformed JSON body never crashes the handler', () => {
  __resetForTests();
  withEnv({ PADDLE_WEBHOOK_SECRET: 'whsec_real' }, () => {
    const rawBody = '{not valid json';
    const ts = '1700000000';
    const req = { headers: { 'paddle-signature': `ts=${ts};h1=${sign(rawBody, ts, 'whsec_real')}` }, body: Buffer.from(rawBody) };
    const res = makeRes();
    assert.doesNotThrow(() => paddleWebhookHandler(req, res));
    assert.equal(res.statusCode, 400);
  });
});
