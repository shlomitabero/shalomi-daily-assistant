import { Router } from 'express';
import { db, makeId } from '../db/store.js';
import { hashPassword, verifyPassword, signToken } from '../engine/auth.js';
import { createReferralCode, shouldCreditReferral } from '../engine/referral.js';
import { BONUS_PER_REFERRAL } from '../engine/usage.js';
import { getFullUserState } from '../services/userState.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

function uniqueReferralCode() {
  let code;
  do { code = createReferralCode(); } while (db.users.where((u) => u.referral_code === code).length);
  return code;
}

authRouter.post('/signup', async (req, res) => {
  const { email, password, referralCode } = req.body ?? {};
  if (!email || !/.+@.+\..+/.test(email)) return res.status(400).json({ error: 'valid email required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  const normalizedEmail = email.trim().toLowerCase();
  if (db.users.where((u) => u.email === normalizedEmail).length) {
    return res.status(409).json({ error: 'an account with that email already exists' });
  }

  const referrer = referralCode ? db.users.where((u) => u.referral_code === referralCode.trim().toUpperCase())[0] : null;

  const id = makeId('user');
  const user = db.users.insert({
    id,
    email: normalizedEmail,
    password_hash: await hashPassword(password),
    display_name: normalizedEmail.split('@')[0],
    referral_code: uniqueReferralCode(),
    referred_by: null,
    bonus_generations: 0,
    streak: 0,
    last_generation_date: null,
    created_at: new Date().toISOString(),
  });

  if (shouldCreditReferral({ referrerId: referrer?.id, newUserId: id, newUserAlreadyReferred: false })) {
    db.users.update(id, { referred_by: referrer.id, bonus_generations: BONUS_PER_REFERRAL });
    db.users.update(referrer.id, { bonus_generations: (referrer.bonus_generations ?? 0) + BONUS_PER_REFERRAL });
    db.referrals.insert({ id: makeId('ref'), referrer_id: referrer.id, referred_id: id, created_at: new Date().toISOString() });
  }

  const token = signToken(id);
  res.status(201).json({ token, user: getFullUserState(id) });
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  const normalizedEmail = (email ?? '').trim().toLowerCase();
  const user = db.users.where((u) => u.email === normalizedEmail)[0];
  if (!user || !(await verifyPassword(password ?? '', user.password_hash))) {
    return res.status(401).json({ error: 'invalid email or password' });
  }
  const token = signToken(user.id);
  res.json({ token, user: getFullUserState(user.id) });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: getFullUserState(req.user.id) });
});
