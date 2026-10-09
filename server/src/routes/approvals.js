import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { db, makeId } from '../db/store.js';
import { logAction } from '../services/execution.js';

export const approvalsRouter = Router();

approvalsRouter.get('/approvals', requireOwner, (req, res) => {
  res.json({ approvals: db.approvals.all() });
});

approvalsRouter.post('/approvals', requireOwner, (req, res) => {
  const { opportunityId, actionType } = req.body ?? {};
  if (!opportunityId || !actionType) return res.status(400).json({ error: 'opportunityId and actionType are required' });
  if (!db.opportunities.get(opportunityId)) return res.status(404).json({ error: 'opportunity not found' });

  const existing = db.approvals.where((a) => a.opportunityId === opportunityId && a.actionType === actionType)[0];
  const approval = existing
    ? db.approvals.update(existing.id, { status: 'approved', approvedAt: new Date().toISOString() })
    : db.approvals.insert({
        id: makeId('appr'), opportunityId, actionType, status: 'approved',
        createdAt: new Date().toISOString(), approvedAt: new Date().toISOString(),
      });

  logAction({ type: 'approve', detail: { opportunityId, actionType }, result: 'success' });
  res.status(201).json({ approval });
});

approvalsRouter.post('/approvals/:id/reject', requireOwner, (req, res) => {
  const approval = db.approvals.get(req.params.id);
  if (!approval) return res.status(404).json({ error: 'not found' });
  const updated = db.approvals.update(req.params.id, { status: 'rejected', rejectedAt: new Date().toISOString() });
  logAction({ type: 'reject', detail: { opportunityId: approval.opportunityId, actionType: approval.actionType }, result: 'success' });
  res.json({ approval: updated });
});
