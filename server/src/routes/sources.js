import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { db } from '../db/store.js';
import { syncSources } from '../services/sources.js';

export const sourcesRouter = Router();

sourcesRouter.get('/sources', requireOwner, (req, res) => {
  res.json({ sources: syncSources() });
});

sourcesRouter.post('/sources/rescan', requireOwner, (req, res) => {
  const sources = syncSources();
  const now = new Date().toISOString();
  for (const s of sources.filter((s) => s.connected)) {
    db.sources.update(s.id, { lastScannedAt: now });
  }
  res.json({ sources: db.sources.all() });
});
