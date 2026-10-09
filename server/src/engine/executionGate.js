// Decides whether an action may run at all, based on the owner's chosen
// mode — separate from the numeric budget/max-loss check in budget.js.
// 'research' never executes anything. 'approve' requires this specific
// action to already have an explicit approval record. 'auto_limited' runs
// automatically, but only ever within whatever budget/max-loss still allows.
export function checkExecutionGate({ mode, emergencyStop, hasApproval }) {
  if (emergencyStop) return { allowed: false, reason: 'emergency stop is active' };
  if (mode === 'research') return { allowed: false, reason: 'research mode only — no action is taken automatically' };
  if (mode === 'approve') {
    return hasApproval
      ? { allowed: true, reason: null }
      : { allowed: false, reason: 'awaiting explicit approval for this action' };
  }
  if (mode === 'auto_limited') return { allowed: true, reason: null };
  return { allowed: false, reason: `unknown mode: ${mode}` };
}
