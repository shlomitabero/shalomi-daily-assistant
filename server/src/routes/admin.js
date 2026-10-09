import { Router } from 'express';
import { db } from '../db/store.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { todayKey } from '../engine/usage.js';

export const adminRouter = Router();

function dayKeysBack(n) {
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

adminRouter.get('/admin/stats', requireAuth, requireAdmin, (req, res) => {
  const users = db.users.all();
  const generations = db.generations.all();
  const activeSubs = db.subscriptions.where((s) => ['active', 'trialing'].includes(s.status));
  const today = todayKey();

  const pricePerMonth = Number(process.env.PRO_PRICE_USD ?? 9);
  const mrr = activeSubs.length * pricePerMonth;

  const last7 = dayKeysBack(7).map((day) => ({
    day,
    signups: users.filter((u) => u.created_at.slice(0, 10) === day).length,
    generations: generations.filter((g) => g.created_at.slice(0, 10) === day).length,
    dau: new Set(generations.filter((g) => g.created_at.slice(0, 10) === day).map((g) => g.user_id)).size,
  }));

  res.json({
    totalSignups: users.length,
    dauToday: new Set(generations.filter((g) => g.created_at.slice(0, 10) === today).map((g) => g.user_id)).size,
    paidSubscribers: activeSubs.length,
    conversionRate: users.length ? Math.round((activeSubs.length / users.length) * 1000) / 10 : 0,
    mrr,
    pricePerMonth,
    totalGenerations: generations.length,
    totalReferrals: db.referrals.all().length,
    last7,
  });
});
