// A plain `${n.toFixed(2)}` puts the minus sign AFTER the dollar sign for a
// negative value ("$-45.50" instead of "-$45.50") - a real, reachable case
// now that revenueEstimate.low is explicitly allowed to be negative (a
// coherent worst-case loss scenario), and net profit (today, all-time, or
// per-opportunity) can go negative any time costs exceed revenue. Mirrors
// engine/digest.js's formatMoney on the server for the exact same reason.
export function formatMoney(n, decimals = 2) {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(decimals)}`;
}

// Shared Hebrew labels for the raw action-type codes the server logs
// (services/execution.js logAction calls) — without this, the activity
// log and the approvals page showed codes like "publish_product" or
// "autonomous_scan" verbatim, English snake_case dropped into an
// otherwise all-Hebrew app.
export const ACTION_TYPE_LABEL = {
  draft_product: 'יצירת טיוטת מוצר',
  autonomous_scan: 'סריקה אוטונומית',
  approve: 'אישור פעולה',
  reject: 'ביטול אישור',
  reject_opportunity: 'דחיית הזדמנות',
  publish_product: 'פרסום מוצר',
  sale_confirmed: 'מכירה אומתה',
  paper_trade: 'עסקה מדומה',
  client_error: 'תקלה במסך',
  login_attempt: 'ניסיון התחברות',
};

export function actionTypeLabel(type) {
  return ACTION_TYPE_LABEL[type] ?? type;
}

// logAction's `result` field is always a string that starts with one of
// these English words, sometimes followed by a free-text detail (which may
// itself already be Hebrew, e.g. the gate/budget block reasons). Only the
// leading word is translated here — rewriting every ad-hoc detail string
// across the codebase is a bigger change than this touches.
const RESULT_PREFIX_LABEL = { success: 'הצלחה', failed: 'נכשל', blocked: 'נחסם', skipped: 'הודלג' };

export function resultLabel(result) {
  if (typeof result !== 'string') return result;
  const [prefix, ...rest] = result.split(': ');
  const label = RESULT_PREFIX_LABEL[prefix];
  if (!label) return result;
  return rest.length ? `${label}: ${rest.join(': ')}` : label;
}

// riskLevel ('low'/'medium'/'high') already had a Hebrew <select> in
// OpportunityDetail's edit form, but the opportunities list rendered the
// same raw English value as plain text right next to it.
const RISK_LEVEL_LABEL = { low: 'נמוכה', medium: 'בינונית', high: 'גבוהה' };

export function riskLevelLabel(level) {
  return RISK_LEVEL_LABEL[level] ?? level;
}

// Paper-trade side ('long'/'short') already had a Hebrew <select> on the
// Financial page's trade form, but the trade history list below it showed
// the same raw English value next to the symbol.
const SIDE_LABEL = { long: 'לונג', short: 'שורט' };

export function sideLabel(side) {
  return SIDE_LABEL[side] ?? side;
}

// opportunity.status ('draft'/'published'/'rejected') already had a Hebrew
// badge on the opportunities list, but the opportunity detail page showed
// the raw English value in its own header line.
const OPPORTUNITY_STATUS_LABEL = { draft: 'טיוטה', published: 'פורסם', rejected: 'נדחה' };

export function opportunityStatusLabel(status) {
  return OPPORTUNITY_STATUS_LABEL[status] ?? status;
}

// opportunity.source is a SOURCE_DEFINITIONS id (server/src/engine/
// sourceDefinitions.js) — the opportunity detail page showed this raw
// snake_case id instead of the source's real Hebrew name.
const SOURCE_LABEL = {
  ai_digital_products: 'מוצרים דיגיטליים מבוססי AI',
  financial_markets: 'שווקים פיננסיים',
  affiliate_programs: 'שיווק שותפים ותוכניות תגמול',
  supplier_price_gaps: 'פערי מחירים בין ספקים',
  tenders_rfps: 'מכרזים ובקשות הצעות מחיר',
};

export function sourceLabel(source) {
  return SOURCE_LABEL[source] ?? source;
}

// opportunity.feasibility.missing (engine/feasibility.js) is a list of raw
// field keys ('revenueEstimate', 'cost:paymentProcessing') — OpportunityDetail
// showed this verbatim ("חסר מידע: revenueEstimate, cost:paymentProcessing"),
// English technical keys dropped into an otherwise all-Hebrew explanation
// with no indication of what they mean or what to do about them.
const MISSING_FIELD_LABEL = {
  revenueEstimate: 'הערכת הכנסה — אין ביקוש אמיתי מחובר, יש להזין הערכה משלך',
};
const MISSING_COST_LABEL = {
  aiUsage: 'עלות AI',
  paymentProcessing: 'עמלת סליקה',
};

// logAction's detail.reason is a free-text technical reason, written in
// English in the one place that currently populates it (opportunities.js's
// stale-approval invalidation) — the activity log showed only the action
// type and "success", with no way to tell an automatic price-change
// rejection apart from the owner manually clicking reject on the same
// opportunity, which logs identically with no reason at all.
const REASON_LABEL = {
  'price changed after approval': 'האישור בוטל אוטומטית — המחיר השתנה אחרי שאושר',
  'opportunity was rejected': 'האישור בוטל אוטומטית — ההזדמנות נדחתה',
};

export function reasonLabel(reason) {
  return REASON_LABEL[reason] ?? reason;
}

// Turns one 'autonomous_scan' actions_log entry (server/src/services/
// autonomousScan.js's logAction calls) into a plain Hebrew sentence. The
// raw result strings ('success', 'blocked: source not connected',
// 'skipped: N drafts already awaiting review', 'failed') are exactly what
// the activity log already shows via resultLabel, but that owner would
// have to go dig through the full (unrelated-actions-mixed-in) activity
// log to find the one entry that actually answers "is my scanner
// working" - this gives the Opportunities page's own scan card the same
// answer directly, in the one place someone asking that question would
// actually look. Every branch below builds its own full Hebrew sentence
// from the entry's structured detail instead of reusing any English
// free text straight from the result string.
export function autonomousScanSummary(action) {
  if (!action) return 'עדיין לא רצה סריקה אוטונומית.';
  const { result, detail } = action;
  if (result === 'success') {
    return detail?.published ? 'נוצרה הזדמנות חדשה ופורסמה אוטומטית.' : 'נוצרה הזדמנות חדשה (טיוטה, מחכה לסקירה שלך).';
  }
  if (typeof result === 'string' && result.startsWith('blocked: source not connected')) {
    return 'המקור "מוצרים דיגיטליים מבוססי AI" לא מחובר — ראה עמוד "מקורות הכנסה".';
  }
  if (typeof result === 'string' && result.startsWith('skipped: another draft creation was in progress')) {
    // services/opportunities.js's own lock (closing the race between the
    // scan's fast pendingDraftCount() check and the manual route's own
    // draft creation) logs this same 'skipped:' prefix as the pending-
    // drafts-cap case right below - without its own branch here, this fell
    // straight into that one instead, showing a nonsensical "? הזדמנויות
    // כבר ממתינות לסקירה שלך" (detail here has no pendingDrafts at all) and
    // wrongly implying a review backlog when the real cause was a one-off
    // timing conflict with the manual "צור טיוטת מוצר" form, not the
    // 5-draft cap this page's own Guide.jsx documents as the normal pause
    // reason.
    return 'הסריקה נדחתה זמנית — יצירת טיוטה אחרת (ידנית) רצה באותו רגע בדיוק. הסריקה הבאה תנסה שוב.';
  }
  if (typeof result === 'string' && result.startsWith('skipped:')) {
    // The raw result string's own free-text detail ('N drafts already
    // awaiting review', from autonomousScan.js's logAction call) is
    // English — slicing it straight into this sentence (the previous
    // approach) left "הסריקה הושהתה — 5 drafts already awaiting review."
    // on the Opportunities page and the activity log, for the single most
    // common real reason the scan ever pauses itself (Guide.jsx documents
    // this exact 5-draft cap as expected behavior, not a rare edge case).
    // detail.pendingDrafts is the same number, logged as real data rather
    // than baked into an English sentence - build the Hebrew sentence
    // from that instead of the result string's own wording.
    return `הסריקה הושהתה — ${detail?.pendingDrafts ?? '?'} הזדמנויות כבר ממתינות לסקירה שלך.`;
  }
  if (typeof result === 'string' && result.startsWith('failed')) {
    // detail.error is raw English straight from whatever failed
    // (the AI call or the draft-creation service) - not fit to show the
    // owner directly, and autonomousScan.js already console.errors the
    // same detail for Railway's own log viewer, same split as every other
    // service-level failure in this app.
    return 'הסריקה נכשלה — בדוק את לוגי השרת לפרטים.';
  }
  return resultLabel(result);
}

// Turns one 'sale_confirmed' actions_log entry (server/src/routes/billing.js's
// Paddle webhook) into a plain Hebrew sentence - the same gap
// autonomousScanSummary() already closed for 'autonomous_scan'. The raw result
// strings here ('skipped: sandbox transaction, not recorded as real revenue'
// for every test purchase made while PADDLE_ENV=sandbox — the README's own
// documented default while testing Paddle — and 'blocked: <a raw English
// error message from engine/paddleTransaction.js>' for a malformed payload)
// would otherwise fall through resultLabel()'s known partial-translation
// limitation and show English mid-sentence in the activity log.
export function saleConfirmedSummary(action) {
  const { result } = action;
  if (result === 'success') return 'מכירה אומתה בפועל.';
  if (typeof result === 'string' && result.startsWith('skipped: sandbox transaction')) {
    return 'עסקת בדיקה (sandbox) — לא נרשמה כהכנסה אמיתית.';
  }
  if (typeof result === 'string' && result.startsWith('blocked:')) {
    return 'התשלום לא נרשם בגלל שגיאה בעיבוד הנתונים מ-Paddle — בדוק את לוגי השרת.';
  }
  return resultLabel(result);
}

// Financial.jsx's "רענן הכל" refreshes every watchlist symbol one at a
// time, each in its own try/catch - without this, calling setError()
// directly inside that loop on every failure meant a second or third
// failing symbol silently overwrote the first's message, so only the LAST
// of possibly several real failures in the same run ever reached the
// owner, as if the others had succeeded. Returns null when there's
// nothing to report, so the caller can skip setError() entirely.
export function refreshAllFailuresSummary(failures) {
  if (failures.length === 0) return null;
  if (failures.length === 1) return `${failures[0].symbol}: ${failures[0].message}`;
  return `${failures.length} סימבולים לא התרעננו: ${failures.map((f) => f.symbol).join(', ')}`;
}

// Sources.jsx's own syncSources() call stamps lastCheckedAt on every
// source together, on every load AND on "בדוק שוב" - this finds the most
// recent one across the whole list (rather than assuming they're all
// identical, which they are in practice but this makes no such
// assumption) so the page can show ONE "נבדק לאחרונה" line that actually
// moves when the owner clicks the button, instead of giving no lasting
// confirmation anything happened.
export function latestSourceCheckTimestamp(sources) {
  return sources.reduce((latest, s) => (
    !latest || new Date(s.lastCheckedAt) > new Date(latest) ? s.lastCheckedAt : latest
  ), null);
}

// Dashboard.jsx's own "an approval has already done its job once its
// opportunity is published" filter never excluded a demo draft (no
// ANTHROPIC_API_KEY when it was drafted) - routes/approvals.js now
// refuses to even create one going forward (it can never actually be
// published - services/publishing.js always refuses that), but a stale
// approval created before that server-side fix existed would otherwise
// still inflate this count and could occupy one of the dashboard's own
// 3 preview slots, same reasoning as every other "what should I look at"
// surface in this app (digest.js, autonomousScan, Opportunities.jsx's own
// active list) already excluding demo drafts for the same reason.
export function pendingPublishApprovals(approvals, opportunities) {
  return approvals.filter((a) => {
    const opp = opportunities.find((o) => o.id === a.opportunityId);
    return opp?.status === 'draft' && !opp.productDraft?.demo;
  });
}

export function missingFieldLabel(field) {
  if (MISSING_FIELD_LABEL[field]) return MISSING_FIELD_LABEL[field];
  if (field.startsWith('cost:')) {
    const costKey = field.slice('cost:'.length);
    // A cost field this mapping doesn't know about yet (future addition)
    // still shows its real key rather than a fabricated Hebrew phrase —
    // honest and ungraceful beats a wrong-sounding translation.
    return `${MISSING_COST_LABEL[costKey] ?? costKey} — לא ידוע עדיין`;
  }
  return field;
}
