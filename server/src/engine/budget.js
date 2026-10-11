// The spending gate every paid action must pass. Spending budget is zero
// until the owner explicitly sets one — this function enforces that rather
// than trusting a caller's "budget" field, so a bug elsewhere can't silently
// authorize real spend.
export function canSpend({ amount, budgetConfigured, budget, spentSoFar = 0, maxLoss = null, lossSoFar = 0, emergencyStop = false }) {
  // Reasons are Hebrew, not English — they reach the owner directly (a 409
  // on the publish button, a row in the Hebrew activity log), and an
  // English sentence dropped into an otherwise all-Hebrew app read as
  // broken/untranslated rather than as a deliberate safety block.
  if (emergencyStop) return { allowed: false, reason: 'עצירת חירום פעילה' };
  if (!budgetConfigured) return { allowed: false, reason: 'עדיין לא הוגדר תקציב' };
  if (!(amount > 0)) return { allowed: false, reason: 'סכום ההוצאה חייב להיות חיובי' };
  if (spentSoFar + amount > budget) {
    return { allowed: false, reason: `יחרוג מהתקציב (${spentSoFar} + ${amount} > ${budget})` };
  }
  if (maxLoss != null) {
    // A non-numeric maxLoss (e.g. corrupted data, a bad request that slipped
    // past validation) must never silently disable this guardrail — "5 >
    // 'abc'" is false in JS, so an invalid value would otherwise make every
    // spend pass this check as if no loss limit were set at all.
    if (!Number.isFinite(maxLoss)) {
      return { allowed: false, reason: `הפסד מרבי מוגדר לערך לא תקין (${JSON.stringify(maxLoss)}) — תקן בהגדרות לפני ביצוע הוצאה` };
    }
    if (lossSoFar + amount > maxLoss) {
      return { allowed: false, reason: `יחרוג מההפסד המרבי המותר (${lossSoFar} + ${amount} > ${maxLoss})` };
    }
  }
  return { allowed: true, reason: null };
}
