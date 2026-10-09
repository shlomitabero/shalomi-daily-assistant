import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { db } from '../db/store.js';
import { generateDailyDigest } from '../services/digest.js';

export const digestRouter = Router();

digestRouter.get('/digests', requireOwner, (req, res) => {
  res.json({ digests: db.digests.all().sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt)) });
});

digestRouter.post('/digests/generate', requireOwner, (req, res) => {
  res.status(201).json({ digest: generateDailyDigest() });
});
