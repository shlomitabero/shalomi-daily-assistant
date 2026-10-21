import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { db } from '../db/store.js';
import { syncSources } from '../services/sources.js';

export const sourcesRouter = Router();

export function listSources(req, res) {
  res.json({ sources: syncSources() });
}

// Only a source that is actually connected gets lastScannedAt touched —
// a disconnected source is never really scanned, so stamping it anyway
// would make the owner think a source "was checked" when nothing happened.
export function rescanSources(req, res) {
  const sources = syncSources();
  const now = new Date().toISOString();
  for (const s of sources.filter((s) => s.connected)) {
    db.sources.update(s.id, { lastScannedAt: now });
  }
  res.json({ sources: db.sources.all() });
}

sourcesRouter.get('/sources', requireOwner, listSources);
sourcesRouter.post('/sources/rescan', requireOwner, rescanSources);
