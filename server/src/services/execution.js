import { db, makeId } from '../db/store.js';
import { canSpend } from '../engine/budget.js';
import { checkExecutionGate } from '../engine/executionGate.js';
import { makeIdempotencyKey, wasAlreadyPerformed } from '../engine/idempotency.js';
import { getSettings } from './settings.js';
import { totalSpentSoFar, totalLossSoFar, todayKey } from './ledger.js';

export function logAction({ type, detail, result }) {
  return db.actions_log.insert({ id: makeId('act'), type, detail, result, createdAt: new Date().toISOString() });
}

function hasApprovalFor(opportunityId, actionType) {
  return db.approvals.where((a) => a.opportunityId === opportunityId && a.actionType === actionType && a.status === 'approved').length > 0;
}

// The single choke point every real-world action (publishing, charging,
// trading) must go through: mode gate -> budget gate (only when real money
// is at stake) -> idempotency check -> run it -> always log the outcome.
export async function executeGatedAction({ opportunityId, actionType, amount = 0, perform }) {
  const settings = getSettings();
  const key = makeIdempotencyKey({ opportunityId, actionType, dateKey: todayKey() });

  // wasAlreadyPerformed is idempotency.js's own dedicated, tested "has this
  // exact action already run" check - until now nothing actually called it,
  // and this duplicated its exact logic inline instead.
  //
  // The key itself bakes in today's dateKey, so a match can structurally
  // only ever come from an entry logged today - an entry from any earlier
  // day was hashed with that day's own dateKey and can never equal today's
  // key. Without this filter, every single gated action (every scan tick,
  // every publish, every paper trade) re-scanned this app's *entire*
  // lifetime of actions_log just to compare against keys that could never
  // match - a scan that only ever gets slower as this history grows,
  // forever, for an app meant to run indefinitely. todayKey() on each
  // entry's own createdAt (not a plain .slice(0, 10) on the UTC
  // timestamp) keeps this comparison in the same Israel-local calendar as
  // the key itself, same reasoning as digest.js's own todayKey() reuse.
  const today = todayKey();
  const performedKeys = db.actions_log
    .where((a) => a.result === 'success' && todayKey(new Date(a.createdAt)) === today)
    .map((a) => a.detail?.idempotencyKey);
  const alreadyDone = wasAlreadyPerformed(key, performedKeys);
  if (alreadyDone) return { allowed: false, duplicate: true, reason: 'הפעולה הזו כבר בוצעה היום' };

  const modeGate = checkExecutionGate({
    mode: settings.mode,
    emergencyStop: settings.emergencyStop,
    hasApproval: hasApprovalFor(opportunityId, actionType),
  });
  if (!modeGate.allowed) {
    logAction({ type: actionType, detail: { opportunityId, amount, idempotencyKey: key }, result: `blocked: ${modeGate.reason}` });
    return { allowed: false, reason: modeGate.reason };
  }

  if (amount > 0) {
    const budgetGate = canSpend({
      amount,
      budgetConfigured: settings.budgetConfigured,
      budget: settings.budget,
      spentSoFar: totalSpentSoFar(),
      maxLoss: settings.maxLoss,
      lossSoFar: totalLossSoFar(),
      emergencyStop: settings.emergencyStop,
    });
    if (!budgetGate.allowed) {
      logAction({ type: actionType, detail: { opportunityId, amount, idempotencyKey: key }, result: `blocked: ${budgetGate.reason}` });
      return { allowed: false, reason: budgetGate.reason };
    }
  }

  try {
    const outcome = await perform();
    logAction({ type: actionType, detail: { opportunityId, amount, idempotencyKey: key, outcome }, result: 'success' });
    return { allowed: true, outcome };
  } catch (err) {
    logAction({ type: actionType, detail: { opportunityId, amount, idempotencyKey: key, error: err.message }, result: 'failed' });
    throw err;
  }
}
