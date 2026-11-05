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

actionsRouter.get('/actions', requireOwner, listActions);
actionsRouter.post('/actions/client-error', requireOwner, reportClientError);
