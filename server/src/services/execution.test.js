import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests, makeId } from '../db/store.js';
import { updateSettings } from './settings.js';
import { executeGatedAction } from './execution.js';

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
