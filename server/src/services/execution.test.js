import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests, makeId } from '../db/store.js';
import { updateSettings } from './settings.js';
import { executeGatedAction, logAction } from './execution.js';
import { makeIdempotencyKey } from '../engine/idempotency.js';
import { todayKey } from './ledger.js';

test('blocks everything in research mode without ever calling perform()', async () => {
  __resetForTests();
  // getSettings() seeds the defaults (mode: 'research') on first read.
  let performCalls = 0;
  const result = await executeGatedAction({
    opportunityId: 'opp_1', actionType: 'publish_product',
    perform: async () => { performCalls += 1; return 'done'; },
  });
  assert.equal(result.allowed, false);
  assert.equal(performCalls, 0);
});

test('runs perform() and logs success once mode allows it', async () => {
  __resetForTests();
  updateSettings({ mode: 'auto_limited' });
  let performCalls = 0;
  const result = await executeGatedAction({
    opportunityId: 'opp_1', actionType: 'publish_product',
    perform: async () => { performCalls += 1; return 'done'; },
  });
  assert.equal(result.allowed, true);
  assert.equal(performCalls, 1);
  assert.equal(db.actions_log.all().filter((a) => a.result === 'success').length, 1);
});

test('the same action the same day is blocked as a duplicate without re-running perform()', async () => {
  __resetForTests();
  updateSettings({ mode: 'auto_limited' });
  let performCalls = 0;
  const perform = async () => { performCalls += 1; return 'done'; };
  const first = await executeGatedAction({ opportunityId: 'opp_1', actionType: 'publish_product', perform });
  const second = await executeGatedAction({ opportunityId: 'opp_1', actionType: 'publish_product', perform });
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.duplicate, true);
  assert.equal(performCalls, 1);
});

test('approve mode blocks an action with no matching approval record, without ever calling perform()', async () => {
  // checkExecutionGate's own unit tests pass hasApproval as a hand-fed
  // boolean - this is the one gap neither that file nor publishing.test.js
  // (always auto_limited) nor opportunities.test.js (no approve-mode
  // publish test) ever covered: whether execution.js's own
  // hasApprovalFor() actually queries db.approvals correctly and wires
  // that into the real gate, for the one mode that exists specifically so
  // a real-money action waits for the owner's explicit sign-off.
  __resetForTests();
  updateSettings({ mode: 'approve' });
  let performCalls = 0;
  const result = await executeGatedAction({
    opportunityId: 'opp_1', actionType: 'publish_product',
    perform: async () => { performCalls += 1; return 'done'; },
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /אישור/);
  assert.equal(performCalls, 0);
});

test('approve mode runs perform() once a matching, approved approval record exists', async () => {
  __resetForTests();
  updateSettings({ mode: 'approve' });
  db.approvals.insert({
    id: makeId('appr'), opportunityId: 'opp_1', actionType: 'publish_product', status: 'approved',
    createdAt: new Date().toISOString(), approvedAt: new Date().toISOString(),
  });
  let performCalls = 0;
  const result = await executeGatedAction({
    opportunityId: 'opp_1', actionType: 'publish_product',
    perform: async () => { performCalls += 1; return 'done'; },
  });
  assert.equal(result.allowed, true);
  assert.equal(performCalls, 1);
});

test('approve mode ignores an approval for a different opportunity or a different action type', async () => {
  // hasApprovalFor() matches on opportunityId AND actionType together - a
  // loose match on either alone would let an approval meant for one
  // product/action authorize an entirely different real-money action.
  __resetForTests();
  updateSettings({ mode: 'approve' });
  db.approvals.insert({
    id: makeId('appr'), opportunityId: 'opp_other', actionType: 'publish_product', status: 'approved',
    createdAt: new Date().toISOString(), approvedAt: new Date().toISOString(),
  });
  db.approvals.insert({
    id: makeId('appr2'), opportunityId: 'opp_1', actionType: 'some_other_action', status: 'approved',
    createdAt: new Date().toISOString(), approvedAt: new Date().toISOString(),
  });
  let performCalls = 0;
  const result = await executeGatedAction({
    opportunityId: 'opp_1', actionType: 'publish_product',
    perform: async () => { performCalls += 1; },
  });
  assert.equal(result.allowed, false);
  assert.equal(performCalls, 0);
});

test('a paid action is blocked when no budget is configured, even in auto_limited mode', async () => {
  __resetForTests();
  updateSettings({ mode: 'auto_limited' });
  let performCalls = 0;
  const result = await executeGatedAction({
    opportunityId: 'opp_1', actionType: 'charge', amount: 5,
    perform: async () => { performCalls += 1; },
  });
  assert.equal(result.allowed, false);
  assert.equal(performCalls, 0);
});

test('a free action (amount 0) skips the budget gate entirely', async () => {
  __resetForTests();
  updateSettings({ mode: 'auto_limited' }); // budgetConfigured stays false
  let performCalls = 0;
  const result = await executeGatedAction({
    opportunityId: 'opp_1', actionType: 'approve', amount: 0,
    perform: async () => { performCalls += 1; },
  });
  assert.equal(result.allowed, true);
  assert.equal(performCalls, 1);
});

test('ignores a stale actions_log entry from a different day when scanning for today\'s duplicate, even if its key collides with today\'s', async () => {
  // The idempotency key already bakes in the day, so this exact collision
  // could never arise from two real calls - manufacturing it here proves
  // the scan is actually filtered to today's entries, not just relying on
  // the hash's own natural uniqueness to keep different days apart. Before
  // this filter existed, every gated action re-scanned this app's entire
  // actions_log history just to compare against keys that could never
  // match - this pins the fix down against a regression that silently
  // removes the date filter and goes back to scanning (and now, matching)
  // every entry ever logged.
  __resetForTests();
  updateSettings({ mode: 'auto_limited' });
  const todaysKey = makeIdempotencyKey({ opportunityId: 'opp_1', actionType: 'publish_product', dateKey: todayKey() });
  db.actions_log.insert({
    id: makeId('act'), type: 'publish_product',
    detail: { opportunityId: 'opp_1', amount: 0, idempotencyKey: todaysKey },
    result: 'success', createdAt: '2020-01-01T00:00:00.000Z',
  });
  let performCalls = 0;
  const result = await executeGatedAction({
    opportunityId: 'opp_1', actionType: 'publish_product',
    perform: async () => { performCalls += 1; return 'done'; },
  });
  assert.equal(result.allowed, true);
  assert.equal(performCalls, 1);
});

test('two concurrent calls for the exact same key never both run perform() - the second is told to retry instead of racing the first', async () => {
  // Neither call is awaited individually first - both start running before
  // either's own perform() has a chance to resolve, exactly the
  // double-click/two-open-tabs scenario this lock exists for. Without it,
  // both would read "not yet performed today" before either had logged
  // success, and both would run perform() - for the real publish_product
  // action, that means two real Paddle price objects created for the same
  // product.
  __resetForTests();
  updateSettings({ mode: 'auto_limited' });
  let performCalls = 0;
  let releasePerform;
  const performGate = new Promise((resolve) => { releasePerform = resolve; });
  const perform = async () => {
    performCalls += 1;
    await performGate;
    return 'done';
  };
  const firstPromise = executeGatedAction({ opportunityId: 'opp_1', actionType: 'publish_product', perform });
  const secondPromise = executeGatedAction({ opportunityId: 'opp_1', actionType: 'publish_product', perform });
  releasePerform();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(performCalls, 1);
  const results = [first, second];
  assert.equal(results.filter((r) => r.allowed).length, 1);
  assert.equal(results.filter((r) => !r.allowed && r.duplicate).length, 1);
});

test('a concurrent call for a DIFFERENT opportunity is never blocked by the lock above', async () => {
  __resetForTests();
  updateSettings({ mode: 'auto_limited' });
  let performCalls = 0;
  let releasePerform;
  const performGate = new Promise((resolve) => { releasePerform = resolve; });
  const perform = async () => {
    performCalls += 1;
    await performGate;
    return 'done';
  };
  const firstPromise = executeGatedAction({ opportunityId: 'opp_1', actionType: 'publish_product', perform });
  const secondPromise = executeGatedAction({ opportunityId: 'opp_other', actionType: 'publish_product', perform });
  releasePerform();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(performCalls, 2);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
});

test('the lock is released after completion, so the same key can run again on a later, separate call', async () => {
  __resetForTests();
  updateSettings({ mode: 'auto_limited' });
  const first = await executeGatedAction({ opportunityId: 'opp_1', actionType: 'publish_product', perform: async () => 'done' });
  assert.equal(first.allowed, true);
  // A second call for the same key on the same day is still correctly
  // blocked by wasAlreadyPerformed (the pre-existing duplicate-same-day
  // check), not by the concurrency lock lingering - confirms the lock
  // itself was released and isn't what's producing this block.
  const second = await executeGatedAction({ opportunityId: 'opp_1', actionType: 'publish_product', perform: async () => 'done' });
  assert.equal(second.allowed, false);
  assert.equal(second.duplicate, true);
});

test('the lock is released even when perform() throws, so one failed action cannot wedge every future call for that key', async () => {
  __resetForTests();
  updateSettings({ mode: 'auto_limited' });
  await assert.rejects(() => executeGatedAction({
    opportunityId: 'opp_1', actionType: 'publish_product',
    perform: async () => { throw new Error('paddle unreachable'); },
  }));
  let performCalls = 0;
  const after = await executeGatedAction({
    opportunityId: 'opp_1', actionType: 'publish_product',
    perform: async () => { performCalls += 1; return 'done'; },
  });
  assert.equal(after.allowed, true);
  assert.equal(performCalls, 1);
});

test('logs a failed outcome and rethrows when perform() throws, instead of swallowing the error', async () => {
  __resetForTests();
  updateSettings({ mode: 'auto_limited' });
  await assert.rejects(
    () => executeGatedAction({
      opportunityId: 'opp_1', actionType: 'publish_product',
      perform: async () => { throw new Error('paddle unreachable'); },
    }),
    /paddle unreachable/
  );
  const failed = db.actions_log.all().filter((a) => a.result === 'failed');
  assert.equal(failed.length, 1);
});

test('logAction prunes the oldest prunable entries once the cap is exceeded, keeping the newest', () => {
  // This app is explicitly built to run indefinitely (autonomous_scan alone
  // logs roughly every 4 hours, forever) - db/store.js's persist() rewrites
  // the ENTIRE db.json on every write, so an actions_log that only ever
  // grows would progressively slow down every future write in the whole
  // app, the same risk routes/auth.js's own login_attempt pruning already
  // solves for that one type. Seeds 500 entries directly (at the cap) then
  // calls logAction once for the 501st, rather than calling logAction
  // 501 times, purely for test speed - the behavior under test is the
  // prune step itself, not logAction's insert.
  __resetForTests();
  const base = Date.now();
  for (let i = 0; i < 500; i += 1) {
    db.actions_log.insert({
      id: makeId('act'), type: 'draft_product', detail: { i }, result: 'success',
      createdAt: new Date(base + i).toISOString(),
    });
  }
  logAction({ type: 'draft_product', detail: { i: 500 }, result: 'success' });
  const remaining = db.actions_log.where((a) => a.type === 'draft_product');
  assert.equal(remaining.length, 500);
  // The very first (oldest) entry must be the one pruned, not an arbitrary one.
  assert.equal(remaining.some((a) => a.detail.i === 0), false);
  assert.equal(remaining.some((a) => a.detail.i === 500), true);
});

test('logAction never prunes a sale_confirmed entry, even a very old one past the cap', () => {
  // ledger.js's countUnrecordedSales() scans this type's ENTIRE lifetime
  // history - a blocked sale_confirmed means a real payment went
  // unrecorded, with no route that ever marks it resolved, so dropping an
  // old one could silently hide a real, still-open payment problem.
  __resetForTests();
  const oldSale = db.actions_log.insert({
    id: makeId('act'), type: 'sale_confirmed', detail: { transactionId: 'txn_old' },
    result: 'blocked: תשלום אמיתי התקבל אך לא ניתן לזהות לאיזו הזדמנות הוא משתייך',
    createdAt: new Date('2020-01-01').toISOString(),
  });
  for (let i = 0; i < 500; i += 1) {
    db.actions_log.insert({
      id: makeId('act'), type: 'draft_product', detail: { i }, result: 'success',
      createdAt: new Date(Date.now() + i).toISOString(),
    });
  }
  logAction({ type: 'draft_product', detail: {}, result: 'success' });
  assert.ok(db.actions_log.get(oldSale.id), 'the old sale_confirmed entry must survive pruning');
});

test('logAction never prunes a login_attempt entry - that type already has its own dedicated, tighter cap', () => {
  __resetForTests();
  const oldLogin = db.actions_log.insert({
    id: makeId('act'), type: 'login_attempt', detail: { ip: '1.2.3.4' }, result: 'failed',
    createdAt: new Date('2020-01-01').toISOString(),
  });
  for (let i = 0; i < 500; i += 1) {
    db.actions_log.insert({
      id: makeId('act'), type: 'draft_product', detail: { i }, result: 'success',
      createdAt: new Date(Date.now() + i).toISOString(),
    });
  }
  logAction({ type: 'draft_product', detail: {}, result: 'success' });
  assert.ok(db.actions_log.get(oldLogin.id), 'login_attempt pruning belongs to routes/auth.js alone');
});
