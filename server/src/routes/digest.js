import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { db } from '../db/store.js';
import { generateDailyDigest } from '../services/digest.js';

export const digestRouter = Router();

export function listDigests(req, res) {
  res.json({ digests: db.digests.all().sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt)) });
}

export function generateDigest(req, res) {
  res.status(201).json({ digest: generateDailyDigest() });
}

digestRouter.get('/digests', requireOwner, listDigests);
digestRouter.post('/digests/generate', requireOwner, generateDigest);
