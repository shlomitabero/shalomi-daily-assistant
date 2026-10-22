import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { db } from '../db/store.js';

export const actionsRouter = Router();

export function listActions(req, res) {
  const entries = db.actions_log.all().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 200);
  res.json({ actions: entries });
}

actionsRouter.get('/actions', requireOwner, listActions);
