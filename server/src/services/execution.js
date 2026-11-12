import { db, makeId } from '../db/store.js';
import { canSpend } from '../engine/budget.js';
import { checkExecutionGate } from '../engine/executionGate.js';
import { makeIdempotencyKey, wasAlreadyPerformed } from '../engine/idempotency.js';
import { getSettings } from './settings.js';
import { totalSpentSoFar, totalLossSoFar, todayKey } from './ledger.js';

// This app is explicitly built to run indefinitely (autonomous_scan alone
// logs roughly every 4 hours, every day, forever) - db/store.js's persist()
// re-serializes and rewrites the ENTIRE db.json on every single write, to
// every table, not just this one, so an actions_log that only ever grows
// would progressively slow down every future write in the whole app, not
// just future logAction calls. routes/auth.js's own login_attempt pruning
// already solved this exact problem for that one type specifically (same
// reasoning, smaller cap, since a brute-force attempt can log far faster)
// - every OTHER type was left unbounded.
//
// sale_confirmed is the one type this must never prune: ledger.js's
// countUnrecordedSales() scans this type's ENTIRE lifetime history (a
// blocked sale_confirmed means a real payment came in and was never
// recorded, with no route that ever marks it resolved), so dropping an old
// one could silently hide a real, still-open payment problem. login_attempt
// already has its own tighter, dedicated cap - pruning it again here would
// just be redundant, not wrong, but excluding it keeps this cap's own
// accounting simple. Every other type is only ever read either capped
// (listActions: 200 most recent) or scoped to today (generateDailyDigest,
// executeGatedAction's own idempotency check below) - nothing else needs
// more than a bounded recent history - listActions() itself never shows
// more than its own most recent 200 regardless, so this cap only needs to
// comfortably clear that, not approach it. Same value as login_attempt's
// own dedicated cap, for simplicity.
const MAX_ACTIONS_LOG_ENTRIES = 500;
const UNPRUNABLE_ACTION_TYPES = new Set(['sale_confirmed', 'login_attempt']);

export function logAction({ type, detail, result }) {
  const entry = db.actions_log.insert({ id: makeId('act'), type, detail, result, createdAt: new Date().toISOString() });
  pruneActionsLog();
  return entry;
}

function pruneActionsLog() {
  const prunable = db.actions_log.where((a) => !UNPRUNABLE_ACTION_TYPES.has(a.type));
  const excess = prunable.length - MAX_ACTIONS_LOG_ENTRIES;
  if (excess > 0) {
    prunable
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .slice(0, excess)
      .forEach((entry) => db.actions_log.delete(entry.id));
  }
}

function hasApprovalFor(opportunityId, actionType) {
  return db.approvals.where((a) => a.opportunityId === opportunityId && a.actionType === actionType && a.status === 'approved').length > 0;
}

// Guards the gap between reading performedKeys below and perform()'s own
// effects (a real Paddle API call, a real ledger write) landing afterward
// in logAction's own success entry. Without this, two concurrent calls for
// the exact same key (opportunityId:actionType:today) - the owner
// double-clicking "פרסם מוצר", or the same action triggered from two open
// tabs - could both read "not yet performed today" before either had
// logged success, and both run perform(). For publish_product specifically,
// that means two real Paddle price objects created for the same product,
// with whichever db.opportunities.update() landed last silently
// overwriting the other's paddlePriceId/slug - the first Paddle price then
// sits orphaned, with nothing in this app ever referencing it again. Keyed
// by the idempotency key itself (not a single flag), so an unrelated
// action for a different opportunity, or even the same opportunity's other
// action type, is never needlessly blocked by this.
const actionKeysInProgress = new Set();

// The single choke point every real-world action (publishing, charging,
// trading) must go through: mode gate -> budget gate (only when real money
// is at stake) -> idempotency check -> run it -> always log the outcome.
export async function executeGatedAction({ opportunityId, actionType, amount = 0, perform }) {
  const settings = getSettings();
  const key = makeIdempotencyKey({ opportunityId, actionType, dateKey: todayKey() });

  if (actionKeysInProgress.has(key)) {
    return { allowed: false, duplicate: true, reason: 'הפעולה הזו כבר מתבצעת באותו רגע בדיוק — נסה שוב בעוד רגע' };
  }
  actionKeysInProgress.add(key);
  try {
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
  } finally {
    actionKeysInProgress.delete(key);
  }
}
