import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { db } from '../db/store.js';
import { getLedgerSummary } from '../services/ledger.js';

export const ledgerRouter = Router();

export function getSummary(req, res) {
  res.json({ summary: getLedgerSummary() });
}

export function getEntries(req, res) {
  const entries = db.ledger.all().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ entries });
}

ledgerRouter.get('/ledger/summary', requireOwner, getSummary);
ledgerRouter.get('/ledger/entries', requireOwner, getEntries);
