import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { db } from '../db/store.js';
import { generateDailyDigest } from '../services/digest.js';

export const digestRouter = Router();

// One digest a day (generateDailyDigest is idempotent per day) means this
// list only ever grows - actions.js's own listActions already caps itself
// at its most recent 200 entries for the same reason; this page has no
// similar cap at all despite running indefinitely day after day,
// eventually returning and rendering an unbounded number of digests on the
// same page. 90 comfortably covers three months, more than this page is
// ever practically used to look back over at once.
const MAX_DIGESTS_RETURNED = 90;

export function listDigests(req, res) {
  const digests = db.digests.all().sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt)).slice(0, MAX_DIGESTS_RETURNED);
  res.json({ digests });
}

export function generateDigest(req, res) {
  res.status(201).json({ digest: generateDailyDigest() });
}

digestRouter.get('/digests', requireOwner, listDigests);
digestRouter.post('/digests/generate', requireOwner, generateDigest);
