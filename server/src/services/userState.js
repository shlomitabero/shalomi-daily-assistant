import { db } from '../db/store.js';
import { todayKey, remainingGenerations, FREE_DAILY_LIMIT } from '../engine/usage.js';

export function isUserPaid(userId) {
  const sub = db.subscriptions.where((s) => s.user_id === userId && ['active', 'trialing'].includes(s.status))[0];
  return Boolean(sub);
}

export function getFullUserState(userId) {
  const user = db.users.get(userId);
  if (!user) return null;
  const today = todayKey();
  const generationsToday = db.generations.where((g) => g.user_id === userId && g.created_at.slice(0, 10) === today).length;
  const paid = isUserPaid(userId);
  const remaining = remainingGenerations({ isPaid: paid, generationsToday, bonusGenerations: user.bonus_generations });
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();

  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    createdAt: user.created_at,
    referralCode: user.referral_code,
    bonusGenerations: user.bonus_generations,
    streak: user.streak ?? 0,
    isPaid: paid,
    isAdmin: Boolean(adminEmail) && user.email.toLowerCase() === adminEmail,
    generationsToday,
    freeDailyLimit: FREE_DAILY_LIMIT,
    remainingGenerations: remaining === Infinity ? null : remaining,
    referralsCount: db.users.where((u) => u.referred_by === userId).length,
  };
}
