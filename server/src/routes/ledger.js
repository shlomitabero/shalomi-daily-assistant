import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { db } from '../db/store.js';
import { getLedgerSummary } from '../services/ledger.js';

export const ledgerRouter = Router();

ledgerRouter.get('/ledger/summary', requireOwner, (req, res) => {
  res.json({ summary: getLedgerSummary() });
});

ledgerRouter.get('/ledger/entries', requireOwner, (req, res) => {
  const entries = db.ledger.all().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ entries });
});
