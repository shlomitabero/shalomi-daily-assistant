import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { db } from '../db/store.js';
import { getLedgerSummary } from '../services/ledger.js';

export const ledgerRouter = Router();

export function getSummary(req, res) {
  res.json({ summary: getLedgerSummary() });
}

// This list only ever grows, day after day, for an app meant to run
// indefinitely - actions.js's listActions (200), digest.js's listDigests
// (90), and financial.js's listPaperTrades (100) all cap themselves for
// exactly this reason. This route was the one list endpoint left
// returning every entry ever recorded with no limit at all. Unlike
// services/ledger.js's own revenueBySource (a running SUM over the whole
// lifetime ledger, where truncating the underlying entries would silently
// understate a real total), this is a raw list of individual entries, so
// capping which ones are sent carries the same no-correctness-tradeoff
// precedent as those other three lists.
const MAX_ENTRIES_RETURNED = 200;

export function getEntries(req, res) {
  const entries = db.ledger.all()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, MAX_ENTRIES_RETURNED);
  res.json({ entries });
}

ledgerRouter.get('/ledger/summary', requireOwner, getSummary);
ledgerRouter.get('/ledger/entries', requireOwner, getEntries);
