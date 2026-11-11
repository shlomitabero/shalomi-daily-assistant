import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests, makeId } from '../db/store.js';
import { listApprovals, createApproval, rejectApproval } from './approvals.js';

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.statusCode ??= 200; return res; };
  return res;
}

function insertOpportunity(overrides = {}) {
  const opportunity = { id: makeId('opp'), status: 'draft', ...overrides };
  db.opportunities.insert(opportunity);
  return opportunity;
}

test('createApproval rejects a request with no body at all instead of throwing', () => {
  // req.body is undefined, not {}, when body-parser didn't run for this
  // request at all - every other test here always supplies a body object.
  __resetForTests();
  const res = makeRes();
  createApproval({}, res);
  assert.equal(res.statusCode, 400);
});

test('createApproval rejects a request missing opportunityId or actionType', () => {
  __resetForTests();
  const res = makeRes();
  createApproval({ body: { actionType: 'publish' } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /opportunityId ו-actionType הם שדות חובה/);
  assert.equal(db.approvals.all().length, 0);
});

test('createApproval rejects an opportunityId that does not exist', () => {
  __resetForTests();
  const res = makeRes();
  createApproval({ body: { opportunityId: 'opp_missing', actionType: 'publish' } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'ההזדמנות לא נמצאה');
  assert.equal(db.approvals.all().length, 0);
});

test('createApproval inserts a new approved approval for a real opportunity', () => {
  __resetForTests();
  const opp = insertOpportunity();
  const res = makeRes();
  createApproval({ body: { opportunityId: opp.id, actionType: 'publish' } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.approval.status, 'approved');
  assert.equal(res.body.approval.opportunityId, opp.id);
  assert.equal(db.approvals.all().length, 1);

  const logged = db.actions_log.where((a) => a.type === 'approve');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].detail.opportunityId, opp.id);
});

test('createApproval refuses to approve publish_product for a demo draft, which can never actually be published', () => {
  // services/publishing.js already refuses to publish a demo draft for
  // real money in every mode - this closes the same gap at the one other
  // place an approval for it could still be created (OpportunityDetail.jsx
  // no longer even renders the button, but that's client-side only).
  __resetForTests();
  const opp = insertOpportunity({ productDraft: { demo: true } });
  const res = makeRes();
  createApproval({ body: { opportunityId: opp.id, actionType: 'publish_product' } }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /תוכן דמו/);
  assert.equal(db.approvals.all().length, 0);
});

test('createApproval still allows approving a non-publish_product action for a demo draft', () => {
  // The block is specific to the one action that's actually blocked for
  // demo content (publishing for real money) - a future, unrelated
  // actionType must not be swept into the same restriction just because
  // the opportunity happens to be a demo draft.
  __resetForTests();
  const opp = insertOpportunity({ productDraft: { demo: true } });
  const res = makeRes();
  createApproval({ body: { opportunityId: opp.id, actionType: 'some_other_action' } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(db.approvals.all().length, 1);
});

test('createApproval still allows approving publish_product for a real (non-demo) draft', () => {
  __resetForTests();
  const opp = insertOpportunity({ productDraft: { demo: false } });
  const res = makeRes();
  createApproval({ body: { opportunityId: opp.id, actionType: 'publish_product' } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(db.approvals.all().length, 1);
});

test('createApproval reuses the existing row for the same opportunity+actionType instead of duplicating it', () => {
  // This is what lets an owner re-approve after a reject without the
  // approvals list silently accumulating duplicate rows for the same action.
  __resetForTests();
  const opp = insertOpportunity();
  createApproval({ body: { opportunityId: opp.id, actionType: 'publish' } }, makeRes());
  const first = db.approvals.all()[0];
  rejectApproval({ params: { id: first.id } }, makeRes());

  const res = makeRes();
  createApproval({ body: { opportunityId: opp.id, actionType: 'publish' } }, res);
  assert.equal(db.approvals.all().length, 1);
  assert.equal(res.body.approval.id, first.id);
  assert.equal(res.body.approval.status, 'approved');
});

test('rejectApproval returns 404 for an approval id that does not exist', () => {
  __resetForTests();
  const res = makeRes();
  rejectApproval({ params: { id: 'appr_missing' } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'לא נמצא');
});

test('rejectApproval marks the approval rejected and logs the action', () => {
  __resetForTests();
  const opp = insertOpportunity();
  const created = makeRes();
  createApproval({ body: { opportunityId: opp.id, actionType: 'publish' } }, created);
  const approvalId = created.body.approval.id;

  const res = makeRes();
  rejectApproval({ params: { id: approvalId } }, res);
  assert.equal(res.body.approval.status, 'rejected');
  assert.ok(res.body.approval.rejectedAt);

  const logged = db.actions_log.where((a) => a.type === 'reject');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].detail.opportunityId, opp.id);
});

test('listApprovals returns every stored approval', () => {
  __resetForTests();
  const opp = insertOpportunity();
  createApproval({ body: { opportunityId: opp.id, actionType: 'publish' } }, makeRes());
  const res = makeRes();
  listApprovals({}, res);
  assert.equal(res.body.approvals.length, 1);
});
