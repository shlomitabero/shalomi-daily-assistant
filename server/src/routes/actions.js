import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { db } from '../db/store.js';
import { logAction } from '../services/execution.js';

export const actionsRouter = Router();

export function listActions(req, res) {
  const entries = db.actions_log.all().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 200);
  res.json({ actions: entries });
}

const MAX_MESSAGE_LENGTH = 2000;

// The client's ErrorBoundary catches a render crash so the owner sees a
// readable "something broke" screen instead of a blank white page - but
// until now that was only ever logged to the browser's own console, which
// the owner would never see unless they happened to have devtools open at
// the exact moment it happened. This gives a render crash the same
// visibility as every other failure this app already tracks, in the one
// place the owner actually looks: the activity log.
export function reportClientError(req, res) {
  const { message, path } = req.body ?? {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message is required' });
  logAction({
    type: 'client_error',
    detail: { message: message.slice(0, MAX_MESSAGE_LENGTH), path: typeof path === 'string' ? path.slice(0, 200) : null },
    result: 'failed',
  });
  res.status(201).json({ ok: true });
}

// A blocked sale_confirmed entry means a real customer's real payment came
// in and billing.js's webhook couldn't record it (a malformed amount, or a
// transaction missing custom_data.opportunityId) - services/ledger.js's own
// countUnrecordedSales() comment already documents the gap this closes:
// "no route that ever retries or resolves it." The owner still has to fix
// the underlying problem themselves outside this app (check the server
// logs, manually record the real ledger entry if the money is genuinely
// theirs to count) - this only lets them dismiss the alert once they have,
// instead of it following them on the dashboard and every daily digest
// forever with no way to ever clear it.
export function resolveUnrecordedSale(req, res) {
  const entry = db.actions_log.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'לא נמצא' });
  if (entry.type !== 'sale_confirmed' || !String(entry.result).startsWith('blocked')) {
    return res.status(409).json({ error: 'אפשר לסמן כ"טופל" רק רישום של תשלום אמיתי שלא נרשם' });
  }
  if (entry.detail?.resolvedAt) {
    return res.status(409).json({ error: 'כבר סומן כטופל', duplicate: true });
  }
  const updated = db.actions_log.update(entry.id, { detail: { ...entry.detail, resolvedAt: new Date().toISOString() } });
  res.json({ action: updated });
}

actionsRouter.get('/actions', requireOwner, listActions);
actionsRouter.post('/actions/client-error', requireOwner, reportClientError);
actionsRouter.post('/actions/:id/resolve', requireOwner, resolveUnrecordedSale);
