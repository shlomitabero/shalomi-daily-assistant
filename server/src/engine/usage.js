// Usage limits — the paywall's entire brain lives here as pure functions so
// it's trivially unit-testable and the route layer can't accidentally
// trust a client-supplied "I haven't used my free generations yet" claim.
export const FREE_DAILY_LIMIT = 5;
export const BONUS_PER_REFERRAL = 5;

export function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

// Bonus credits (from referrals) are used only after the free daily quota
// is exhausted, so they're a true bonus rather than a way to dodge the
// daily reset.
export function remainingGenerations({ isPaid, generationsToday, bonusGenerations }) {
  if (isPaid) return Infinity;
  const freeLeft = Math.max(0, FREE_DAILY_LIMIT - generationsToday);
  return freeLeft + Math.max(0, bonusGenerations ?? 0);
}

export function canGenerate(ctx) {
  return remainingGenerations(ctx) > 0;
}

// Returns how to account for one generation being consumed. Throws if the
// caller didn't check canGenerate first — the route layer always checks
// first, so this throwing is a signal something upstream is wrong.
export function consumeGeneration({ isPaid, generationsToday, bonusGenerations }) {
  if (isPaid) return { bonusGenerationsUsed: 0 };
  if (generationsToday < FREE_DAILY_LIMIT) return { bonusGenerationsUsed: 0 };
  if ((bonusGenerations ?? 0) > 0) return { bonusGenerationsUsed: 1 };
  throw new Error('no generations remaining');
}
