// The spending gate every paid action must pass. Spending budget is zero
// until the owner explicitly sets one — this function enforces that rather
// than trusting a caller's "budget" field, so a bug elsewhere can't silently
// authorize real spend.
export function canSpend({ amount, budgetConfigured, budget, spentSoFar = 0, maxLoss = null, lossSoFar = 0, emergencyStop = false }) {
  if (emergencyStop) return { allowed: false, reason: 'emergency stop is active' };
  if (!budgetConfigured) return { allowed: false, reason: 'no budget has been set yet' };
  if (!(amount > 0)) return { allowed: false, reason: 'spend amount must be positive' };
  if (spentSoFar + amount > budget) {
    return { allowed: false, reason: `would exceed budget (${spentSoFar} + ${amount} > ${budget})` };
  }
  if (maxLoss != null) {
    // A non-numeric maxLoss (e.g. corrupted data, a bad request that slipped
    // past validation) must never silently disable this guardrail — "5 >
    // 'abc'" is false in JS, so an invalid value would otherwise make every
    // spend pass this check as if no loss limit were set at all.
    if (!Number.isFinite(maxLoss)) {
      return { allowed: false, reason: `maxLoss is set to an invalid value (${JSON.stringify(maxLoss)}) — fix it in settings before spending` };
    }
    if (lossSoFar + amount > maxLoss) {
      return { allowed: false, reason: `would exceed the maximum acceptable loss (${lossSoFar} + ${amount} > ${maxLoss})` };
    }
  }
  return { allowed: true, reason: null };
}
