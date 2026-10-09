import { db, makeId } from '../db/store.js';
import { canSpend } from '../engine/budget.js';
import { checkExecutionGate } from '../engine/executionGate.js';
import { makeIdempotencyKey } from '../engine/idempotency.js';
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

  const alreadyDone = db.actions_log.where(
    (a) => a.detail?.idempotencyKey === key && a.result === 'success'
  ).length > 0;
  if (alreadyDone) return { allowed: false, duplicate: true, reason: 'this exact action was already performed today' };

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
