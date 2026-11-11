import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { db, makeId } from '../db/store.js';
import { logAction } from '../services/execution.js';

export const approvalsRouter = Router();

export function listApprovals(req, res) {
  res.json({ approvals: db.approvals.all() });
}

export function createApproval(req, res) {
  const { opportunityId, actionType } = req.body ?? {};
  if (!opportunityId || !actionType) return res.status(400).json({ error: 'opportunityId ו-actionType הם שדות חובה' });
  const opportunity = db.opportunities.get(opportunityId);
  if (!opportunity) return res.status(404).json({ error: 'ההזדמנות לא נמצאה' });
  // services/publishing.js already refuses to actually publish a demo
  // draft (no ANTHROPIC_API_KEY when it was drafted) for real money, in
  // every mode - but until now nothing stopped this route itself from
  // marking one "approved" anyway. OpportunityDetail.jsx no longer even
  // renders the "אשר פרסום" button for a demo draft, but that's a
  // client-side convenience only, same as every other field this app
  // validates server-side regardless of what the client already checks
  // (patchOpportunity, createDigitalProduct, addToWatchlist...) - a
  // stale page, a direct API call, or a future UI bug could otherwise
  // still create an approval that can never lead anywhere, inflating
  // Dashboard.jsx's/the daily digest's own "approved, one click from
  // real money" counts with something that structurally never can be.
  if (actionType === 'publish_product' && opportunity.productDraft?.demo) {
    return res.status(409).json({ error: 'אי אפשר לאשר פרסום לתוכן דמו (ללא AI אמיתי מחובר) — הפרסום יידחה בכל מקרה' });
  }

  const existing = db.approvals.where((a) => a.opportunityId === opportunityId && a.actionType === actionType)[0];
  const approval = existing
    ? db.approvals.update(existing.id, { status: 'approved', approvedAt: new Date().toISOString() })
    : db.approvals.insert({
        id: makeId('appr'), opportunityId, actionType, status: 'approved',
        createdAt: new Date().toISOString(), approvedAt: new Date().toISOString(),
      });

  logAction({ type: 'approve', detail: { opportunityId, actionType }, result: 'success' });
  res.status(201).json({ approval });
}

export function rejectApproval(req, res) {
  const approval = db.approvals.get(req.params.id);
  if (!approval) return res.status(404).json({ error: 'לא נמצא' });
  const updated = db.approvals.update(req.params.id, { status: 'rejected', rejectedAt: new Date().toISOString() });
  logAction({ type: 'reject', detail: { opportunityId: approval.opportunityId, actionType: approval.actionType }, result: 'success' });
  res.json({ approval: updated });
}

approvalsRouter.get('/approvals', requireOwner, listApprovals);
approvalsRouter.post('/approvals', requireOwner, createApproval);
approvalsRouter.post('/approvals/:id/reject', requireOwner, rejectApproval);
