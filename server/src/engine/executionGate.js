// Decides whether an action may run at all, based on the owner's chosen
// mode — separate from the numeric budget/max-loss check in budget.js.
// 'research' never executes anything. 'approve' requires this specific
// action to already have an explicit approval record. 'auto_limited' runs
// automatically, but only ever within whatever budget/max-loss still allows.
export function checkExecutionGate({ mode, emergencyStop, hasApproval }) {
  // Reasons are Hebrew, not English — this text reaches the owner directly
  // (a 409 error on the publish button, a row in the Hebrew activity log),
  // and an English sentence dropped into an otherwise all-Hebrew app read
  // as broken/untranslated rather than as a deliberate safety block.
  if (emergencyStop) return { allowed: false, reason: 'עצירת חירום פעילה' };
  if (mode === 'research') return { allowed: false, reason: 'מצב מחקר בלבד — שום פעולה לא מתבצעת אוטומטית' };
  if (mode === 'approve') {
    return hasApproval
      ? { allowed: true, reason: null }
      : { allowed: false, reason: 'ממתין לאישור מפורש לפעולה הזו' };
  }
  if (mode === 'auto_limited') return { allowed: true, reason: null };
  return { allowed: false, reason: `מצב לא מוכר: ${mode}` };
}
