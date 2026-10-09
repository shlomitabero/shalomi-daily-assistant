import { Router } from 'express';
import { verifyOwnerPassword, signOwnerToken } from '../engine/auth.js';

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  if (!process.env.OWNER_PASSWORD) {
    return res.status(503).json({ error: 'OWNER_PASSWORD is not set on the server yet' });
  }
  const { password } = req.body ?? {};
  if (!verifyOwnerPassword(password)) return res.status(401).json({ error: 'wrong password' });
  res.json({ token: signOwnerToken() });
});
