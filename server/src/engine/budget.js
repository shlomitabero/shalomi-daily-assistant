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
  if (maxLoss != null && lossSoFar + amount > maxLoss) {
    return { allowed: false, reason: `would exceed the maximum acceptable loss (${lossSoFar} + ${amount} > ${maxLoss})` };
  }
  return { allowed: true, reason: null };
}
