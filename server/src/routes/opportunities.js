import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { db } from '../db/store.js';
import { computeNetProfit } from '../engine/feasibility.js';
import { rankOpportunities } from '../engine/ranking.js';
import { isPaddleConfigured } from '../services/paddle.js';
import { logAction } from '../services/execution.js';
import { createDigitalProductOpportunityUnderCap } from '../services/opportunities.js';
import { publishOpportunity } from '../services/publishing.js';
import { runAutonomousScan } from '../services/autonomousScan.js';

export const opportunitiesRouter = Router();

function withFeasibility(opportunity) {
  const feasibility = computeNetProfit({ revenueEstimate: opportunity.revenueEstimate, costs: opportunity.costs });
  const netProfitMid = feasibility.netProfit?.mid ?? null;
  return { ...opportunity, feasibility, netProfitMid };
}

// The one proven end-to-end path: AI drafts a real digital product + sales
// copy. Demand/revenue is left as missing data (never fabricated) until the
// owner sets their own estimate on the card.
export async function createDigitalProduct(req, res) {
  const { topic, audience } = req.body ?? {};
  if (!topic || !topic.trim()) return res.status(400).json({ error: 'נושא הוא שדה חובה' });
  if (!audience || !audience.trim()) return res.status(400).json({ error: 'קהל מטרה הוא שדה חובה' });

  // runAutonomousScan already refused a new draft past this same cap - this
  // manual route had no such limit at all, even though each draft here is
  // the exact same real, billed AI call. An API client bug or a stolen
  // owner token looping this route would otherwise have no limit
  // whatsoever on real-money AI spend; a legitimate owner is never
  // realistically blocked by this, since reaching 5 unreviewed drafts in a
  // row (without ever looking at any of them) is the "already enough to
  // review" state this cap exists for either way.
  //
  // Goes through createDigitalProductOpportunityUnderCap, not a separate
  // pendingDraftCount() check followed by its own createDigitalProductOpportunity
  // call - two near-simultaneous requests here (a double-click, two open
  // tabs, or exactly the scripted-client scenario the comment above warns
  // about) could otherwise both read the count before either had written,
  // letting through more of these real AI calls than this cap was ever
  // meant to allow. See services/opportunities.js for the shared lock.
  let result;
  try {
    result = await createDigitalProductOpportunityUnderCap({ topic: topic.trim(), audience: audience.trim(), createdBy: 'owner' });
  } catch (err) {
    // services/autonomousScan.js already logs its own equivalent AI-call
    // failure (type: 'autonomous_scan', result: 'failed') - this manual
    // route had no such entry at all, so the exact same underlying failure
    // (a rate limit, an invalid ANTHROPIC_API_KEY, the AI returning
    // malformed JSON) left zero trace in the activity log when triggered
    // from the owner's own "מוצר דיגיטלי חדש" form, only a one-time error
    // shown synchronously in the form itself - directly contradicting this
    // app's own stated "the log shows every action the system tried,
    // including failures" promise (Guide.jsx). err.message here is already
    // clean Hebrew (engine/productDraft.js never throws raw English), same
    // safety guarantee autonomousScan.js's own identical logAction call
    // already relies on.
    logAction({ type: 'draft_product', detail: { topic: topic.trim(), audience: audience.trim(), error: err.message }, result: 'failed' });
    return res.status(502).json({ error: `יצירת הטיוטה נכשלה: ${err.message}` });
  }
  if (!result.ok) {
    if (result.concurrent) {
      return res.status(409).json({ error: 'יצירת טיוטה אחרת כבר רצה באותו רגע בדיוק — נסה שוב בעוד רגע' });
    }
    return res.status(409).json({ error: `יש כבר ${result.pendingDrafts} טיוטות שממתינות לסקירה — סקור או דחה חלק מהן לפני יצירת טיוטה נוספת` });
  }

  res.status(201).json({ opportunity: withFeasibility(result.opportunity) });
}

// Manually trigger the same scan the scheduler runs periodically — useful to
// test the autonomous loop without waiting for the next scheduled run.
export async function triggerAutonomousScan(req, res) {
  const result = await runAutonomousScan();
  res.json(result);
}

export function listOpportunities(req, res) {
  const withFeas = db.opportunities.all().map(withFeasibility);
  res.json({ opportunities: rankOpportunities(withFeas) });
}

export function getOpportunity(req, res) {
  const opportunity = db.opportunities.get(req.params.id);
  if (!opportunity) return res.status(404).json({ error: 'לא נמצא' });
  res.json({ opportunity: withFeasibility(opportunity) });
}

// missingInfo is a one-time snapshot written at creation (what was
// missing when the AI drafted this product) - services/opportunities.js
// sets it, nothing reads it back, and the client never sends it in a
// PATCH. It used to be on this allow-list anyway, with no validation at
// all unlike every other field here, so any value - a string, a number,
// null - could be stored through it with no check. Since nothing
// legitimately edits it, it has no business being editable through this
// general endpoint at all.
const EDITABLE_FIELDS = ['revenueEstimate', 'costs', 'riskLevel', 'dataQuality', 'priceUSD'];

// A non-finite value here wouldn't crash anything — it would silently
// corrupt computeNetProfit's totals (NaN propagating through the profit
// math) instead of being rejected, so the dashboard would show "$NaN" to
// the owner instead of a clear error. Reject it at the door.
function isFiniteOrNullish(value) {
  return value == null || (typeof value === 'number' && Number.isFinite(value));
}

const VALID_RISK_LEVELS = ['low', 'medium', 'high'];
const VALID_DATA_QUALITIES = ['unknown', 'estimated', 'verified'];

export function patchOpportunity(req, res) {
  const opportunity = db.opportunities.get(req.params.id);
  if (!opportunity) return res.status(404).json({ error: 'לא נמצא' });
  const patch = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in (req.body ?? {})) patch[field] = req.body[field];
  }

  // Every other editable field here is validated before being stored —
  // these two were the exception, with no check at all. Nothing crashes on
  // an invalid value (ranking.js's weight lookups already fall back safely
  // for an unrecognized key), but a stray value here would still silently
  // get the wrong risk/quality weight in the ranking score with no error
  // telling the caller why, rather than being rejected at the door like
  // every other field on this same endpoint.
  if ('riskLevel' in patch && !VALID_RISK_LEVELS.includes(patch.riskLevel)) {
    return res.status(400).json({ error: `רמת הסיכון חייבת להיות אחת מ: ${VALID_RISK_LEVELS.join(', ')}` });
  }
  if ('dataQuality' in patch && !VALID_DATA_QUALITIES.includes(patch.dataQuality)) {
    return res.status(400).json({ error: `איכות הנתונים חייבת להיות אחת מ: ${VALID_DATA_QUALITIES.join(', ')}` });
  }

  if ('revenueEstimate' in patch && patch.revenueEstimate !== null) {
    // A non-object value here (a raw number, string or array) destructures
    // to low/mid/high all undefined - isFiniteOrNullish treats undefined as
    // nullish, so it passed this check vacuously and got stored as-is.
    // computeNetProfit (feasibility.js) already treats a malformed
    // revenueEstimate as "missing" rather than corrupting the math, so
    // nothing crashes - but this endpoint rejects every other malformed
    // field at the door instead of silently storing it, and this one
    // should too.
    if (typeof patch.revenueEstimate !== 'object' || Array.isArray(patch.revenueEstimate)) {
      return res.status(400).json({ error: 'הערכת ההכנסה חייבת להיות אובייקט עם low/mid/high, או ריקה' });
    }
    const { low, mid, high } = patch.revenueEstimate;
    if (!isFiniteOrNullish(low) || !isFiniteOrNullish(mid) || !isFiniteOrNullish(high)) {
      return res.status(400).json({ error: 'הערכת ההכנסה (נמוכה/בינונית/גבוהה) חייבת להיות מספר סופי או ריקה' });
    }
    // Each field individually passing finiteness doesn't catch an
    // inverted range (low > high) - computeNetProfit would still run
    // the subtraction and show it as-is, e.g. "$400 – $100" on the
    // opportunity page, reading as a display bug rather than what it
    // actually is: bad input data that was never rejected.
    if (low != null && high != null && low > high) {
      return res.status(400).json({ error: 'הערכת ההכנסה הנמוכה לא יכולה להיות גבוהה מההערכה הגבוהה' });
    }
  }
  if ('costs' in patch && patch.costs != null) {
    // Object.entries on a raw number (e.g. costs: 5) returns [] - the loop
    // below then never runs, totalCost silently stays 0, and the real cost
    // the caller tried to set is just dropped with no error at all. That
    // directly contradicts feasibility.js's own stated promise ("any
    // missing cost field is reported as missing rather than treated as
    // zero") - a wrong-typed costs payload must be rejected here, the same
    // as every other malformed field on this endpoint, not silently
    // coerced into "no costs".
    if (typeof patch.costs !== 'object' || Array.isArray(patch.costs)) {
      return res.status(400).json({ error: 'העלויות חייבות להיות אובייקט עם ערכים מספריים, או ריקות' });
    }
    for (const [key, value] of Object.entries(patch.costs)) {
      if (!isFiniteOrNullish(value)) {
        return res.status(400).json({ error: `העלות "${key}" חייבת להיות מספר סופי או ריקה (לא ידוע)` });
      }
      // Unlike revenueEstimate.low (which can legitimately be negative - a
      // worst-case loss scenario is still a coherent estimate), a cost is
      // money going out and can never be negative. Letting one through
      // would silently inflate computeNetProfit's totalCost subtraction
      // into an addition, showing the owner a profit higher than what's
      // actually true from a single typo (e.g. "-5" instead of "5") -
      // exactly the kind of fabricated number this app exists to avoid,
      // even when the mistake is the owner's own.
      if (value != null && value < 0) {
        return res.status(400).json({ error: `העלות "${key}" חייבת להיות מספר לא שלילי` });
      }
    }
  }
  // priceUSD, unlike revenueEstimate/costs, is never meaningfully "unknown" —
  // a product always has a real price — so null is rejected here too, not
  // just non-numbers; `patch.priceUSD <= 0` alone would wrongly let null
  // slip through on the "null <= 0" coercion.
  if ('priceUSD' in patch && !(typeof patch.priceUSD === 'number' && Number.isFinite(patch.priceUSD) && patch.priceUSD > 0)) {
    return res.status(400).json({ error: 'מחיר המוצר חייב להיות מספר חיובי' });
  }
  // Once published, priceUSD is baked into a real Paddle price object
  // (publishing.js never updates an existing one — there's no API for
  // that) — the live sales page and the actual checkout amount are fixed
  // to whatever it was at publish time. Letting it be edited afterward
  // would silently desync the dashboard's number from what a real
  // customer is actually charged.
  //
  // patch.priceUSD !== opportunity.priceUSD, not just 'priceUSD' in patch:
  // OpportunityDetail.jsx's save form always resends priceUSD on every
  // save (it's a controlled form, not a per-field PATCH), including the
  // disabled, untouched field on an already-published opportunity — the
  // bare presence check below blocked that resend unconditionally, so the
  // owner could never save a new revenueEstimate/costs/riskLevel on a
  // published opportunity either, every attempt 400ing with this exact
  // unrelated price-change error.
  if ('priceUSD' in patch && patch.priceUSD !== opportunity.priceUSD && opportunity.status === 'published') {
    return res.status(400).json({ error: 'לא ניתן לשנות מחיר אחרי פרסום — המחיר כבר קבוע ב-Paddle' });
  }
  // In "approve" mode the owner explicitly approves publish_product for
  // this exact opportunity before it runs — but that approval record has
  // no memory of what priceUSD was at the time. Without this, approving at
  // $9 and then changing the price to $29 would leave the approval sitting
  // there as "approved", and publishing would go ahead at $29 under an
  // approval that was only ever given for $9. Changing the actual charged
  // price must force a fresh approval.
  if ('priceUSD' in patch && patch.priceUSD !== opportunity.priceUSD) {
    const staleApproval = db.approvals.where(
      (a) => a.opportunityId === opportunity.id && a.actionType === 'publish_product' && a.status === 'approved'
    )[0];
    if (staleApproval) {
      db.approvals.update(staleApproval.id, { status: 'rejected', rejectedAt: new Date().toISOString() });
      logAction({ type: 'reject', detail: { opportunityId: opportunity.id, actionType: 'publish_product', reason: 'price changed after approval' }, result: 'success' });
    }
  }

  const updated = db.opportunities.update(req.params.id, patch);
  res.json({ opportunity: withFeasibility(updated) });
}

// The gated, idempotent, audit-logged action that actually makes the
// product public. Blocked unless the mode/approval/budget gate allows it
// (research mode, no approval yet, or emergency stop).
export async function publishOpportunityRoute(req, res) {
  const opportunity = db.opportunities.get(req.params.id);
  if (!opportunity) return res.status(404).json({ error: 'לא נמצא' });
  // Without this, hitting publish again on an already-live opportunity (a
  // stray repeat request, a retried script) would sail through the
  // idempotency check — that key is scoped per day, so a next-day call
  // slips past it — and write a fresh "publish_product: success" entry to
  // the audit log even though nothing actually happened: perform() finds
  // paddlePriceId/slug already set and just re-saves the same status.
  if (opportunity.status === 'published') {
    return res.status(409).json({ error: 'כבר פורסם', duplicate: true });
  }
  // The owner explicitly dismissed this one via rejectOpportunity above —
  // without this check, a stray repeat click, a stale approval, or a race
  // against the autonomous scan could still carry it through to a real
  // Paddle checkout and reverse the owner's own decision not to pursue it.
  if (opportunity.status === 'rejected') {
    return res.status(409).json({ error: 'ההזדמנות הזו נדחתה ולא ניתן לפרסם אותה' });
  }
  if (!isPaddleConfigured()) {
    logAction({ type: 'publish_product', detail: { opportunityId: opportunity.id }, result: 'blocked: Paddle עדיין לא מוגדר' });
    return res.status(503).json({ error: 'Paddle עדיין לא מוגדר — לא ניתן לפתוח תשלום אמיתי' });
  }

  let result;
  try {
    result = await publishOpportunity(opportunity);
  } catch (err) {
    // perform() failed (e.g. Paddle API unreachable) — executeGatedAction
    // already logged it; respond cleanly instead of crashing the process.
    return res.status(502).json({ error: `הפרסום נכשל: ${err.message}` });
  }

  if (!result.allowed) return res.status(409).json({ error: result.reason, duplicate: Boolean(result.duplicate) });
  res.json({ opportunity: withFeasibility(db.opportunities.get(opportunity.id)) });
}

// Lets the owner permanently dismiss a draft they don't want to pursue.
// Before this, 'rejected' was a status several places already defensively
// filtered out (digest.js's recommendation, Dashboard.jsx's active-list,
// Opportunities.jsx's own status label) but nothing could ever actually
// set it - a draft the owner didn't want just sat there forever. That's
// not just a missing feature: runAutonomousScan's MAX_PENDING_DRAFTS cap
// only clears a draft by publishing it, so 5 ideas the owner doesn't want
// to publish would permanently starve the autonomous loop with no way to
// clear them short of publishing something unwanted.
export function rejectOpportunity(req, res) {
  const opportunity = db.opportunities.get(req.params.id);
  if (!opportunity) return res.status(404).json({ error: 'לא נמצא' });
  if (opportunity.status === 'published') {
    return res.status(409).json({ error: 'אי אפשר לדחות הזדמנות שכבר פורסמה' });
  }
  if (opportunity.status === 'rejected') {
    return res.status(409).json({ error: 'כבר נדחה', duplicate: true });
  }
  const updated = db.opportunities.update(opportunity.id, { status: 'rejected', rejectedAt: new Date().toISOString() });
  // Same reasoning as the stale-approval invalidation on a price change
  // (above): an "approve"-mode approval has no memory of the opportunity
  // being rejected afterward, so without this it would sit there as
  // "approved" forever even though publishing is now permanently blocked.
  const staleApproval = db.approvals.where(
    (a) => a.opportunityId === opportunity.id && a.actionType === 'publish_product' && a.status === 'approved'
  )[0];
  if (staleApproval) {
    db.approvals.update(staleApproval.id, { status: 'rejected', rejectedAt: new Date().toISOString() });
    logAction({ type: 'reject', detail: { opportunityId: opportunity.id, actionType: 'publish_product', reason: 'opportunity was rejected' }, result: 'success' });
  }
  logAction({ type: 'reject_opportunity', detail: { opportunityId: opportunity.id }, result: 'success' });
  res.json({ opportunity: withFeasibility(updated) });
}

opportunitiesRouter.post('/opportunities/digital-product', requireOwner, asyncHandler(createDigitalProduct));
opportunitiesRouter.post('/opportunities/autonomous-scan', requireOwner, asyncHandler(triggerAutonomousScan));
opportunitiesRouter.get('/opportunities', requireOwner, listOpportunities);
opportunitiesRouter.get('/opportunities/:id', requireOwner, getOpportunity);
opportunitiesRouter.patch('/opportunities/:id', requireOwner, patchOpportunity);
opportunitiesRouter.post('/opportunities/:id/publish', requireOwner, asyncHandler(publishOpportunityRoute));
opportunitiesRouter.post('/opportunities/:id/reject', requireOwner, rejectOpportunity);
